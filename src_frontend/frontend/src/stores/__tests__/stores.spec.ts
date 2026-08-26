import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const axiosGet = vi.hoisted(() => vi.fn());

vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("axios", () => ({ default: { get: axiosGet } }));

import { useApplicationInitStore } from "@/stores/appInits";
import { useAuthStore } from "@/stores/auth";
import { useImageStore } from "@/stores/images";
import { useLayersStore } from "@/stores/layers";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useMarkerIconStore } from "@/stores/markerIcons";
import { useShapeStore } from "@/stores/shapes";

const marker = (id: string) => ({
  id,
  layer_id: "layer-1",
  marker_name: `marker-${id}`,
  latitude: 35,
  longitude: 139,
  detail: "detail",
  update_at: "2026-01-01T00:00:00.000Z",
});

const shape = (id: string) => ({
  id,
  layer_id: "layer-1",
  name: `shape-${id}`,
  geojson: { type: "Feature", geometry: { type: "Point", coordinates: [139, 35] }, properties: {} },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("認証・アプリケーション初期化ストア", () => {
  it("現在のユーザーをログアウト状態にする", () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(true);
    store.logout();
    expect(store.isAuthenticated).toBe(false);
  });

  it("アプリケーション初期化状態をクリアする", () => {
    const store = useApplicationInitStore();
    store.appInitData = {
      appTitle: "temporary",
      allowUserAccountCreate: true,
      allowUserUpdatePassword: true,
      allowOrigins: "*",
    };
    store.clear();
    expect(store.appInitData).toEqual({
      appTitle: "",
      allowUserAccountCreate: false,
      allowUserUpdatePassword: false,
      allowOrigins: "",
    });
  });

  it("アプリケーション初期化APIの項目を状態へ変換する", async () => {
    axiosGet.mockResolvedValue({
      data: {
        app_title: "GeoCode",
        allow_user_account_create: true,
        allow_user_update_password: false,
        allow_origins: "https://example.com",
      },
    });
    const store = useApplicationInitStore();
    await store.init();
    expect(store.appInitData).toEqual({
      appTitle: "GeoCode",
      allowUserAccountCreate: true,
      allowUserUpdatePassword: false,
      allowOrigins: "https://example.com",
    });
  });
});

describe("地図オブジェクトストア", () => {
  it("APIデータを変換してフィルターをリセットしID降順に並べる", async () => {
    api.get.mockResolvedValue({ data: { a: marker("a"), b: marker("b") } });
    const store = useMapObjectStore();
    store.filteredShapeIds = ["old-shape"];
    await store.initList();
    expect([...store.mapObjectList.keys()]).toEqual(["b", "a"]);
    expect(store.filteredShapeIds).toBeNull();
    expect(store.getById("a").marker_name).toBe("marker-a");
  });

  it("API成功後に既存オブジェクトをローカルで更新する", async () => {
    api.put.mockResolvedValue({ data: {} });
    const store = useMapObjectStore();
    store.addMapObject(marker("a"));
    const updated = await store.updateMapObject("a", "renamed", "new detail", "layer-2");
    expect(api.put).toHaveBeenCalledWith(expect.stringContaining("a"), {
      name: "renamed",
      detail: "new detail",
      layer_id: "layer-2",
    });
    expect(updated).toMatchObject({
      id: "a",
      marker_name: "renamed",
      detail: "new detail",
      layer_id: "layer-2",
    });
  });

  it("マーカーと図形の検索結果を保存する", async () => {
    api.get.mockResolvedValue({
      data: { markers: { a: marker("a") }, shape_ids: ["shape-2", "shape-1"] },
    });
    const store = useMapObjectStore();
    await store.queryWordMapObject("tokyo", "station", "layer-1");
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("query1=tokyo"));
    expect(store.filteredShapeIds).toEqual(["shape-2", "shape-1"]);
    expect([...store.mapObjectList.keys()]).toEqual(["a"]);
  });
});

