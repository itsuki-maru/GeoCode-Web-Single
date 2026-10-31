import apiClient from "@/axiosClient";
import { baseUrl } from "@/setting";
import type { MapObjectData, ShapeData } from "@/interface";
import { useAuthStore } from "@/stores/auth";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";

export interface MapObjectWriteRequest {
  url: string;
  method: string;
  body?: unknown;
  requestId: string;
}
export interface MapObjectWriteChange {
  operation: "upsert" | "delete";
  objectType: "marker" | "shape";
  object?: MapObjectData | ShapeData;
  id?: string;
  previousLayerId?: string | null;
  mutationId: string;
}
export interface MapObjectWriteResult {
  status: number;
  data: unknown;
  change?: MapObjectWriteChange;
}
interface Target {
  url: string;
  method: "POST" | "PUT" | "DELETE";
  kind: "marker" | "shape";
  id?: string;
  geometry?: boolean;
}
interface Entry {
  fingerprint: string;
  promise: Promise<MapObjectWriteResult>;
  settled: boolean;
}
interface Session {
  key: string;
  entries: Map<string, Entry>;
}
const sessions = new WeakMap<ReturnType<typeof useAuthStore>, Session>();
const MAX_REQUESTS = 256;
const failure = (status: number, message: string): MapObjectWriteResult => ({
  status,
  data: { message },
});

function targetFor(request: MapObjectWriteRequest): Target | null {
  try {
    const backend = new URL(baseUrl || window.location.origin, window.location.origin);
    const url = new URL(request.url, backend.origin);
    if (url.origin !== backend.origin || url.username || url.password || url.hash) return null;
    const method = request.method.toUpperCase();
    const prefix = backend.pathname.replace(/\/$/, "");
    const path =
      prefix && url.pathname.startsWith(prefix + "/")
        ? url.pathname.slice(prefix.length)
        : url.pathname;
    const queryKeys = [...url.searchParams.keys()];
    const queryAllowed = (keys: string[]) =>
      queryKeys.every((key) => keys.includes(key)) && new Set(queryKeys).size === queryKeys.length;
    let target: Omit<Target, "url"> | null = null;
    if (
      method === "POST" &&
      path === "/marker" &&
      queryAllowed(["layer_id", "latitude", "longitude"])
    ) {
      target = { method, kind: "marker" };
    } else if (method === "POST" && path === "/shape" && !queryKeys.length) {
      target = { method, kind: "shape" };
    } else if (
      method === "PUT" &&
      path === "/marker/update-marker-latlng" &&
      queryAllowed(["marker_id", "latitude", "longitude"])
    ) {
      const id = url.searchParams.get("marker_id");
      if (id && /^[a-zA-Z0-9_-]+$/.test(id)) target = { method, kind: "marker", id };
    } else {
      const marker = path.match(/^\/marker\/(update|delete)\/([a-zA-Z0-9_-]+)$/);
      const shape = path.match(/^\/shape\/([a-zA-Z0-9_-]+)(\/geometry)?$/);
      if (
        !queryKeys.length &&
        marker &&
        ((method === "PUT" && marker[1] === "update") ||
          (method === "DELETE" && marker[1] === "delete"))
      ) {
        target = { method, kind: "marker", id: marker[2] };
      } else if (
        !queryKeys.length &&
        shape &&
        (method === "PUT" || (method === "DELETE" && !shape[2]))
      ) {
        target = { method, kind: "shape", id: shape[1], geometry: Boolean(shape[2]) };
      }
    }
    if (!target) return null;
    return { ...target, url: new URL(prefix + path + url.search, backend.origin).href };
  } catch {
    return null;
  }
}
function markerRecord(value: unknown): value is MapObjectData {
  const record = value as MapObjectData | null;
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.layer_id === "string" &&
      typeof record.marker_name === "string" &&
      typeof record.detail === "string" &&
      typeof record.latitude === "number" &&
      Number.isFinite(record.latitude) &&
      typeof record.longitude === "number" &&
      Number.isFinite(record.longitude) &&
      typeof record.update_at === "string",
  );
}
function shapeRecord(value: unknown): value is ShapeData {
  const record = value as ShapeData | null;
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.layer_id === "string" &&
      typeof record.user_id === "string" &&
      typeof record.shape_type === "string" &&
      record.geojson &&
      typeof record.created_at === "string" &&
      typeof record.updated_at === "string",
  );
}

