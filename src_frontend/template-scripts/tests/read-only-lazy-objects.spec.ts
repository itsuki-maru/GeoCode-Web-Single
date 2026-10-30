import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import { initializeReadOnlyMapPage } from "../src/map/read-only-page";
import { finishAnswerPreview } from "../src/map/answer-preview";
import type { AnotherMapBootstrap } from "../src/map/types";
import { createPrintPreview } from "../src/map/print/print-preview";
import { createAnswerPrintSnapshot } from "../src/map/print/answer-print-state";
import { installAnswerFilter } from "../src/map/answer-filter";
import { readMapBootstrap } from "../src/map/bootstrap";

// アプリケーションと同じ Leaflet を使用し、jsdom に必要な SVG 機能を補う。
Object.assign(SVGSVGElement.prototype, { createSVGRect: () => ({}) });
const require = createRequire(import.meta.url);
const leaflet = require("leaflet");
let runtime: ReturnType<typeof initializeReadOnlyMapPage> | undefined;
let preview: ReturnType<typeof createPrintPreview> | undefined;
const flush = () => new Promise<void>((done) => setTimeout(done, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const marker = (id: string) => ({
  id: `m-${id}`,
  layer_id: id,
  marker_name: `marker ${id}`,
  latitude: 35.68,
  longitude: 139.76,
  detail: "",
  update_at: "",
});
const shape = (id: string) => ({
  id: `s-${id}`,
  layer_id: id,
  shape_type: "circle",
  name: `shape ${id}`,
  user_id: "user",
  geojson: {
    type: "Feature",
    properties: { radius: 100 },
    geometry: { type: "Point", coordinates: [139.76, 35.68] },
  },
});
let fetchData: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.stubGlobal("L", leaflet);
  require("leaflet.markercluster");
  localStorage.clear();
  document.body.innerHTML = '<div id="map"></div>';
  const element = document.getElementById("map")!;
  Object.defineProperties(element, {
    clientWidth: { value: 800 },
    offsetWidth: { value: 800 },
    clientHeight: { value: 600 },
    offsetHeight: { value: 600 },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.assign(window, {
    L: leaflet,
    marked: new Marked(),
    filterXSS: (value: string) => value,
  });
  window.__GEOCODE_MAP_BOOTSTRAP__ = {
    page: "map-anather",
    isCluster: false,
    tileServers: {
      "1": {
        id: 1,
        layer_name: "base",
        label: "base",
        url: "https://example.test/{z}/{x}/{y}.png",
        attribution: "test",
        include_foreign_tiles: true,
      },
    },
    tileOverlays: [],
    initialView: { latitude: 35.68, longitude: 139.76, zoom: 14 },
    layers: Object.fromEntries(
      ["a", "b", "empty"].map((id) => [
        id,
        { id, layer_name: `group ${id}`, user_id: "user", is_master: false },
      ]),
    ),
    markers: {},
    shapes: [],
  };
  fetchData = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    const id = parsed.searchParams.get("layer") ?? parsed.searchParams.get("layer_id");
    return new Response(
      JSON.stringify(parsed.pathname === "/shapes" ? [shape(id!)] : { [`m-${id}`]: marker(id!) }),
    );
  });
  vi.stubGlobal("fetch", fetchData);
});
afterEach(() => {
  preview?.dispose();
  preview = undefined;
  runtime?.map.remove();
  runtime = undefined;
  document.body.replaceChildren();
  delete window.__GEOCODE_MAP_BOOTSTRAP__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const checkbox = (id: string) =>
  document
    .querySelector(`[data-layer-load-id="${id}"]`)!
    .closest("label")!
    .querySelector<HTMLInputElement>("input")!;
const status = (id: string) =>
  document.querySelector(`[data-layer-load-id="${id}"] .layer-object-load-state`)!.textContent;

describe("lazy groups in the actual read-only map runtime", () => {
  it("standalone attribute search masks later loaded layers and combines with text until explicitly cleared", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value() {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value() {
        this.removeAttribute("open");
      },
    });
    const originalFetch = fetchData.getMockImplementation()!;
    fetchData.mockImplementation(async (url, init) => {
      if (String(url) === "/common-forms")
        return new Response(
          JSON.stringify([
            { id: "form", version: 1, form_title: "記録", form_schema: { fields: [] } },
          ]),
        );
      if (String(url) === "/map-objects/search/attributes") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          layer_ids: null,
          common_form_id: "form",
        });
        return new Response(
          JSON.stringify({
            common_form_id: "form",
            definition_version: 1,
            as_of: "2026-10-30T00:00:00Z",
            marker_ids: ["m-b"],
            shape_ids: ["s-b"],
            target_count: 2,
          }),
        );
      }
      return originalFetch(url, init);
    });
    runtime = initializeReadOnlyMapPage("map-anather");
    const open = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "詳しい検索",
    )!;
    const controlStyle = document.createElement("style");
    controlStyle.textContent = readFileSync(resolve("../frontend/public/map-controls.css"), "utf8");
    document.head.append(controlStyle);
    try {
      const names = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "マーカー名表示",
      )!;
      const appearance = (button: HTMLElement) => {
        const css = getComputedStyle(button);
        return [css.fontSize, css.fontWeight, css.padding, css.borderRadius, css.backgroundColor];
      };
      expect(appearance(open)).toEqual(appearance(names));
    } finally {
      controlStyle.remove();
    }
    open.click();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog select option[value='form']")).not.toBeNull(),
    );
    const form = document.querySelector<HTMLSelectElement>("dialog select")!;
    form.value = "form";
    form.dispatchEvent(new Event("change"));
    [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
      .find((b) => b.textContent === "検索")!
      .click();
    await vi.waitFor(() => expect(open.getAttribute("aria-pressed")).toBe("true"));
    checkbox("a").click();
    checkbox("b").click();
    await vi.waitFor(() => expect(runtime!.getShapeRecord("s-b")).not.toBeNull());
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.getVisibleShapeIds()).toEqual(["s-b"]);
    expect(runtime.map.hasLayer(runtime.markers["marker-m-a"])).toBe(false);
    expect(runtime.map.hasLayer(runtime.markers["marker-m-b"])).toBe(true);
    const input = document.getElementById("marker-search-input") as HTMLInputElement;
    input.value = "no match";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.getVisibleShapeIds()).toEqual([]);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.getVisibleShapeIds()).toEqual(["s-b"]);
    checkbox("b").click();
    checkbox("b").click();
    expect(runtime.getVisibleShapeIds()).toEqual(["s-b"]);
    open.click();
    await flush();
    [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
      .find((b) => b.textContent === "属性条件を解除")!
      .click();
    expect(new Set(runtime.getVisibleShapeIds())).toEqual(new Set(["s-a", "s-b"]));
  });
  it.each([
    { mobile: false, references: false },
    { mobile: true, references: false },
    { mobile: false, references: true },
    { mobile: true, references: true },
  ])(
    "回答JSON blockは現在位置・全対象・Unicode本文の切替を維持する（%j）",
    async ({ mobile, references }) => {
      const previousUrl = location.href;
      try {
        document.body.classList.remove("map-mobile-controls");
        history.replaceState({}, "", mobile ? "?map_ui=mobile" : "?");
        const free = "自由漢字𠮷 e\u0301";
        const answers = "**回答🙂**";
        const body = `${free}\n\n${answers}`;
        const record = shape("a");
        const view = { latitude: 35.68, longitude: 139.76, zoom: 14 };
        const data = {
          ...(window.__GEOCODE_MAP_BOOTSTRAP__ as Record<string, unknown>),
          page: "form-answer-map",
          markers: { "m-a": { ...marker("a"), detail: body } },
          shapes: [
            {
              ...record,
              geojson: {
                ...record.geojson,
                properties: { ...record.geojson.properties, memo: body },
              },
            },
          ],
          popupBodies: Object.fromEntries(
            ["marker:m-a", "shape:s-a"].map((id) => [
              id,
              {
                free_text: references ? `${free}\n\n` : free,
                managed_markdown: answers,
                sync_required: false,
              },
            ]),
          ),
          answerPreview: {
            answerCount: 3,
            targetCount: 2,
            query: { mode: "history", as_of: "2026-10-01T00:00:00Z" },
            targets: ["marker:m-a", "shape:s-a"],
            initialView: view,
            parentOrigin: location.origin,
            requestId: "json-body-runtime",
          },
        };
        if (references) {
          const transport = data as any;
          transport.normalBodyReferences = { version: 1, markers: ["m-a"], shapes: ["s-a"] };
          delete transport.markers["m-a"].detail;
          delete transport.shapes[0].geojson.properties.memo;
        }
        delete window.__GEOCODE_MAP_BOOTSTRAP__;
        const script = document.createElement("script");
        script.id = "geocode-map-bootstrap";
        script.type = "application/json";
        script.textContent = JSON.stringify(data);
        document.body.append(script);
        const bootstrap = readMapBootstrap();
        if (bootstrap.page !== "form-answer-map") throw Error("Wrong page");
        const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
        runtime = initializeReadOnlyMapPage("form-answer-map");
        await runtime.shapeRenderer.whenIdle();
        finishAnswerPreview(runtime, bootstrap, leaflet);
        expect(readMapBootstrap()).toBe(bootstrap);
        expect(bootstrap).not.toHaveProperty("normalBodyReferences");
        expect(bootstrap.markers["m-a"].detail).toBe(body);
        expect(bootstrap.shapes[0].geojson.geometry).toEqual(record.geojson.geometry);
        expect((bootstrap.shapes[0].geojson.properties as any).memo).toBe(body);
        expect(bootstrap.shapes[0].name).toBe(record.name);
        expect(bootstrap.markers["m-a"].marker_name).toBe(marker("a").marker_name);
        expect(document.getElementById("geocode-map-bootstrap")).toBeNull();
        expect(runtime.getVisibleShapeIds()).toEqual(["s-a"]);
        const actualView = runtime.getPrintState().view;
        expect(actualView.zoom).toBe(view.zoom);
        // Leaflet rounds the initial center to map pixels during invalidateSize.
        expect(
          runtime.map
            .project([actualView.latitude, actualView.longitude], view.zoom)
            .distanceTo(runtime.map.project([view.latitude, view.longitude], view.zoom)),
        ).toBeLessThanOrEqual(1);
        expect(document.body.classList.contains("map-mobile-controls")).toBe(mobile);
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "answer-map-ready",
            targetCount: 2,
            answerCount: 3,
            displayed: 2,
            query: data.answerPreview.query,
            targets: data.answerPreview.targets,
          }),
          location.origin,
        );
        runtime.markers["marker-m-a"]
          .getPopup()
          .setLatLng([view.latitude, view.longitude])
          .openOn(runtime.map);
        const select = document.querySelector<HTMLSelectElement>(".popup-content-toolbar select")!;
        await vi.waitFor(() => expect(select.options[0].disabled).toBe(false));
        for (const mode of ["free", "answers", "normal"]) {
          select.value = mode;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          const rendered = document.querySelector<HTMLElement>(".popup-content-body")!;
          if (mode === "free") expect(rendered.textContent?.trim()).toBe(free);
          if (mode === "answers")
            expect(rendered.querySelector("strong")?.textContent).toBe("回答🙂");
          if (mode === "normal") {
            expect(rendered.textContent).toContain(free);
            expect(rendered.querySelector("strong")?.textContent).toBe("回答🙂");
          }
        }
        runtime.shapeLayers["shape-s-a"].fire("click", {
          latlng: leaflet.latLng(view.latitude, view.longitude),
        });
        await vi.waitFor(() =>
          expect(
            document.querySelector<HTMLSelectElement>(".popup-content-toolbar select")!.options[0]
              .disabled,
          ).toBe(false),
        );
        expect(document.querySelector(".popup-content-title")?.textContent).toBe(record.name);
        expect(document.querySelector(".popup-content-body")?.textContent).toContain(free);
        const snapshot = createAnswerPrintSnapshot(bootstrap, runtime, ["marker:m-a", "shape:s-a"]);
        expect(snapshot.bootstrap.markers["m-a"].detail).toBe(body);
        expect((snapshot.bootstrap.shapes[0].geojson.properties as any).memo).toBe(body);
        expect(snapshot.bootstrap).not.toHaveProperty("normalBodyReferences");
        expect(fetchData).not.toHaveBeenCalled();
      } finally {
        history.replaceState({}, "", previousUrl);
      }
    },
  );

  it("縮尺によって図形が省略されても移動・拡大の案内を表示しない", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    bootstrap.page = "form-answer-map";
    const record = shape("a");
    record.geojson.properties.radius = 1;
    bootstrap.shapes = [record];
    bootstrap.answerPreview = {
      query: {},
      targets: ["shape:s-a"],
      parentOrigin: location.origin,
      requestId: "small-shape-status",
    };
    runtime = initializeReadOnlyMapPage("form-answer-map");
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.shapeRenderer.getStats()).toMatchObject({
      eligibleCount: 1,
      renderedCount: 0,
      pendingCount: 0,
    });
    const status = document.querySelector<HTMLElement>(".shape-render-status");
    expect(status?.hidden).toBe(true);
    expect(status?.textContent).toBe("");
  });

  it("同じ検索のまま地図を移動しても原本の長いメモを再走査しない", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    bootstrap.page = "form-answer-map";
    const record = shape("a");
    let reads = 0;
    Object.defineProperty(record.geojson.properties, "memo", {
      get() {
        reads++;
        return "needle ".repeat(1000);
      },
    });
    bootstrap.shapes = [record];
    bootstrap.answerPreview = {
      query: {},
      targets: ["shape:s-a"],
      parentOrigin: location.origin,
      requestId: "search-cache",
    };
    const local = initializeReadOnlyMapPage("form-answer-map");
    runtime = local;
    await local.shapeRenderer.whenIdle();
    reads = 0;
    const input = document.getElementById("marker-search-input") as HTMLInputElement;
    input.value = "needle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await local.shapeRenderer.whenIdle();
    expect(reads).toBe(1);
    local.map.setView([35.681, 139.761], 14, { animate: false });
    await local.shapeRenderer.whenIdle();
    expect(reads).toBe(1);
    input.value = "absent";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await local.shapeRenderer.whenIdle();
    expect(reads).toBe(2);
    expect(local.getVisibleShapeIds()).toEqual([]);
  });

  it("回答地図は画面外の図形を生成せず、検索対象を保持して移動後に生成する", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    bootstrap.page = "form-answer-map";
    bootstrap.shapes = Array.from({ length: 80 }, (_, index) => {
      const record = shape("a");
      const far = index >= 40;
      return {
        ...record,
        id: `lazy-${index}`,
        name: `${far ? "far" : "near"} pipe ${index}`,
        geojson: {
          ...record.geojson,
          geometry: { type: "Point", coordinates: far ? [135.5, 34.69] : [139.76, 35.68] },
        },
      };
    });
    bootstrap.answerPreview = {
      query: {},
      targets: bootstrap.shapes.map((record: any) => `shape:${record.id}`),
      parentOrigin: location.origin,
      requestId: "lazy-viewport",
    };
    runtime = initializeReadOnlyMapPage("form-answer-map");
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.getRenderableShapeIds()).toHaveLength(80);
    expect(runtime.getVisibleShapeIds()).toHaveLength(80);
    expect(Object.keys(runtime.shapeLayers)).toHaveLength(40);
    expect(runtime.shapeLayers["shape-lazy-40"]).toBeUndefined();
    const search = document.getElementById("marker-search-input") as HTMLInputElement;
    search.value = "far pipe";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.getVisibleShapeIds()).toHaveLength(40);
    expect(runtime.shapeRenderer.getStats().renderedCount).toBe(0);
    runtime.map.setView([34.69, 135.5], 14, { animate: false });
    await vi.waitFor(() => expect(runtime!.shapeRenderer.getStats().renderedCount).toBe(40));
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.shapeLayers["shape-lazy-40"]).toBeDefined();
    expect(runtime.getVisibleShapeIds()).toHaveLength(40);
  });

  it("画面外の図形も検索でき、同じ検索の表示再判定ではメモを再走査しない", () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    bootstrap.page = "form-answer-map";
    bootstrap.initialView = { latitude: 34.69, longitude: 135.5, zoom: 14 };
    const record = shape("a");
    const readMemo = vi.fn(() => "needle in a long memo");
    Object.defineProperty(record.geojson.properties, "memo", { enumerable: true, get: readMemo });
    bootstrap.shapes = [record];
    bootstrap.answerPreview = {
      query: {},
      targets: ["shape:s-a"],
      parentOrigin: location.origin,
      requestId: "search-cache",
    };
    runtime = initializeReadOnlyMapPage("form-answer-map");
    expect(readMemo).not.toHaveBeenCalled();
    const input = document.getElementById("marker-search-input") as HTMLInputElement;
    input.value = " NeEdLe ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.getVisibleShapeIds()).toEqual(["s-a"]);
    expect(readMemo).toHaveBeenCalledOnce();
    for (let i = 0; i < 3; i++) runtime.shapeRenderer.refresh();
    expect(runtime.getVisibleShapeIds()).toEqual(["s-a"]);
    expect(readMemo).toHaveBeenCalledOnce();
    input.value = "missing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.getVisibleShapeIds()).toEqual([]);
    expect(readMemo).toHaveBeenCalledTimes(2);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    runtime.shapeRenderer.refresh();
    expect(runtime.getVisibleShapeIds()).toEqual(["s-a"]);
    expect(readMemo).toHaveBeenCalledTimes(2);
  });

  it("共有地図は小図形を低縮尺で生成せず、拡大後に表示する", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    Object.assign(bootstrap, {
      page: "temporary-map",
      isChecked: true,
      isMaster: false,
      isMapUiHidden: false,
      initialView: { latitude: 35.68, longitude: 139.76, zoom: 5 },
      shapes: { a: shape("a") },
    });
    runtime = initializeReadOnlyMapPage("temporary-map");
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.getVisibleShapeIds()).toEqual(["s-a"]);
    expect(runtime.shapeRenderer.getStats().createdCount).toBe(0);
    runtime.map.setView([35.68, 139.76], 14, { animate: false });
    await vi.waitFor(() => expect(runtime!.shapeRenderer.getStats().renderedCount).toBe(1));
    expect(runtime.shapeLayers["shape-s-a"]).toBeDefined();
  });

  it.each(["map-anather", "form-answer-map", "temporary-map", "temporary-map-mobile"] as const)(
    "%sは縮尺別の省略後も原本・回答対象を保持し、拡大後に同じ図形を再利用する",
    async (page) => {
      const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
      const records = [
        ["overview", 7, 10],
        ["middle", 5, 11],
        ["tiny", 3, 14],
        ["large", 12, 10],
      ].map(([id, pixels, zoom]) => {
        const width = (Number(pixels) * 360) / (256 * 2 ** Number(zoom));
        return {
          ...shape("a"),
          id: String(id),
          name: "",
          shape_type: "polyline",
          geojson: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [139.76 - width / 2, 35.68],
                [139.76 + width / 2, 35.68],
              ],
            },
          },
        };
      });
      const original = JSON.stringify(records);
      const view = { latitude: 35.68, longitude: 139.76, zoom: 10 };
      Object.assign(bootstrap, {
        page,
        isChecked: true,
        isMaster: false,
        isMapUiHidden: false,
        initialView: view,
        shapes: page.startsWith("temporary-")
          ? Object.fromEntries(records.map((record) => [record.id, record]))
          : records,
      });
      if (page === "form-answer-map") {
        bootstrap.answerPreview = {
          initialView: view,
          query: {},
          targets: records.map((record) => `shape:${record.id}`),
          answerCount: 9,
          targetCount: 4,
          parentOrigin: location.origin,
          requestId: "zoom-policy",
        };
      }
      fetchData.mockImplementation(
        async (url) =>
          new Response(JSON.stringify(String(url).startsWith("/shapes") ? records : {})),
      );
      runtime = initializeReadOnlyMapPage(page);
      if (page === "map-anather" && !checkbox("a").checked) {
        checkbox("a").click();
        await flush();
      }
      await runtime.shapeRenderer.whenIdle();
      expect(runtime.shapeRenderer.getStats()).toMatchObject({
        eligibleCount: 4,
        renderedCount: 1,
      });
      expect(runtime.shapeLayers["shape-overview"]).toBeUndefined();
      expect(runtime.shapeLayers["shape-middle"]).toBeUndefined();
      const large = runtime.shapeLayers["shape-large"];
      const initialRequests = fetchData.mock.calls.length;
      const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
      for (const [zoom, renderedCount] of [
        [11, 2],
        [14, 3],
        [10, 1],
      ]) {
        runtime.map.setView([35.68, 139.76], zoom, { animate: false });
        await runtime.shapeRenderer.whenIdle();
        expect(runtime.shapeRenderer.getStats()).toMatchObject({
          eligibleCount: 4,
          renderedCount,
          pendingCount: 0,
        });
        expect(runtime.getRenderableShapeIds()).toEqual(records.map((record) => record.id));
        expect(runtime.getVisibleShapeIds()).toEqual(records.map((record) => record.id));
        if (page === "form-answer-map") {
          finishAnswerPreview(runtime, bootstrap, leaflet);
          expect(post).toHaveBeenLastCalledWith(
            expect.objectContaining({
              type: "answer-map-ready",
              answerCount: 9,
              targetCount: 4,
              displayed: 4,
              skipped: 0,
            }),
            location.origin,
          );
          expect(runtime.map.getZoom()).toBe(zoom);
        }
      }
      expect(runtime.shapeLayers["shape-large"]).toBe(large);
      expect(runtime.shapeRenderer.getStats().createdCount).toBe(3);
      expect(runtime.shapeLayers["shape-tiny"]).toBeUndefined();
      expect(fetchData).toHaveBeenCalledTimes(initialRequests);
      expect(JSON.stringify(records)).toBe(original);
      post.mockRestore();
    },
  );

  it("印刷は小図形を省略せず、生成バッチが終わるまで準備完了にしない", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    bootstrap.page = "form-answer-map";
    bootstrap.shapes = Array.from({ length: 300 }, (_, index) => ({
      ...shape("a"),
      id: `print-${index}`,
    }));
    bootstrap.answerPreview = {
      query: {},
      targets: bootstrap.shapes.map((record: any) => `shape:${record.id}`),
      parentOrigin: location.origin,
      requestId: "lazy-print",
    };
    runtime = initializeReadOnlyMapPage("form-answer-map", {
      view: { latitude: 35.68, longitude: 139.76, zoom: 5 },
      tileServerId: "1",
      layerIds: ["a"],
      markersVisible: true,
      shapesVisible: true,
      shapeNamesVisible: false,
      overlays: {},
    });
    expect(runtime.getObjectLoadStatus().loading).toBe(true);
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.getObjectLoadStatus().loading).toBe(false);
    expect(runtime.shapeRenderer.getStats().renderedCount).toBe(300);
  });

  it.each([false, true])(
    "回答地図はトップ地図の中心とズームを引き継ぎ、手動で対象全体にも移動できる（mobile=%s）",
    (mobile) => {
      const previousUrl = location.href;
      const previousClass = document.body.className;
      try {
        history.replaceState({}, "", mobile ? "?map_ui=mobile" : "?");
        const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
        bootstrap.page = "form-answer-map";
        bootstrap.markers = { a: marker("a") };
        const view = { latitude: 34.6937, longitude: 135.5023, zoom: 12 };
        bootstrap.answerPreview = {
          initialView: view,
          query: {},
          targets: ["marker:m-a"],
          answerCount: 1,
          targetCount: 1,
          parentOrigin: location.origin,
          requestId: "inherit-view",
        };
        // 別タブなどで最後に保存された位置よりも、呼び出し元の地図位置を優先する。
        localStorage.setItem(
          "geocode-web:last-map-view",
          JSON.stringify({ latitude: 43, longitude: 141, zoom: 9 }),
        );
        const saved = JSON.stringify(localStorage);
        const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
        runtime = initializeReadOnlyMapPage("form-answer-map");
        const fit = vi.spyOn(runtime.map, "fitBounds");
        finishAnswerPreview(runtime, bootstrap, leaflet);
        const inherited = runtime.getPrintState().view;
        // Leafletの画面サイズ更新によるピクセル単位の丸めを許容する。
        expect(inherited.latitude).toBeCloseTo(view.latitude, 3);
        expect(inherited.longitude).toBeCloseTo(view.longitude, 3);
        expect(inherited.zoom).toBe(view.zoom);
        expect(fit).not.toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({ type: "answer-map-ready", displayed: 1 }),
          location.origin,
        );
        runtime.map.setView([36, 140], 10, { animate: false });
        expect(JSON.stringify(localStorage)).toBe(saved);

        installAnswerFilter(runtime, bootstrap.answerPreview, leaflet, bootstrap);
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: location.origin,
            source: window.parent,
            data: { type: "answer-map-fit", requestId: "inherit-view" },
          }),
        );
        expect(fit).toHaveBeenCalledOnce();
        expect(JSON.stringify(localStorage)).toBe(saved);
      } finally {
        history.replaceState({}, "", previousUrl);
        document.body.className = previousClass;
      }
    },
  );

  it.each([undefined, { latitude: 91, longitude: 139, zoom: 12 }])(
    "引き継ぐ位置がないか不正な場合は回答対象全体に合わせる（view=%j）",
    (initialView) => {
      const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
      bootstrap.page = "form-answer-map";
      bootstrap.markers = { a: marker("a") };
      bootstrap.answerPreview = {
        initialView,
        query: {},
        targets: ["marker:m-a"],
        answerCount: 1,
        targetCount: 1,
        parentOrigin: location.origin,
        requestId: "fallback-view",
      };
      vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
      runtime = initializeReadOnlyMapPage("form-answer-map");
      const fit = vi.spyOn(runtime.map, "fitBounds");
      finishAnswerPreview(runtime, bootstrap, leaflet);
      expect(fit).toHaveBeenCalledOnce();
      expect(
        (fit.mock.calls[0][0] as any).contains(runtime.markers["marker-m-a"].getLatLng()),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "回答地図の機能切替はモバイル呼び出しだけに表示する（mobile=%s）",
    (mobile) => {
      const previousUrl = location.href;
      const previousClass = document.body.className;
      const style = document.createElement("style");
      const template = readFileSync(
        resolve(process.cwd(), "../../src/templates/form-answer-map.html"),
        "utf8",
      );
      const html = new DOMParser().parseFromString(template, "text/html");
      style.textContent = Array.from(html.querySelectorAll("style"))
        .map((node) => node.textContent)
        .join("\n");
      document.head.append(style);
      try {
        history.replaceState({}, "", mobile ? "?map_ui=mobile" : "?");
        const b = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
        b.page = "form-answer-map";
        b.markers = { a: marker("a") };
        b.answerPreview = {
          query: {},
          targets: ["marker:m-a"],
          parentOrigin: location.origin,
          requestId: "mobile-ui",
        };
        runtime = initializeReadOnlyMapPage("form-answer-map");
        const toggle = document.querySelector<HTMLButtonElement>(
          ".map-ui-visibility-toggle-control button",
        );
        if (!mobile) {
          expect(toggle).toBeNull();
          expect(document.querySelectorAll(".temporary-map-hideable-ui")).toHaveLength(0);
          return;
        }
        expect(toggle?.textContent).toBe("機能を非表示");
        expect(toggle?.closest(".leaflet-top.leaflet-left")).not.toBeNull();
        const address = document
          .getElementById("code-input")!
          .closest<HTMLElement>(".leaflet-control")!;
        const nameSearch = document
          .getElementById("marker-search-input")!
          .closest<HTMLElement>(".leaflet-control")!;
        const layers = document.querySelector<HTMLElement>(
          ".leaflet-control-layers-expanded.temporary-map-hideable-ui",
        )!;
        const tooltip = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find((b) => b.textContent === "マーカー名表示")!
          .closest<HTMLElement>(".leaflet-control")!;
        const measurement = document.querySelector<HTMLElement>(".measurement-control")!;
        const hideable = [address, layers, tooltip, measurement];
        expect(nameSearch.classList.contains("temporary-map-hideable-ui")).toBe(false);
        toggle!.click();
        expect(toggle!.textContent).toBe("機能を表示");
        for (const node of hideable) {
          expect(node.classList.contains("is-hidden")).toBe(true);
          expect(getComputedStyle(node).display).toBe("none");
        }
        expect(getComputedStyle(nameSearch).display).not.toBe("none");
        expect(getComputedStyle(toggle!.parentElement!).display).not.toBe("none");
        toggle!.click();
        expect(toggle!.textContent).toBe("機能を非表示");
        for (const node of hideable) {
          expect(node.classList.contains("is-hidden")).toBe(false);
          expect(getComputedStyle(node).display).not.toBe("none");
        }
      } finally {
        style.remove();
        history.replaceState({}, "", previousUrl);
        document.body.className = previousClass;
      }
    },
  );
  it("回答地図の検索・表示条件を固定して印刷し、レイヤ全選択でも対象外を取得しない", async () => {
    const b = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    b.page = "form-answer-map";
    b.markers = {
      a: { ...marker("a"), marker_name: "keep facility" },
      b: marker("b"),
      nameExcluded: { ...marker("a"), id: "name-excluded", marker_name: "drop facility" },
    };
    b.shapes = [{ ...shape("a"), name: "keep pipe" }, shape("b")];
    b.answerPreview = {
      query: { as_of: "2026-10-20T00:00:00Z" },
      targets: ["marker:m-a", "marker:m-b", "shape:s-a", "shape:s-b", "marker:name-excluded"],
      parentOrigin: location.origin,
      requestId: "r",
    };
    runtime = initializeReadOnlyMapPage("form-answer-map");
    runtime.setAnswerTargets(["marker:m-a", "shape:s-a", "marker:m-b", "marker:name-excluded"]);
    checkbox("b").click();
    await flush();
    const search = document.getElementById("marker-search-input") as HTMLInputElement;
    search.value = "keep";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.map.hasLayer(runtime.markers["marker-name-excluded"])).toBe(false);
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    installAnswerFilter(runtime, b.answerPreview, leaflet, b);
    const send = (data: any) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: location.origin,
          source: window.parent,
          data: { requestId: "r", ...data },
        }),
      );
    // initialize the protocol's current answer condition, then capture the visible subset.
    send({
      type: "answer-map-filter",
      updateId: "u",
      targets: ["marker:m-a", "shape:s-a", "marker:m-b", "marker:name-excluded"],
    });
    send({ type: "answer-map-print-enable", enabled: true });
    send({ type: "answer-map-print-request", printRequestId: "p", updateId: "old" });
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "answer-map-print-error" }),
      location.origin,
    );
    send({ type: "answer-map-print-request", printRequestId: "p", updateId: "u" });
    const snapshot = post.mock.calls.at(-1)![0].snapshot;
    expect(Object.keys(snapshot.bootstrap.markers)).toEqual(["a"]);
    expect(snapshot.bootstrap.shapes.map((s: any) => s.id)).toEqual(["s-a"]);
    expect(snapshot.state.view).toEqual(runtime.getPrintState().view);
    runtime.map.remove();
    runtime = undefined;
    document.body.innerHTML = '<div id="map"></div>';
    window.__GEOCODE_MAP_BOOTSTRAP__ = snapshot.bootstrap;
    const saved = JSON.stringify(localStorage);
    preview = createPrintPreview(snapshot.state, () => {}, "form-answer-map");
    for (const input of document.querySelectorAll<HTMLInputElement>(
      '#print-layers input[type="checkbox"]',
    )) {
      input.click();
      input.click();
    }
    await flush();
    expect(fetchData).not.toHaveBeenCalled();
    expect(Object.keys(snapshot.bootstrap.markers)).toEqual(["a"]);
    expect(Object.keys(snapshot.bootstrap.layers)).toEqual(["a"]);
    expect(JSON.stringify(localStorage)).toBe(saved);
    post.mockRestore();
  });
  it("回答地図は該当対象だけを表示し、切替でも追加取得せず、保存設定を変更しない", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as AnotherMapBootstrap;
    (bootstrap as any).page = "form-answer-map";
    bootstrap.answerPreview = {
      query: { as_of: "2026-10-20T00:00:00Z" },
      targets: [
        "marker:m-a",
        "shape:s-a",
        "shape:line",
        "shape:polygon",
        "shape:rectangle",
        "shape:broken",
      ],
      answerCount: 8,
      targetCount: 6,
      parentOrigin: window.location.origin,
      requestId: "answer-test",
    };
    bootstrap.markers = { "m-a": marker("a") };
    bootstrap.shapes = [
      shape("a"),
      { ...shape("a"), id: "broken", geojson: { type: "Unsupported" } },
    ] as any;
    bootstrap.layers = { a: bootstrap.layers.a };
    for (const [id, type, geometry] of [
      [
        "line",
        "polyline",
        {
          type: "LineString",
          coordinates: [
            [139.76, 35.68],
            [139.77, 35.69],
          ],
        },
      ],
      [
        "polygon",
        "polygon",
        {
          type: "Polygon",
          coordinates: [
            [
              [139.76, 35.68],
              [139.77, 35.68],
              [139.77, 35.69],
              [139.76, 35.68],
            ],
          ],
        },
      ],
      [
        "rectangle",
        "rectangle",
        {
          type: "Polygon",
          coordinates: [
            [
              [139.76, 35.68],
              [139.77, 35.68],
              [139.77, 35.69],
              [139.76, 35.69],
              [139.76, 35.68],
            ],
          ],
        },
      ],
    ] as const) {
      bootstrap.shapes.push({
        ...shape("a"),
        id,
        shape_type: type,
        geojson: { type: "Feature", properties: {}, geometry },
      } as any);
    }
    localStorage.setItem("geocode-web:shape-layer-visible", "false");
    localStorage.setItem("geocode-web:marker-visible", "false");
    const saved = JSON.stringify(localStorage);
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    runtime = initializeReadOnlyMapPage("form-answer-map");
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.map.hasLayer(runtime.markers["marker-m-a"])).toBe(true);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-s-a"])).toBe(true);
    for (const id of ["line", "polygon", "rectangle"])
      expect(runtime.map.hasLayer(runtime.shapeLayers[`shape-${id}`])).toBe(true);
    checkbox("a").click();
    await flush();
    checkbox("a").click();
    await flush();
    expect(fetchData).not.toHaveBeenCalled();
    expect(Object.keys(runtime.markers)).toEqual(["marker-m-a"]);
    await runtime.shapeRenderer.whenIdle();
    const fit = vi.spyOn(runtime.map, "fitBounds");
    finishAnswerPreview(runtime, bootstrap, leaflet);
    expect(fit).toHaveBeenCalledOnce();
    const bounds = fit.mock.calls[0][0] as any;
    expect(bounds.contains(runtime.shapeLayers["shape-s-a"].getBounds())).toBe(true);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "answer-map-ready",
        answerCount: 8,
        targetCount: 6,
        displayed: 5,
        skipped: 1,
        requestId: "answer-test",
      }),
      window.location.origin,
    );
    expect(JSON.stringify(localStorage)).toBe(saved);
    const cachedMarker = runtime.markers["marker-m-a"];
    const cachedShape = runtime.shapeLayers["shape-s-a"];
    fit.mockClear();
    runtime.setAnswerTargets(["shape:s-a"]);
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.map.hasLayer(cachedMarker)).toBe(false);
    expect(runtime.map.hasLayer(cachedShape)).toBe(true);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-line"])).toBe(false);
    checkbox("a").click();
    await flush();
    checkbox("a").click();
    await flush();
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.map.hasLayer(cachedMarker)).toBe(false);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-line"])).toBe(false);
    runtime.setAnswerTargets([]);
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.map.hasLayer(cachedShape)).toBe(false);
    runtime.setAnswerTargets(bootstrap.answerPreview.targets!);
    await runtime.shapeRenderer.whenIdle();
    expect(runtime.markers["marker-m-a"]).toBe(cachedMarker);
    expect(runtime.shapeLayers["shape-s-a"]).toBe(cachedShape);
    expect(runtime.map.hasLayer(cachedMarker)).toBe(true);
    expect(runtime.map.hasLayer(cachedShape)).toBe(true);
    expect(fit).not.toHaveBeenCalled();
    expect(fetchData).not.toHaveBeenCalled();
    expect(JSON.stringify(localStorage)).toBe(saved);
    post.mockRestore();
  });
  it.each([false, true])(
    "shows empty groups immediately and preserves marker/shape instances across check toggles (cluster=%s)",
    async (cluster) => {
      (window.__GEOCODE_MAP_BOOTSTRAP__ as { isCluster: boolean }).isCluster = cluster;
      runtime = initializeReadOnlyMapPage("map-anather");
      expect(document.querySelectorAll("[data-layer-load-id]")).toHaveLength(3);
      expect(fetchData).not.toHaveBeenCalled();
      checkbox("a").click();
      await flush();
      expect(fetchData).toHaveBeenCalledTimes(2);
      await runtime.shapeRenderer.whenIdle();
      const firstMarker = runtime.markers["marker-m-a"],
        firstShape = runtime.shapeLayers["shape-s-a"];
      expect(runtime.map.hasLayer(firstMarker)).toBe(true);
      expect(runtime.map.hasLayer(firstShape)).toBe(true);
      checkbox("a").click();
      await flush();
      await runtime.shapeRenderer.whenIdle();
      expect(runtime.map.hasLayer(firstMarker)).toBe(false);
      expect(runtime.map.hasLayer(firstShape)).toBe(false);
      checkbox("a").click();
      await flush();
      expect(fetchData).toHaveBeenCalledTimes(2);
      await runtime.shapeRenderer.whenIdle();
      expect(runtime.markers["marker-m-a"]).toBe(firstMarker);
      expect(runtime.shapeLayers["shape-s-a"]).toBe(firstShape);
      expect(runtime.map.hasLayer(firstShape)).toBe(true);
    },
  );

  it("keeps an unchecked response hidden and applies the current search and marker-name setting", async () => {
    const pendingMarkers = deferred<Response>(),
      pendingShapes = deferred<Response>();
    fetchData
      .mockReturnValueOnce(pendingMarkers.promise)
      .mockReturnValueOnce(pendingShapes.promise);
    runtime = initializeReadOnlyMapPage("map-anather");
    const nameButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "マーカー名表示",
    )!;
    nameButton.click();
    checkbox("a").click();
    expect(status("a")).toBe("");
    expect(runtime.getObjectLoadStatus().loading).toBe(true);
    checkbox("a").click();
    pendingMarkers.resolve(new Response(JSON.stringify({ "m-a": marker("a") })));
    pendingShapes.resolve(new Response(JSON.stringify([shape("a")])));
    await flush();
    expect(runtime.map.hasLayer(runtime.markers["marker-m-a"])).toBe(false);
    // チェック解除中に取得した図形はレコードだけを保持し、生成しない。
    expect(runtime.shapeLayers["shape-s-a"]).toBeUndefined();
    expect(runtime.getShapeRecord("s-a")).not.toBeNull();
    checkbox("a").click();
    await flush();
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(runtime.markers["marker-m-a"].isTooltipOpen()).toBe(true);
    const input = document.getElementById("marker-search-input") as HTMLInputElement;
    input.value = "no match";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.map.hasLayer(runtime.markers["marker-m-a"])).toBe(false);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-s-a"])).toBe(false);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtime.map.hasLayer(runtime.markers["marker-m-a"])).toBe(true);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-s-a"])).toBe(true);
  });

  it("reports failures next to the group, retries on a new check and supports select-all", async () => {
    runtime = initializeReadOnlyMapPage("map-anather");
    fetchData.mockResolvedValueOnce(new Response("failed", { status: 500 }));
    checkbox("a").click();
    await flush();
    expect(status("a")).toContain("取得できませんでした");
    expect(runtime.getObjectLoadStatus().failed).toBe(true);
    checkbox("a").click();
    checkbox("a").click();
    await flush();
    expect(status("a")).toBe("");
    expect(runtime.getObjectLoadStatus()).toEqual({ loading: false, failed: false });
    document.querySelector<HTMLButtonElement>(".layer-bulk-toggle-control button")!.click();
    document.querySelector<HTMLButtonElement>(".layer-bulk-toggle-control button")!.click();
    await flush();
    expect(fetchData).toHaveBeenCalledTimes(8);
    expect(Object.keys(runtime.markers)).toHaveLength(3);
    await runtime.shapeRenderer.whenIdle();
    const measurement = document.querySelector<HTMLButtonElement>(".measurement-control button")!;
    measurement.click();
    await flush();
    expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(0);
    runtime.shapeLayers["shape-s-a"].fire("click", { originalEvent: new MouseEvent("click") });
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".shape-measure-label").length).toBeGreaterThan(0),
    );
  });

  it.each(["map-anather", "temporary-map", "temporary-map-mobile"] as const)(
    "measures clicked shapes only and keeps individual labels when totals toggle in %s",
    async (page) => {
      const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__!;
      Object.assign(bootstrap, {
        page,
        isChecked: true,
        isMaster: false,
        isMapUiHidden: false,
        shapes: page === "map-anather" ? [] : { a: shape("a"), b: shape("b") },
      });
      runtime = initializeReadOnlyMapPage(page);
      if (page === "map-anather") {
        checkbox("a").click();
        checkbox("b").click();
        await flush();
      }
      await runtime.shapeRenderer.whenIdle();
      const a = runtime.shapeLayers["shape-s-a"],
        b = runtime.shapeLayers["shape-s-b"];
      const [measureButton, , totalsButton] = document.querySelectorAll<HTMLButtonElement>(
        ".measurement-control button",
      );
      const summary = document.querySelector<HTMLElement>(".measurement-selection-summary")!;
      expect(totalsButton.textContent).toBe("複数計測");
      expect(measureButton.classList.contains("is-active")).toBe(false);
      measureButton.click();
      expect(measureButton.classList.contains("is-active")).toBe(true);
      expect(measureButton.getAttribute("aria-pressed")).toBe("true");
      await flush();
      expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(0);
      a.fire("click", { originalEvent: new MouseEvent("click") });
      await vi.waitFor(() =>
        expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(1),
      );
      b.fire("click", { originalEvent: new MouseEvent("click") });
      await vi.waitFor(() =>
        expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(2),
      );
      expect(document.querySelector(".is-measurement-selected")).toBeNull();
      expect(summary.hidden).toBe(true);
      totalsButton.click();
      expect(summary.hidden).toBe(false);
      expect(summary.textContent).toContain("円 2件");
      totalsButton.click();
      await flush();
      expect(summary.hidden).toBe(true);
      expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(2);
      totalsButton.click();
      a.fire("click", { originalEvent: new MouseEvent("click") });
      expect(summary.textContent).toContain("円 1件");
      await vi.waitFor(() =>
        expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(1),
      );
      // Leaflet のホイール操作と同様に、マウス位置を中心に拡大・縮小する。
      const measuredMarker = () =>
        b.measurementMarkers.find((marker: any) => !marker.isMeasurementVertex);
      const originalAnchor = measuredMarker().getLatLng();
      runtime.map.setZoomAround(leaflet.point(120, 80), runtime.map.getZoom() + 1, {
        animate: false,
      });
      await flush();
      expect(measuredMarker().getLatLng()).toEqual(originalAnchor);
      expect(leaflet.DomUtil.getPosition(measuredMarker().getElement())).toEqual(
        runtime.map.latLngToLayerPoint(originalAnchor),
      );
      const panel = measuredMarker().getElement().querySelector(".shape-measure-label");
      panel.setPointerCapture = vi.fn();
      panel.hasPointerCapture = () => true;
      panel.releasePointerCapture = vi.fn();
      for (const [type, x, y] of [
        ["pointerdown", 100, 100],
        ["pointermove", 180, 120],
        ["pointerup", 180, 120],
      ] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
        panel.dispatchEvent(event);
      }
      const movedAnchor = measuredMarker().getLatLng();
      expect(movedAnchor).not.toEqual(originalAnchor);
      runtime.map.setZoomAround(leaflet.point(500, 400), runtime.map.getZoom() - 1, {
        animate: false,
      });
      await flush();
      expect(measuredMarker().getLatLng()).toEqual(movedAnchor);
      expect(leaflet.DomUtil.getPosition(measuredMarker().getElement())).toEqual(
        runtime.map.latLngToLayerPoint(movedAnchor),
      );
      // 地図を移動しても計測状態を維持し、ラベルを保持した緯度・経度に追従させる。
      runtime.map.panBy([100, 0], { animate: false });
      await flush();
      expect(measuredMarker().getLatLng()).toEqual(movedAnchor);
      expect(summary.textContent).toContain("円 1件");
      expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(1);
      if (page === "map-anather") {
        checkbox("b").click();
        expect(summary.textContent).toContain("選択してください");
        checkbox("b").click();
        // ラベルの削除は次の描画フレームで行われるため、削除完了を待つ。
        await vi.waitFor(() =>
          expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(0),
        );
      }
      measureButton.click();
      expect(summary.hidden).toBe(true);
      expect(measureButton.classList.contains("is-active")).toBe(false);
      expect(measureButton.getAttribute("aria-pressed")).toBe("false");
      expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(0);
      measureButton.click();
      await flush();
      expect(document.querySelectorAll(".shape-measure-label")).toHaveLength(0);
    },
  );

  it("only loads initially selected print groups and includes pending objects in print readiness", async () => {
    const pending = deferred<Response>();
    fetchData.mockReturnValueOnce(pending.promise);
    runtime = initializeReadOnlyMapPage("map-anather", {
      view: { latitude: 35.68, longitude: 139.76, zoom: 14 },
      tileServerId: "1",
      layerIds: ["b"],
      markersVisible: true,
      shapesVisible: true,
      shapeNamesVisible: true,
      overlays: {},
    });
    expect(checkbox("b").checked).toBe(true);
    expect(checkbox("a").checked).toBe(false);
    expect(runtime.getObjectLoadStatus().loading).toBe(true);
    expect(fetchData).toHaveBeenCalledTimes(2);
    pending.resolve(new Response(JSON.stringify({ "m-b": marker("b") })));
    await flush();
    expect(runtime.getObjectLoadStatus()).toEqual({ loading: false, failed: false });
    expect(Object.keys(runtime.markers)).toEqual(["marker-m-b"]);
  });

  it("blocks print/PDF on pending or failed object loads, including after the tile timeout, and retries", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    fetchData.mockReturnValueOnce(pending.promise);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview = createPrintPreview(
      {
        view: { latitude: 35.68, longitude: 139.76, zoom: 14 },
        tileServerId: "1",
        layerIds: ["a"],
        markersVisible: true,
        shapesVisible: true,
        shapeNamesVisible: true,
        overlays: {},
      },
      () => {},
    );
    const submit = document.getElementById("print-submit") as HTMLButtonElement;
    const pdf = document.getElementById("pdf-export") as HTMLButtonElement;
    await vi.advanceTimersByTimeAsync(31000);
    expect(submit.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    pending.resolve(new Response("{}"));
    await vi.advanceTimersByTimeAsync(400);
    expect(document.getElementById("print-status")!.textContent).toContain(
      "グループのデータを取得できませんでした",
    );
    expect(submit.disabled).toBe(true);
    submit.click();
    expect(print).not.toHaveBeenCalled();
    document.getElementById("print-retry")!.click();
    await vi.advanceTimersByTimeAsync(100);
    preview.map.eachLayer((layer: any) => {
      if (layer instanceof leaflet.TileLayer) preview!.map.removeLayer(layer);
    });
    document.querySelectorAll("#map img").forEach((img) =>
      Object.defineProperties(img, {
        complete: { value: true, configurable: true },
        naturalWidth: { value: 24, configurable: true },
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(submit.disabled).toBe(false);
    expect(pdf.disabled).toBe(false);
    expect(fetchData).toHaveBeenCalledTimes(4);
    submit.click();
    expect(print).toHaveBeenCalledOnce();
    print.mockRestore();
  });
});
