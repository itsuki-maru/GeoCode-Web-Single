import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeReadOnlyMapPage } from "../src/map/read-only-page";
import { finishAnswerPreview } from "../src/map/answer-preview";
import type { AnotherMapBootstrap } from "../src/map/types";
import { createPrintPreview } from "../src/map/print/print-preview";
import { createAnswerPrintSnapshot } from "../src/map/print/answer-print-state";
import { installAnswerFilter } from "../src/map/answer-filter";

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
    marked: {
      Renderer: class {
        link() {
          return "";
        }
      },
      setOptions: vi.fn(),
      use: vi.fn(),
      parse: (value: string) => value,
    },
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
    expect(runtime.map.hasLayer(cachedMarker)).toBe(false);
    expect(runtime.map.hasLayer(cachedShape)).toBe(true);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-line"])).toBe(false);
    checkbox("a").click();
    await flush();
    checkbox("a").click();
    await flush();
    expect(runtime.map.hasLayer(cachedMarker)).toBe(false);
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-line"])).toBe(false);
    runtime.setAnswerTargets([]);
    expect(runtime.map.hasLayer(cachedShape)).toBe(false);
    runtime.setAnswerTargets(bootstrap.answerPreview.targets!);
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
      const firstMarker = runtime.markers["marker-m-a"],
        firstShape = runtime.shapeLayers["shape-s-a"];
      expect(runtime.map.hasLayer(firstMarker)).toBe(true);
      expect(runtime.map.hasLayer(firstShape)).toBe(true);
      checkbox("a").click();
      await flush();
      expect(runtime.map.hasLayer(firstMarker)).toBe(false);
      expect(runtime.map.hasLayer(firstShape)).toBe(false);
      checkbox("a").click();
      await flush();
      expect(fetchData).toHaveBeenCalledTimes(2);
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
    expect(runtime.map.hasLayer(runtime.shapeLayers["shape-s-a"])).toBe(false);
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