// 書き込み元の iframe が置き換わっても、書き込み処理はアプリが管理する。
export function useMapObjectWriter() {
  const auth = useAuthStore(),
    markers = useMapObjectStore(),
    shapes = useShapeStore();
  return async function writeMapObject(
    request: MapObjectWriteRequest,
    reply: (result: MapObjectWriteResult) => void = () => {},
  ): Promise<void> {
    let revalidate = (result: MapObjectWriteResult): MapObjectWriteResult => result;
    const respond = (result: MapObjectWriteResult) => {
      // フレームの消失を理由に、確定済みの書き込みを失敗したリクエストとして扱わない。
      try {
        reply(revalidate(result));
      } catch {
        /* 正規キャッシュはすでに更新済みである。 */
      }
    };
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId ||
      request.requestId.length > 256 ||
      typeof request.url !== "string" ||
      typeof request.method !== "string"
    ) {
      respond(failure(400, "保存要求を確認できませんでした。"));
      return;
    }
    const target = targetFor(request);
    if (!target) {
      respond(failure(403, "許可されていない地図オブジェクトの保存要求です。"));
      return;
    }
    if (!auth.isAuthenticated || !auth.accountId) {
      respond(failure(401, "再ログインしてください。"));
      return;
    }
    const account = auth.accountId,
      markerGeneration = markers.recordCache.generation,
      shapeGeneration = shapes.recordCache.generation;
    const current = () =>
      auth.isAuthenticated &&
      auth.accountId === account &&
      markers.recordCache.generation === markerGeneration &&
      shapes.recordCache.generation === shapeGeneration;
    revalidate = (result) => {
      if (!current())
        return failure(409, "ログイン状態が変更されたため、表示への反映を中止しました。");
      if (result.change?.operation !== "upsert" || !result.change.object) return result;
      const canonical =
        target.kind === "marker"
          ? markers.recordCache.records.get(result.change.object.id)
          : shapes.recordCache.records.get(result.change.object.id);
      if (!canonical) return failure(409, "この地図オブジェクトの表示状態が変更されています。");
      const data = typeof result.data === "object" && result.data !== null ? result.data : {};
      return {
        ...result,
        data: target.geometry ? canonical : { ...data, object: canonical },
        change: { ...result.change, object: canonical },
      };
    };
    const sessionKey = account + ":" + markerGeneration + ":" + shapeGeneration;
    let session = sessions.get(auth);
    if (!session || session.key !== sessionKey) {
      session = { key: sessionKey, entries: new Map() };
      sessions.set(auth, session);
    }
    let fingerprint: string;
    try {
      fingerprint = JSON.stringify([target.method, target.url, request.body]);
    } catch {
      respond(failure(400, "保存するデータを確認できませんでした。"));
      return;
    }
    const existing = session.entries.get(request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        respond(failure(409, "保存要求の識別子が重複しています。"));
        return;
      }
      // 通知が重複しても、HTTP リクエストとキャッシュへの反映はそれぞれ一度に保つ。
      session.entries.delete(request.requestId);
      session.entries.set(request.requestId, existing);
      respond(await existing.promise);
      return;
    }
    for (const [id, entry] of session.entries) {
      if (session.entries.size < MAX_REQUESTS) break;
      if (entry.settled) session.entries.delete(id);
    }
    if (session.entries.size >= MAX_REQUESTS) {
      respond(failure(429, "保存処理が混み合っています。しばらく待って再試行してください。"));
      return;
    }
    const previousLayerId = target.id
      ? target.kind === "marker"
        ? markers.getById(target.id)?.layer_id
        : shapes.getById(target.id)?.layer_id
      : undefined;
    const initialMutationVersion = target.id
      ? ((target.kind === "marker"
          ? markers.mutationVersions.get(target.id)
          : shapes.mutationVersions.get(target.id)) ?? 0)
      : 0;
    const execute = async (): Promise<MapObjectWriteResult> => {
      let response;
      try {
        response = await apiClient.request({
          url: target.url,
          method: target.method,
          data: request.body,
        });
      } catch (error) {
        const failed = error as { response?: { status?: number; data?: unknown } };
        const status = failed.response?.status;
        return status && status >= 400 && status <= 599
          ? { status, data: failed.response?.data }
          : failure(502, "保存結果を受信できませんでした。保存要求は自動再送しません。");
      }
      if (!current())
        return failure(409, "ログイン状態が変更されたため、表示への反映を中止しました。");
      const result: MapObjectWriteResult = { status: response.status, data: response.data };
      if (response.status < 200 || response.status >= 300) return result;
      try {
        if (target.id && target.method !== "DELETE") {
          const store = target.kind === "marker" ? markers : shapes;
          if (
            (store.mutationVersions.get(target.id) ?? 0) > initialMutationVersion &&
            !store.recordCache.records.has(target.id)
          )
            return failure(409, "この地図オブジェクトは削除されています。");
        }
        if (target.method === "DELETE" && target.id) {
          if (target.kind === "marker") markers.removeRecord(target.id);
          else shapes.removeRecord(target.id);
          result.change = {
            operation: "delete",
            objectType: target.kind,
            id: target.id,
            previousLayerId,
            mutationId: request.requestId,
          };
        } else {
          const data = response.data as { object?: unknown } | null;
          const saved = target.geometry ? response.data : data?.object;
          if (
            target.kind === "marker" &&
            markerRecord(saved) &&
            (!target.id || saved.id === target.id)
          ) {
            markers.upsertRecord(saved);
            const canonical = markers.recordCache.records.get(saved.id);
            if (canonical) {
              result.data = { ...data, object: canonical };
              result.change = {
                operation: "upsert",
                objectType: "marker",
                object: canonical,
                previousLayerId,
                mutationId: request.requestId,
              };
            } else return failure(409, "この地図オブジェクトの表示状態が変更されています。");
          } else if (
            target.kind === "shape" &&
            shapeRecord(saved) &&
            saved.user_id === account &&
            (!target.id || saved.id === target.id)
          ) {
            shapes.upsertRecord(saved);
            const canonical = shapes.recordCache.records.get(saved.id);
            if (canonical) {
              result.data = target.geometry ? canonical : { ...data, object: canonical };
              result.change = {
                operation: "upsert",
                objectType: "shape",
                object: canonical,
                previousLayerId,
                mutationId: request.requestId,
              };
            } else return failure(409, "この地図オブジェクトの表示状態が変更されています。");
          }
        }
        markers.refreshSearchResults();
      } catch (error) {
        // 実際に成功した HTTP 結果を保持し、子側で表示の同期を回復できるようにする。
        console.error("Saved map object could not be synchronized:", error);
      }
      return result;
    };
    const entry: Entry = { fingerprint, settled: false, promise: Promise.resolve().then(execute) };
    entry.promise = entry.promise.finally(() => {
      entry.settled = true;
    });
    session.entries.set(request.requestId, entry);
    respond(await entry.promise);
  };
}