describe("画像ストア", () => {
  it("画像を正規化してID降順に並べる", () => {
    const store = useImageStore();
    store.setImageList({
      first: { id: "1", filename: "one.png", uuid_filename: "uuid-1.png" },
      second: { id: "2", filename: "two.png", uuid_filename: "uuid-2.png" },
    });
    expect([...store.imageList.keys()]).toEqual(["2", "1"]);
    expect(store.getById("1").filename).toBe("one.png");
  });

  it("空の検索語では初期一覧を取得しそれ以外では検索条件を送信する", async () => {
    api.get.mockResolvedValue({ data: {} });
    const store = useImageStore();
    await store.queryImage("");
    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/\/50$/));
    await store.queryImage("map");
    expect(api.get).toHaveBeenLastCalledWith(expect.any(String), {
      params: { query: "map", limit: 50 },
    });
  });
});

describe("図形ストア", () => {
  it("絞り込み条件付きで図形を取得し逆順で保存する", async () => {
    api.get.mockResolvedValue({ data: [shape("1"), shape("2")] });
    const store = useShapeStore();
    expect(await store.queryShapes("layer-1", false)).toBe(true);
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining("is_master=false&layer_id=layer-1"),
    );
    expect([...store.shapeList.keys()]).toEqual(["2", "1"]);
  });

  it("既存図形を更新して空白の名前を正規化する", async () => {
    api.put.mockResolvedValue({ data: {} });
    const store = useShapeStore();
    store.shapeList.set("1", shape("1") as never);
    const geojson = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [140, 36] },
      properties: {},
    };
    const updated = await store.updateShape("1", "   ", "layer-2", geojson as never);
    expect(updated).toMatchObject({ id: "1", name: null, layer_id: "layer-2", geojson });
  });
});

describe("レイヤー・マーカーアイコンストア", () => {
  it("レイヤーを変換してID昇順に並べる", async () => {
    api.get.mockResolvedValue({
      data: {
        b: {
          id: "b",
          user_id: "user",
          layer_name: "Beta",
          is_master: false,
          marker_icon_id: null,
          marker_icon_filename: null,
        },
        a: {
          id: "a",
          user_id: "user",
          layer_name: "Alpha",
          is_master: true,
          marker_icon_id: "icon",
          marker_icon_filename: "icon.png",
        },
      },
    });
    const store = useLayersStore();
    await store.initList();
    expect([...store.layersList.keys()]).toEqual(["a", "b"]);
    expect(store.getById("a").name).toBe("Alpha");
  });

  it("レイヤーを削除して関連データを再取得する", async () => {
    api.delete.mockResolvedValue({ data: {} });
    const layers = useLayersStore();
    const mapObjects = useMapObjectStore();
    layers.layersList.set("a", { id: "a", name: "Alpha" } as never);
    const layersReload = vi.spyOn(layers, "initList").mockResolvedValue();
    const markersReload = vi.spyOn(mapObjects, "initList").mockResolvedValue();
    await layers.deleteLayer("a");
    expect(layers.layersList.has("a")).toBe(false);
    expect(layersReload).toHaveBeenCalledOnce();
    expect(markersReload).toHaveBeenCalledOnce();
  });

  it("マーカーアイコンの取得・アップロード・削除を行う", async () => {
    const store = useMarkerIconStore();
    api.get.mockResolvedValue({ data: [{ id: "icon-1", filename: "one.png" }] });
    await store.load("one");
    expect(api.get).toHaveBeenCalledWith(expect.any(String), { params: { query: "one" } });
    expect(store.icons).toHaveLength(1);
    const uploaded = { id: "icon-2", filename: "two.png" };
    api.post.mockResolvedValue({ data: uploaded });
    api.get.mockResolvedValue({ data: [uploaded] });
    const file = new File(["image"], "two.png", { type: "image/png" });
    expect(await store.upload(file)).toEqual(uploaded);
    expect(api.post.mock.calls[0][1]).toBeInstanceOf(FormData);
    await store.remove("icon-2");
    expect(api.delete).toHaveBeenCalledWith(expect.stringContaining("icon-2"));
  });
});
