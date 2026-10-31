import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapObjectData, ShapeData } from "@/interface";
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("@/setting", () => ({ baseUrl: "https://backend.example", assetsUrl: "" }));
import {
  useMapObjectWriter,
  type MapObjectWriteRequest,
  type MapObjectWriteResult,
} from "../useMapObjectWriter";
import { useAuthStore } from "@/stores/auth";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const marker = (id = "marker-a", updated = "2026-10-27T00:00:00"): MapObjectData => ({
  id,
  layer_id: "layer-a",
  marker_name: "Pipe",
  detail: "saved body",
  latitude: 35,
  longitude: 139,
  update_at: updated,
});
const shape = (id = "shape-a", updated = "2026-10-27T00:00:00"): ShapeData => ({
  id,
  user_id: "account-a",
  layer_id: "layer-a",
  shape_type: "polyline",
  name: "Pipe",
  created_at: "2026-10-26T00:00:00",
  updated_at: updated,
  geojson: {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [139, 35],
        [140, 36],
      ],
    },
  },
});
const request = (overrides: Partial<MapObjectWriteRequest> = {}): MapObjectWriteRequest => ({
  url: "/shape",
  method: "POST",
  body: { layer_id: "layer-a" },
  requestId: "write-a",
  ...overrides,
});
beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().setAccount("account-a");
});

