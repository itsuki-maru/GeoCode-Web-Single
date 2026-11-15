import { afterEach, describe, expect, it, vi } from "vitest";
import { installMarkerPopupHeightLimit, updatePopupLayout } from "../src/map/common/popup-layout";

function fixture() {
  const root = document.createElement("div");
  root.className = "leaflet-popup";
  const outer = document.createElement("div");
  outer.className = "leaflet-popup-content";
  const content = document.createElement("div");
  content.className = "geocode-content-popup";
  content.innerHTML = '<div class="md-detail-contents"><button>さらに読み込む</button></div>';
  outer.append(content);
  root.append(outer);
  document.body.append(root);
  let current: unknown = content;
  let width = 420;
  let height = 560;
  const rect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  });
  vi.spyOn(content, "getBoundingClientRect").mockImplementation(rect);
  const popup = { getElement: () => root, getContent: () => current, update: vi.fn() };
  return {
    root,
    outer,
    content,
    popup,
    rect,
    setContent: (value: unknown) => {
      current = value;
    },
    setSize: (nextWidth: number, nextHeight: number) => {
      width = nextWidth;
      height = nextHeight;
    },
  };
}

function heightMapFixture() {
  const container = document.createElement("div");
  document.body.append(container);
  let height = 610;
  Object.defineProperty(container, "clientHeight", { get: () => height });
  type Listener = Parameters<Parameters<typeof installMarkerPopupHeightLimit>[0]["on"]>[1];
  const listeners = new Map<string, Set<Listener>>();
  const on = vi.fn((event: string, listener: Listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
  });
  const off = vi.fn((event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener);
  });
  return {
    container,
    listeners,
    map: { getContainer: () => container, on, off },
    setHeight: (value: number) => {
      height = value;
    },
    emit: (event: string, popup?: Parameters<Listener>[0]["popup"]) => {
      for (const listener of [...(listeners.get(event) || [])]) listener({ popup });
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("popup layout measurements", () => {
  it("measures a live pinned node once and skips repeated updates when its geometry is unchanged", () => {
    const f = fixture();
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(1);
    f.content.querySelector(".md-detail-contents")!.append(document.createElement("p"));
    updatePopupLayout(f.popup);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(1);
  });

  it("can remeasure unchanged content when its map viewport has changed", () => {
    const f = fixture();
    updatePopupLayout(f.popup);
    updatePopupLayout(f.popup, undefined, { force: true });
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
  });

  it("updates again when either the pinned content width or height changes", () => {
    const f = fixture();
    updatePopupLayout(f.popup);
    f.setSize(460, 560);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    f.setSize(460, 600);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(3);
  });

  it("remembers geometry measured after the update has applied its constraints", () => {
    const f = fixture();
    f.popup.update.mockImplementation(() => f.setSize(400, 500));
    updatePopupLayout(f.popup);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(1);
  });

  it("remeasures wider intrinsic content even when the current constrained rectangle stays the same", () => {
    const f = fixture();
    let scrollWidth = 420;
    Object.defineProperty(f.content, "scrollWidth", { configurable: true, get: () => scrollWidth });
    updatePopupLayout(f.popup);
    scrollWidth = 840;
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
  });

  it("remeasures an existing content node moved to another Leaflet content parent", () => {
    const f = fixture();
    updatePopupLayout(f.popup);
    const nextOuter = document.createElement("div");
    nextOuter.className = "leaflet-popup-content";
    f.root.append(nextOuter);
    nextOuter.append(f.content);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
  });

  it("remeasures replacement content even when its measured size is identical", () => {
    const f = fixture();
    updatePopupLayout(f.popup);
    const replacement = document.createElement("div");
    vi.spyOn(replacement, "getBoundingClientRect").mockImplementation(f.rect);
    f.outer.replaceChildren(replacement);
    f.setContent(replacement);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
  });

  it("always updates string content instead of caching its current rendered DOM", () => {
    const f = fixture();
    f.setContent("<p>string content</p>");
    updatePopupLayout(f.popup);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
  });

  it.each(["extra sibling", "wrong parent", "detached node"])(
    "does not skip updates for an unpinned node: %s",
    (condition) => {
      const f = fixture();
      if (condition === "extra sibling") f.outer.append(document.createTextNode("\n"));
      if (condition === "wrong parent") f.outer.className = "other-container";
      if (condition === "detached node") f.content.remove();
      updatePopupLayout(f.popup);
      updatePopupLayout(f.popup);
      expect(f.popup.update).toHaveBeenCalledTimes(2);
    },
  );

  it("updates without a root and supports a supplied fallback root", () => {
    const update = vi.fn();
    updatePopupLayout({ update });
    expect(update).toHaveBeenCalledTimes(1);
    const f = fixture();
    updatePopupLayout({ getContent: f.popup.getContent, update }, f.root);
    updatePopupLayout({ getContent: f.popup.getContent, update }, f.root);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("preserves scroll and focus after necessary updates and leaves them untouched when skipped", () => {
    const f = fixture();
    const inner = f.content.querySelector<HTMLElement>(".md-detail-contents")!;
    const button = f.content.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    const reset = () => {
      f.outer.scrollTop = f.outer.scrollLeft = inner.scrollTop = inner.scrollLeft = 0;
    };
    const focus = vi.spyOn(button, "focus").mockImplementation((options) => {
      HTMLElement.prototype.focus.call(button, options);
      reset();
    });
    f.popup.update.mockImplementation(() => {
      f.content.remove();
      f.outer.append(f.content);
      reset();
    });
    f.outer.scrollTop = 120;
    f.outer.scrollLeft = 8;
    inner.scrollTop = 450;
    inner.scrollLeft = 14;
    updatePopupLayout(f.popup);
    expect([f.outer.scrollTop, f.outer.scrollLeft, inner.scrollTop, inner.scrollLeft]).toEqual([
      120, 8, 450, 14,
    ]);
    expect(document.activeElement).toBe(button);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    f.outer.scrollTop = 240;
    inner.scrollTop = 900;
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect([f.outer.scrollTop, inner.scrollTop]).toEqual([240, 900]);
    f.setSize(420, 600);
    updatePopupLayout(f.popup);
    expect(f.popup.update).toHaveBeenCalledTimes(2);
    expect([f.outer.scrollTop, f.outer.scrollLeft, inner.scrollTop, inner.scrollLeft]).toEqual([
      240, 8, 900, 14,
    ]);
    expect(document.activeElement).toBe(button);
  });
});

describe("PC marker popup height limit", () => {
  it("sets the actual map height before a popup is opened and follows map resizing", () => {
    const f = heightMapFixture();
    installMarkerPopupHeightLimit(f.map);
    expect(f.container.classList.contains("pc-map-popup-height")).toBe(true);
    expect(f.container.style.getPropertyValue("--geocode-popup-map-height")).toBe("610px");
    f.setHeight(997);
    f.emit("resize");
    expect(f.container.style.getPropertyValue("--geocode-popup-map-height")).toBe("997px");
  });

  it("repositions an open marker on resize even when its capped geometry is unchanged", () => {
    const f = heightMapFixture();
    const p = fixture();
    p.content.dataset.contentKey = "marker:one";
    installMarkerPopupHeightLimit(f.map);
    updatePopupLayout(p.popup);
    f.emit("popupopen", p.popup);
    f.setHeight(800);
    f.emit("resize");
    expect(p.popup.update).toHaveBeenCalledTimes(2);
    f.emit("popupclose", { getElement: () => document.createElement("div") });
    f.emit("resize");
    expect(p.popup.update).toHaveBeenCalledTimes(3);
    f.emit("popupclose", p.popup);
    f.emit("resize");
    expect(p.popup.update).toHaveBeenCalledTimes(3);
  });

  it.each(["shape:one", "", "unrelated"])(
    "does not reposition a popup outside the marker scope: %s",
    (key) => {
      const f = heightMapFixture();
      const p = fixture();
      if (key) p.content.dataset.contentKey = key;
      installMarkerPopupHeightLimit(f.map);
      f.emit("popupopen", p.popup);
      f.emit("resize");
      expect(p.popup.update).not.toHaveBeenCalled();
    },
  );

  it.each(["shape:one", ""])(
    "keeps tracking a marker while another popup is open and after it closes: %s",
    (key) => {
      const f = heightMapFixture();
      const marker = fixture();
      marker.content.dataset.contentKey = "marker:one";
      const other = fixture();
      if (key) other.content.dataset.contentKey = key;
      else other.content.className = "shape-name-editor";
      installMarkerPopupHeightLimit(f.map);
      f.emit("popupopen", marker.popup);
      f.emit("popupopen", other.popup);
      f.emit("resize");
      expect(marker.popup.update).toHaveBeenCalledTimes(1);
      expect(other.popup.update).not.toHaveBeenCalled();
      f.emit("popupclose", other.popup);
      f.emit("resize");
      expect(marker.popup.update).toHaveBeenCalledTimes(2);
      expect(other.popup.update).not.toHaveBeenCalled();
      f.emit("popupclose", marker.popup);
      f.emit("resize");
      expect(marker.popup.update).toHaveBeenCalledTimes(2);
    },
  );

  it("retains reading position and focus through resize layout updates", () => {
    const f = heightMapFixture();
    const p = fixture();
    p.content.dataset.contentKey = "marker:one";
    const body = p.content.querySelector<HTMLElement>(".md-detail-contents")!;
    const button = body.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    body.scrollTop = 240;
    p.outer.scrollTop = 30;
    p.content.scrollTop = 60;
    p.content.scrollLeft = 12;
    p.popup.update.mockImplementation(() => {
      p.content.remove();
      p.outer.append(p.content);
      body.scrollTop = p.outer.scrollTop = p.content.scrollTop = p.content.scrollLeft = 0;
    });
    installMarkerPopupHeightLimit(f.map);
    f.emit("popupopen", p.popup);
    f.setHeight(450);
    f.emit("resize");
    expect(body.scrollTop).toBe(240);
    expect(p.outer.scrollTop).toBe(30);
    expect(p.content.scrollTop).toBe(60);
    expect(p.content.scrollLeft).toBe(12);
    expect(document.activeElement).toBe(button);
  });

  it("removes its listeners and newly installed styles when the map unloads", () => {
    const f = heightMapFixture();
    const p = fixture();
    p.content.dataset.contentKey = "marker:one";
    const dispose = installMarkerPopupHeightLimit(f.map);
    f.emit("popupopen", p.popup);
    f.emit("unload");
    expect(f.container.classList.contains("pc-map-popup-height")).toBe(false);
    expect(f.container.style.getPropertyValue("--geocode-popup-map-height")).toBe("");
    expect([...f.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(f.map.off).toHaveBeenCalledTimes(4);
    f.emit("resize");
    expect(p.popup.update).not.toHaveBeenCalled();
    dispose();
    expect(f.map.off).toHaveBeenCalledTimes(4);
  });

  it("restores a pre-existing height declaration and keeps a pre-existing scope class", () => {
    const f = heightMapFixture();
    f.container.classList.add("pc-map-popup-height");
    f.container.style.setProperty("--geocode-popup-map-height", "400px", "important");
    const dispose = installMarkerPopupHeightLimit(f.map);
    dispose();
    expect(f.container.classList.contains("pc-map-popup-height")).toBe(true);
    expect(f.container.style.getPropertyValue("--geocode-popup-map-height")).toBe("400px");
    expect(f.container.style.getPropertyPriority("--geocode-popup-map-height")).toBe("important");
  });
});
