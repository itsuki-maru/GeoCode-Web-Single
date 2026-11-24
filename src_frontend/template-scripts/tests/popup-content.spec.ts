import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPopupContentRuntime } from "../src/map/common/popup-content";
import { setupDetailsLazyImages } from "../src/map/common/content";
// 実行時には、Markdown と分析用 HTML の両方にページのサニタイザーを使う必要がある。
const filterXSS = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ onerror=[^ >]*/gi, "");

function fixture(overrides: Record<string, any> = {}, mapContainer?: HTMLElement) {
  const handlers: Record<string, (event: any) => void> = {};
  const loadBody = vi.fn(async () => ({
    body: "自由\n登録",
    free_text: "自由\n",
    managed_markdown: "登録",
    sync_required: false,
  }));
  const setupImages = vi.fn((root: ParentNode) => setupDetailsLazyImages(root));
  const renderMarkdown = vi.fn((text: string) => filterXSS(`<p>${text}</p>`));
  const runtime = createPopupContentRuntime({
    map: {
      ...(mapContainer ? { getContainer: () => mapContainer } : {}),
      on: (event, fn) => {
        handlers[event] = fn;
      },
      off: (event, fn) => {
        if (handlers[event] === fn) delete handlers[event];
      },
    },
    renderMarkdown,
    sanitizeHtml: (html) => filterXSS(html),
    setupImages,
    loadBody,
    ...overrides,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const popup = {
    getElement: () => host,
    getLatLng: vi.fn(() => ({ lat: 35.5, lng: 139.5 })),
    update: vi.fn(),
    setContent: vi.fn(),
  };
  const open = (kind: "marker" | "shape" = "marker", body = "自由\n登録") => {
    host.innerHTML = runtime.render({ kind, id: "same", name: "<対象>", body });
    handlers.popupopen({ popup });
  };
  const select = () => host.querySelector("select")!;
  const choose = (mode: string) => {
    select().value = mode;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  };
  return {
    runtime,
    host,
    popup,
    handlers,
    open,
    select,
    choose,
    loadBody,
    setupImages,
    renderMarkdown,
  };
}
afterEach(() => {
  document.body.innerHTML = "";
  document.body.classList.remove("map-mobile-controls");
});
describe("owner popup content selector", () => {
  it("links to the stored marker position without a route search runtime", () => {
    let marker = { latitude: 36.25, longitude: 140.75 };
    const getMarkerRecord = vi.fn(() => marker);
    const f = fixture({ getMarkerRecord, showGoogleMapLink: true });
    f.open("marker");

    const link = f.host.querySelector<HTMLAnchorElement>("a.popup-content-google-link")!;
    expect(getMarkerRecord).toHaveBeenCalledWith("same");
    expect(link.textContent).toBe("Google Map で開く");
    expect(link.target).toBe("_blank");
    expect(link.relList.contains("noopener")).toBe(true);
    expect(link.relList.contains("noreferrer")).toBe(true);
    const destination = new URL(link.href);
    expect(destination.origin).toBe("https://www.google.com");
    expect(destination.pathname).toBe("/maps/search/");
    expect(destination.searchParams.get("api")).toBe("1");
    expect(destination.searchParams.get("query")).toBe("36.25,140.75");
    expect(f.host.querySelector(".popup-content-route-button")).toBeNull();

    marker = { latitude: 35, longitude: 139 };
    link.addEventListener("click", (event) => event.preventDefault());
    link.click();
    expect(new URL(link.href).searchParams.get("query")).toBe("35,139");
  });

  it("links to the click position each time a shape popup opens", () => {
    const f = fixture({ showGoogleMapLink: true });
    const destination = () => {
      const link = f.host.querySelector<HTMLAnchorElement>("a.popup-content-google-link")!;
      return new URL(link.href).searchParams.get("query");
    };
    f.open("shape");
    expect(destination()).toBe("35.5,139.5");
    f.handlers.popupclose({ popup: f.popup });
    f.popup.getLatLng.mockReturnValue({ lat: 34, lng: 138 });
    f.open("shape");
    expect(destination()).toBe("34,138");
  });

  it.each([
    ["unavailable", { isAvailable: () => false, search: vi.fn(), cancelPending: vi.fn() }],
    ["unconfigured", undefined],
  ] as const)(
    "temporarily hides controls that do not fit with the mobile popup when Routes is %s",
    (_name, routeSearch) => {
      document.body.classList.add("map-mobile-controls");
      const mapContainer = document.createElement("div");
      const controls = document.createElement("div");
      controls.className = "leaflet-top";
      mapContainer.append(controls);
      document.body.append(mapContainer);
      let mapHeight = 700;
      vi.spyOn(mapContainer, "getBoundingClientRect").mockImplementation(() =>
        DOMRect.fromRect({ y: 20, width: 320, height: mapHeight }),
      );
      Object.defineProperty(mapContainer, "clientHeight", { get: () => mapHeight });
      vi.spyOn(controls, "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({ y: 20, width: 110, height: 400 }),
      );
      const f = fixture({ routeSearch, showGoogleMapLink: true }, mapContainer);
      mapContainer.append(f.host);
      f.host.className = "leaflet-popup";
      f.host.style.marginBottom = "20px";
      Object.defineProperty(f.host, "offsetHeight", { value: 240 });
      const topLeft = [3, 4];
      const bottomRight = [5, 6];
      const popupOptions = {
        autoPanPaddingTopLeft: topLeft,
        autoPanPaddingBottomRight: bottomRight,
      };
      Object.assign(f.popup, { options: popupOptions });
      const overlapClass = ".popup-content-overlaps-controls";
      const movesControlsAside = () =>
        mapContainer.matches(overlapClass) || mapContainer.querySelector(overlapClass) !== null;
      const resize = (height: number) => {
        mapHeight = height;
        f.handlers.resize({ newSize: { x: 320, y: height } });
      };

      f.open("shape");
      expect(f.host.querySelector(".popup-content-google-link")).not.toBeNull();
      expect(movesControlsAside()).toBe(true);
      expect(popupOptions.autoPanPaddingTopLeft).toEqual([10, 10]);
      expect(popupOptions.autoPanPaddingBottomRight).toEqual([10, 45]);

      resize(720);
      expect(movesControlsAside()).toBe(false);
      expect(popupOptions.autoPanPaddingTopLeft).toEqual([10, 408]);
      expect(popupOptions.autoPanPaddingBottomRight).toEqual([10, 45]);

      resize(700);
      expect(movesControlsAside()).toBe(true);
      expect(popupOptions.autoPanPaddingTopLeft).toEqual([10, 10]);
      f.handlers.popupclose({ popup: f.popup });
      expect(movesControlsAside()).toBe(false);
      expect(popupOptions.autoPanPaddingTopLeft).toBe(topLeft);
      expect(popupOptions.autoPanPaddingBottomRight).toBe(bottomRight);
      expect(f.handlers.resize).toBeUndefined();
    },
  );

  it("omits the Google Maps link if no marker coordinate provider is configured", () => {
    const f = fixture({ showGoogleMapLink: true });
    f.open("marker");
    expect(f.host.querySelector(".popup-content-google-link")).toBeNull();
  });

  it.each([
    ["marker", Number.NaN, 139],
    ["marker", 35, -181],
    ["shape", 91, 139],
    ["shape", 35, Number.POSITIVE_INFINITY],
  ] as const)(
    "omits the Google Maps link for an invalid %s position (%s, %s)",
    (kind, lat, lng) => {
      const f = fixture({
        getMarkerRecord: () => ({ latitude: lat, longitude: lng }),
        showGoogleMapLink: true,
      });
      f.popup.getLatLng.mockReturnValue({ lat, lng });
      f.open(kind);
      expect(f.host.querySelector(".popup-content-google-link")).toBeNull();
    },
  );

  it.each([
    ["disabled", { showGoogleMapLink: false }],
    ["omitted", {}],
  ] as const)("omits the Google Maps link when the option is %s", (_name, option) => {
    const f = fixture({
      ...option,
      getMarkerRecord: () => ({ latitude: 35, longitude: 139 }),
    });
    f.open("marker");
    expect(f.host.querySelector(".popup-content-google-link")).toBeNull();
    f.handlers.popupclose({ popup: f.popup });
    f.open("shape");
    expect(f.host.querySelector(".popup-content-google-link")).toBeNull();
  });

  it("shows the route button next to the selector only when Routes is available", () => {
    const routeSearch = {
      isAvailable: vi.fn(() => false),
      search: vi.fn(),
      cancelPending: vi.fn(),
    };
    const f = fixture({ routeSearch });
    f.open("shape", "");
    const button = f.host.querySelector<HTMLButtonElement>(".popup-content-route-button")!;
    expect(button.previousElementSibling?.contains(f.select())).toBe(true);
    expect(button.textContent).toBe("この場所への経路");
    expect(button.hidden).toBe(true);
    button.click();
    expect(routeSearch.search).not.toHaveBeenCalled();
    routeSearch.isAvailable.mockReturnValue(true);
    f.handlers.googleroutesavailabilitychange({});
    expect(button.hidden).toBe(false);
    routeSearch.isAvailable.mockReturnValue(false);
    f.handlers.basemapstatechange({});
    expect(button.hidden).toBe(true);
    f.handlers.popupclose({ popup: f.popup });
    expect(f.handlers.basemapstatechange).toBeUndefined();
    expect(f.handlers.googleroutesavailabilitychange).toBeUndefined();
  });

  it("does not add a route action to a popup that has not enabled route search", () => {
    const f = fixture();
    f.open();
    expect(f.host.querySelector(".popup-content-route-button")).toBeNull();
  });

  it("uses the latest stored marker position and keeps its location error separate from the body", async () => {
    let locationError: ((message: string) => void) | undefined;
    let marker = { latitude: 35, longitude: 139 };
    const message = "現在位置の取得に時間がかかっています。時間をおいて再試行してください。";
    const routeSearch = {
      isAvailable: () => true,
      search: vi.fn((_position, onLocationError: (message: string) => void) => {
        locationError = onLocationError;
      }),
      cancelPending: vi.fn(),
    };
    const f = fixture({
      routeSearch,
      getMarkerRecord: () => marker,
    });
    f.open();
    marker = { latitude: 36, longitude: 140 };
    f.host.querySelector<HTMLButtonElement>(".popup-content-route-button")!.click();
    expect(routeSearch.search).toHaveBeenCalledExactlyOnceWith(
      { lat: 36, lng: 140 },
      expect.any(Function),
    );
    const routeNote = f.host.querySelector(".popup-content-route-note")!;
    locationError?.(message);
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    f.choose("free");
    expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n");
    expect(routeNote.textContent).toBe(message);
    f.handlers.popupclose({ popup: f.popup });
    expect(routeSearch.cancelPending).toHaveBeenCalledOnce();
    routeNote.textContent = "";
    locationError?.(message);
    expect(routeNote.textContent).toBe("");
  });

  it("uses the position where a shape popup was opened", () => {
    const routeSearch = { isAvailable: () => true, search: vi.fn(), cancelPending: vi.fn() };
    const f = fixture({ routeSearch });
    f.open("shape");
    f.popup.getLatLng.mockReturnValue({ lat: 34, lng: 138 });
    f.host.querySelector<HTMLButtonElement>(".popup-content-route-button")!.click();
    expect(routeSearch.search).toHaveBeenCalledExactlyOnceWith(
      { lat: 35.5, lng: 139.5 },
      expect.any(Function),
    );
  });

  it("描画キャッシュの破棄時に準備済み本文を解放し、分類データは印刷用に保持する", async () => {
    const f = fixture();
    const content = { kind: "shape" as const, id: "same", name: "<対象>", body: "自由\n登録" };
    f.runtime.render(content);
    f.runtime.render(content);
    expect(f.renderMarkdown).toHaveBeenCalledTimes(1);
    f.runtime.setAnalysis("shape:same", "分類結果");
    f.runtime.release("shape", "same");
    f.runtime.render(content);
    expect(f.renderMarkdown).toHaveBeenCalledTimes(2);
    expect(f.runtime.getAnalysis()).toEqual({ "shape:same": "分類結果" });
    f.open("shape");
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    expect(f.select().onchange).not.toBeNull();
    f.handlers.unload({});
    expect(f.select().onchange).toBeNull();
    expect(f.runtime.getAnalysis()).toEqual({});
  });

  it("keeps the reading position through append and later image layout updates", async () => {
    const f = fixture();
    f.open();
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    const root = f.host.querySelector<HTMLElement>(".geocode-content-popup")!;
    const body = f.host.querySelector<HTMLElement>(".popup-content-body")!;
    const outer = document.createElement("div");
    outer.className = "leaflet-popup-content";
    f.host.className = "leaflet-popup";
    root.remove();
    outer.append(root);
    f.host.append(outer);
    const gallery = document.createElement("div");
    gallery.className = "geocode-progressive-content";
    const button = document.createElement("button");
    button.textContent = "さらに読み込む";
    gallery.append(button);
    body.append(gallery);
    const resetScroll = () => {
      outer.scrollTop = outer.scrollLeft = body.scrollTop = body.scrollLeft = 0;
    };
    f.popup.update.mockClear().mockImplementation(() => {
      root.remove();
      outer.append(root);
      resetScroll();
    });
    button.focus();
    const focus = vi.spyOn(button, "focus").mockImplementation((options) => {
      HTMLElement.prototype.focus.call(button, options);
      resetScroll();
    });
    for (const [outerTop, outerLeft, bodyTop, bodyLeft] of [
      [180, 7, 480, 12],
      [330, 11, 900, 19],
    ]) {
      outer.scrollTop = outerTop!;
      outer.scrollLeft = outerLeft!;
      body.scrollTop = bodyTop!;
      body.scrollLeft = bodyLeft!;
      gallery.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
      expect([outer.scrollTop, outer.scrollLeft, body.scrollTop, body.scrollLeft]).toEqual([
        outerTop,
        outerLeft,
        bodyTop,
        bodyLeft,
      ]);
      expect(document.activeElement).toBe(button);
    }
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    f.handlers.popupclose({ popup: f.popup });
  });

  it("preserves prepared body DOM through opening and body API completion", async () => {
    const f = fixture();
    f.open();
    const paragraph = f.host.querySelector(".popup-content-body p")!;
    paragraph.setAttribute("data-retained", "true");
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    expect(f.host.querySelector(".popup-content-body p")).toBe(paragraph);
    expect(f.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(f.setupImages).toHaveBeenCalledTimes(1);
    f.choose("free");
    f.choose("answers");
    f.choose("normal");
    expect(f.renderMarkdown).toHaveBeenCalledTimes(3);
    expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n登録");
    f.handlers.popupclose({ popup: f.popup });
    expect(f.popup.setContent).toHaveBeenLastCalledWith(expect.any(String));
    f.open();
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    expect(f.renderMarkdown).toHaveBeenCalledTimes(3);
    expect(f.loadBody).toHaveBeenCalledTimes(1);
  });

  it("does not redraw the body when frozen print data is available synchronously", () => {
    const f = fixture({
      snapshot: {
        "marker:same": { free_text: "自由", managed_markdown: "登録", sync_required: false },
      },
    });
    f.open();
    expect(f.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(f.setupImages).toHaveBeenCalledTimes(1);
    expect(f.loadBody).not.toHaveBeenCalled();
    expect(f.select().options[0].disabled).toBe(false);
  });

  it("invalidates prepared HTML and form projections when the stored body changes", async () => {
    const f = fixture({
      loadBody: vi.fn(async () => ({ free_text: "", managed_markdown: "", sync_required: false })),
    });
    f.open();
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    f.handlers.popupclose({ popup: f.popup });
    f.open("marker", "更新後");
    await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
    expect(f.renderMarkdown).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("更新後");
  });

  it("loads the common popup styles in the map templates that use them", () => {
    const templates = resolve(process.cwd(), "../../src/templates");
    const actual = readdirSync(templates).filter(
      (name) =>
        name.endsWith(".html") &&
        readFileSync(resolve(templates, name), "utf-8").includes("/assets/popup-content.css"),
    );
    expect(actual.sort()).toEqual(
      [
        "map.html",
        "map-mobile.html",
        "map-anather.html",
        "form-answer-map.html",
        "form-answer-map-print.html",
        "temporary-map.html",
        "temporary-map-mobile.html",
      ].sort(),
    );
  });
  it.each(["marker", "shape"] as const)(
    "uses only the shared title, body and destination for a read-only %s popup",
    (kind) => {
      const f = fixture({
        loadBody: undefined,
        showGoogleMapLink: true,
        desktopHeightLimit: "all",
        getMarkerRecord: () => ({ latitude: 36, longitude: 140 }),
      });
      f.open(kind);
      const root = f.host.querySelector(".geocode-content-popup")!;
      expect(root.classList.contains("popup-content-height-limited")).toBe(true);
      expect(root.querySelector(".popup-content-title")?.textContent).toBe("<対象>");
      expect(root.querySelector(".popup-content-note")?.textContent).toBe("");
      expect(root.querySelector(".popup-content-body")?.textContent).toBe("自由\n登録");
      expect(root.querySelector(".popup-content-toolbar select")).toBeNull();
      const link = root.querySelector<HTMLAnchorElement>(".popup-content-google-link")!;
      expect(new URL(link.href).searchParams.get("query")).toBe(
        kind === "marker" ? "36,140" : "35.5,139.5",
      );
      expect(f.setupImages).toHaveBeenCalledOnce();
      expect(f.loadBody).not.toHaveBeenCalled();
    },
  );
  it.each(["marker", "shape"] as const)(
    "%s defaults to normal and separates Markdown without changing stored content",
    async (kind) => {
      const f = fixture();
      f.open(kind);
      await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
      expect(f.select().value).toBe("normal");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n登録");
      f.choose("free");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n");
      f.choose("answers");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("登録");
      expect(f.host.querySelector("h1")!.textContent).toBe("<対象>");
      expect(f.setupImages).toHaveBeenCalled();
      f.handlers.popupclose({ popup: f.popup });
      f.open(kind);
      await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
      expect(f.select().value).toBe("normal");
      expect(f.loadBody).toHaveBeenCalledTimes(1);
    },
  );
  it("retains the analysis header for every mode and uses frozen print data without requests", async () => {
    const f = fixture({
      answerMap: true,
      snapshot: {
        "shape:same": { free_text: "自由", managed_markdown: "登録", sync_required: false },
      },
    });
    f.runtime.setAnalysis("shape:same", "<strong>分析値</strong>");
    f.open("shape");
    const analysisText = () =>
      f.host.querySelector(".popup-content-analysis .geocode-content-body")?.textContent;
    await vi.waitFor(() => expect(analysisText()).toBe("分析値"));
    for (const mode of ["free", "answers", "normal"]) {
      f.choose(mode);
      expect(analysisText()).toBe("分析値");
    }
    f.choose("answers");
    expect(f.host.querySelector(".popup-content-note")!.textContent).toContain("すべて");
    expect(f.loadBody).not.toHaveBeenCalled();
  });
  it("shows explicit empty messages and sanitizes Markdown and print analysis", () => {
    const f = fixture({
      snapshot: {
        "marker:same": {
          free_text: "",
          managed_markdown: "<script>alert(1)</script>",
          sync_required: false,
        },
      },
      analysis: { "marker:same": "<img src=x onerror=alert(1)>" },
    });
    f.open();
    f.choose("free");
    expect(f.host.textContent).toContain("自由入力の内容はありません");
    f.choose("answers");
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.host.querySelector("[onerror]")).toBeNull();
  });
  it.each(["ambiguous", "failed", "stale", "missing"])(
    "keeps normal content when %s",
    async (mode) => {
      const f = fixture({
        loadBody: async () => {
          if (mode === "failed") throw Error("network");
          if (mode === "missing") return {};
          return {
            body: mode === "stale" ? "変更後" : "自由\n登録",
            free_text: "自由",
            managed_markdown: "登録",
            sync_required: mode === "ambiguous",
          };
        },
      });
      f.open();
      await vi.waitFor(() =>
        expect(f.host.querySelector(".popup-content-note")!.textContent).not.toContain(
          "確認しています",
        ),
      );
      expect(f.select().options[0].disabled).toBe(true);
      expect(f.select().value).toBe("normal");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n登録");
    },
  );
  it("does not overwrite a newer popup after an old request resolves", async () => {
    let resolve!: (value: any) => void;
    const f = fixture({
      loadBody: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    f.open();
    f.handlers.popupclose({ popup: f.popup });
    f.host.innerHTML = "別のポップアップ";
    resolve({
      body: "自由\n登録",
      free_text: "自由",
      managed_markdown: "登録",
      sync_required: false,
    });
    await Promise.resolve();
    expect(f.host.innerHTML).toBe("別のポップアップ");
  });
});