describe("parent-owned map object writes", () => {
  it("keeps a committed creation in the canonical cache after its frame disappears", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    const write = useMapObjectWriter(),
      receive = vi.fn();
    let frameAlive = true;
    const done = write(request(), (result) => {
      if (frameAlive) receive(result);
    });
    frameAlive = false;
    pending.resolve({
      status: 200,
      data: { id: "shape-a", message: "Shape Created.", object: shape() },
    });
    await done;
    expect(receive).not.toHaveBeenCalled();
    expect(useShapeStore().getById("shape-a")).toEqual(shape());
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it("isolates a disappearing reply callback from the successful cache update", async () => {
    api.request.mockResolvedValue({ status: 200, data: { object: marker() } });
    await expect(
      useMapObjectWriter()(
        request({ url: "/marker?layer_id=layer-a&latitude=35&longitude=139" }),
        () => {
          throw Error("frame disposed");
        },
      ),
    ).resolves.toBeUndefined();
    expect(useMapObjectStore().getById("marker-a")).toEqual(marker());
  });
  it("shares an in-flight request and its settled result across writer instances", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    const first = vi.fn(),
      second = vi.fn(),
      third = vi.fn();
    const one = useMapObjectWriter()(request(), first);
    const two = useMapObjectWriter()(request(), second);
    await Promise.resolve();
    expect(api.request).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 200, data: { id: "shape-a", object: shape() } });
    await Promise.all([one, two]);
    await useMapObjectWriter()(request(), third);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]![0]).toEqual(second.mock.calls[0]![0]);
    expect(third.mock.calls[0]![0].change.mutationId).toBe("write-a");
  });
  it("rejects a reused request ID with a different operation", async () => {
    api.request.mockResolvedValue({ status: 200, data: { object: shape() } });
    const write = useMapObjectWriter(),
      reply = vi.fn();
    await write(request());
    await write(request({ method: "DELETE", url: "/shape/shape-a" }), reply);
    expect(reply.mock.calls[0]![0].status).toBe(409);
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["POST", "https://other.example/shape"],
    ["GET", "/shapes"],
    ["POST", "/account/token"],
    ["DELETE", "/admin/users/account-a"],
    ["PUT", "/shape/shape-a/form/body"],
    ["POST", "https://user:pass@backend.example/shape"],
    ["POST", "/shape?redirect=/admin"],
  ])("rejects forbidden %s %s", async (method, url) => {
    const reply = vi.fn();
    await useMapObjectWriter()(request({ method, url }), reply);
    expect(reply.mock.calls[0]![0].status).toBe(403);
    expect(api.request).not.toHaveBeenCalled();
  });
  it("does not publish a response after an account switch", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    const reply = vi.fn(),
      done = useMapObjectWriter()(request(), reply);
    useAuthStore().setAccount("account-b");
    pending.resolve({ status: 200, data: { object: shape() } });
    await done;
    expect(useShapeStore().recordCache.records.size).toBe(0);
    expect(reply.mock.calls[0]![0].status).toBe(409);
  });
  it("does not publish a response across logout and relogin to the same account", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    const done = useMapObjectWriter()(request());
    const auth = useAuthStore();
    auth.logout();
    auth.login();
    auth.setAccount("account-a");
    pending.resolve({ status: 200, data: { object: shape() } });
    await done;
    expect(useShapeStore().recordCache.records.size).toBe(0);
  });
  it("applies marker metadata and its previous layer from the saved response", async () => {
    useMapObjectStore().upsertRecord(marker());
    const moved = {
      ...marker(),
      layer_id: "layer-b",
      detail: "server reconstructed body",
      update_at: "2026-10-27T00:01:00",
    };
    api.request.mockResolvedValue({ status: 200, data: { message: "Update Ok.", object: moved } });
    const reply = vi.fn();
    await useMapObjectWriter()(
      request({ url: "/marker/update/marker-a", method: "PUT", body: { detail: "client body" } }),
      reply,
    );
    expect(useMapObjectStore().getById("marker-a")).toEqual(moved);
    expect(reply.mock.calls[0]![0].change).toMatchObject({
      object: moved,
      previousLayerId: "layer-a",
      operation: "upsert",
    });
  });
  it("applies marker position, shape metadata and the bare geometry response", async () => {
    const write = useMapObjectWriter();
    const moved = { ...marker(), latitude: 36 };
    api.request.mockResolvedValueOnce({ status: 200, data: { object: moved } });
    await write(
      request({
        url: "/marker/update-marker-latlng?marker_id=marker-a&latitude=36&longitude=139",
        method: "PUT",
      }),
    );
    expect(useMapObjectStore().getById("marker-a")?.latitude).toBe(36);
    api.request.mockResolvedValueOnce({ status: 200, data: { object: shape() } });
    await write(request({ url: "/shape/shape-a", method: "PUT", requestId: "metadata" }));
    const geometry = { ...shape(), updated_at: "2026-10-27T00:02:00", name: "latest shape" };
    api.request.mockResolvedValueOnce({ status: 200, data: geometry });
    const reply = vi.fn();
    await write(
      request({ url: "/shape/shape-a/geometry", method: "PUT", requestId: "geometry" }),
      reply,
    );
    expect(useShapeStore().getById("shape-a")).toEqual(geometry);
    expect(reply.mock.calls[0]![0].data).toEqual(geometry);
  });
  it("removes marker and shape IDs without GET requests", async () => {
    const write = useMapObjectWriter();
    useMapObjectStore().upsertRecord(marker());
    useShapeStore().upsertRecord(shape());
    api.request.mockResolvedValue({ status: 200, data: { message: "Deleted." } });
    const markerReply = vi.fn(),
      shapeReply = vi.fn();
    await write(
      request({ url: "/marker/delete/marker-a", method: "DELETE", requestId: "delete-marker" }),
      markerReply,
    );
    await write(
      request({ url: "/shape/shape-a", method: "DELETE", requestId: "delete-shape" }),
      shapeReply,
    );
    expect(useMapObjectStore().getById("marker-a")).toBeUndefined();
    expect(useShapeStore().getById("shape-a")).toBeUndefined();
    expect(shapeReply.mock.calls[0]![0].change).toMatchObject({
      operation: "delete",
      id: "shape-a",
      objectType: "shape",
    });
    expect(api.request.mock.calls.every(([config]) => config.method === "DELETE")).toBe(true);
  });
  it("returns the newer canonical object to the frame when an older PUT response arrives", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    useShapeStore().upsertRecord(shape());
    const reply = vi.fn(),
      done = useMapObjectWriter()(
        request({ url: "/shape/shape-a/geometry", method: "PUT" }),
        reply,
      );
    const latest = shape("shape-a", "2026-10-27T00:01:00");
    useShapeStore().upsertRecord(latest);
    pending.resolve({ status: 200, data: shape() });
    await done;
    expect(reply.mock.calls[0]![0].data).toEqual(latest);
    expect(reply.mock.calls[0]![0].change.object).toEqual(latest);
  });
  it("does not resurrect an object when its PUT response follows a successful deletion", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    useShapeStore().upsertRecord(shape());
    const reply = vi.fn(),
      done = useMapObjectWriter()(request({ url: "/shape/shape-a", method: "PUT" }), reply);
    useShapeStore().removeRecord("shape-a");
    pending.resolve({ status: 200, data: { object: shape() } });
    await done;
    expect(useShapeStore().getById("shape-a")).toBeUndefined();
    expect(reply.mock.calls[0]![0].status).toBe(409);
    expect(reply.mock.calls[0]![0].change).toBeUndefined();
  });
  it("preserves HTTP failures and never retries an ambiguous network failure", async () => {
    const write = useMapObjectWriter(),
      first = vi.fn(),
      second = vi.fn();
    api.request.mockRejectedValueOnce({
      response: { status: 403, data: { message: "Restricted" } },
    });
    await write(request(), first);
    expect(first.mock.calls[0]![0]).toEqual({ status: 403, data: { message: "Restricted" } });
    api.request.mockRejectedValueOnce(Error("lost response"));
    const failed = request({ requestId: "network" });
    await write(failed, second);
    await write(failed, second);
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(second.mock.calls.map(([result]) => result.status)).toEqual([502, 502]);
  });
  it("resolves a settled duplicate against the latest canonical state", async () => {
    api.request.mockResolvedValue({ status: 200, data: { object: shape() } });
    const write = useMapObjectWriter();
    await write(request());
    const latest = shape("shape-a", "2026-10-27T00:01:00");
    useShapeStore().upsertRecord(latest);
    const updated = vi.fn();
    await write(request(), updated);
    expect(updated.mock.calls[0]![0].data.object).toEqual(latest);
    useShapeStore().removeRecord("shape-a");
    const deleted = vi.fn();
    await write(request(), deleted);
    expect(deleted.mock.calls[0]![0].status).toBe(409);
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it("rejects an object already tombstoned before the PUT began", async () => {
    useShapeStore().upsertRecord(shape());
    useShapeStore().removeRecord("shape-a");
    api.request.mockResolvedValue({ status: 200, data: { object: shape() } });
    const reply = vi.fn();
    await useMapObjectWriter()(request({ url: "/shape/shape-a", method: "PUT" }), reply);
    expect(reply.mock.calls[0]![0].status).toBe(409);
    expect(useShapeStore().getById("shape-a")).toBeUndefined();
  });
  it("bounds the pending deduplication cache and accepts later writes after completion", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    const write = useMapObjectWriter();
    const writes = Array.from({ length: 256 }, (_, index) =>
      write(request({ requestId: "pending-" + index })),
    );
    await Promise.resolve();
    const denied = vi.fn();
    await write(request({ requestId: "overflow" }), denied);
    expect(denied.mock.calls[0]![0].status).toBe(429);
    expect(api.request).toHaveBeenCalledTimes(256);
    pending.resolve({ status: 200, data: { object: shape() } });
    await Promise.all(writes);
    await write(request({ requestId: "after-complete" }));
    expect(api.request).toHaveBeenCalledTimes(257);
  });
});

describe("保存要求の検証と確定済み保存の保護", () => {
  it.each([
    null,
    { requestId: "" },
    { requestId: "x".repeat(257) },
    { method: null },
    { url: null },
  ])("不正な要求を送信前に拒否する: %j", async (invalid) => {
    const reply = vi.fn();
    await useMapObjectWriter()(invalid === null ? (null as any) : request(invalid as any), reply);
    expect(reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 400 }));
    expect(api.request).not.toHaveBeenCalled();
    expect(useShapeStore().recordCache.records.size).toBe(0);
  });
  it("ログアウト中は有効な要求でも送信しない", async () => {
    useAuthStore().logout();
    const reply = vi.fn();
    await useMapObjectWriter()(request(), reply);
    expect(reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
    expect(api.request).not.toHaveBeenCalled();
  });
  it("循環参照を含む本文を拒否しても、同じ要求IDで修正して送信できる", async () => {
    const body: any = {};
    body.self = body;
    const write = useMapObjectWriter(),
      reply = vi.fn();
    await write(request({ body }), reply);
    expect(reply.mock.lastCall![0].status).toBe(400);
    expect(api.request).not.toHaveBeenCalled();
    api.request.mockResolvedValue({ status: 201, data: { object: shape() } });
    await write(request(), reply);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(reply.mock.lastCall![0].status).toBe(201);
    expect(useShapeStore().getById("shape-a")).toEqual(shape());
  });
  it.each([401, 409, 503])(
    "HTTP失敗が応答として返ってもデータを更新せず、そのまま返す: %s",
    async (status) => {
      const store = useShapeStore();
      store.upsertRecord(shape());
      const data = { message: "rejected", object: { ...shape(), name: "保存されていない変更" } };
      api.request.mockResolvedValue({ status, data });
      const reply = vi.fn();
      await useMapObjectWriter()(request({ method: "PUT", url: "/shape/shape-a" }), reply);
      expect(reply).toHaveBeenCalledExactlyOnceWith({ status, data });
      expect(store.getById("shape-a")).toEqual(shape());
      expect(api.request).toHaveBeenCalledTimes(1);
    },
  );
  it("削除済みマーカーを作成応答で復活させず、409として返す", async () => {
    const store = useMapObjectStore();
    store.upsertRecord(marker());
    store.removeRecord("marker-a");
    api.request.mockResolvedValue({ status: 201, data: { object: marker() } });
    const reply = vi.fn();
    await useMapObjectWriter()(request({ url: "/marker" }), reply);
    expect(reply.mock.lastCall![0].status).toBe(409);
    expect(store.getById("marker-a")).toBeUndefined();
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it("保存後の一覧更新が例外でも、確定した保存結果を失敗に変えず再送しない", async () => {
    const error = new Error("render failed");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(useMapObjectStore(), "refreshSearchResults").mockImplementation(() => {
      throw error;
    });
    api.request.mockResolvedValue({ status: 201, data: { object: shape() } });
    const reply = vi.fn(),
      write = useMapObjectWriter();
    await write(request(), reply);
    await write(request(), reply);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls.map(([r]) => r.status)).toEqual([201, 201]);
    expect(useShapeStore().getById("shape-a")).toEqual(shape());
    expect(console.error).toHaveBeenCalledWith(
      "Saved map object could not be synchronized:",
      error,
    );
  });
});
