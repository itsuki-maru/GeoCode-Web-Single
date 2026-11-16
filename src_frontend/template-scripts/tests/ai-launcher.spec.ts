import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiLauncherStorageKey, createAiLauncher } from "../src/ai/launcher";

const launchers: ReturnType<typeof createAiLauncher>[] = [];
const viewport = (width = 1000, height = 800) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
};
const make = (mode: "desktop" | "mobile" | "standalone" = "desktop") => {
  const onActivate = vi.fn();
  const launcher = createAiLauncher({ mode, iconUrl: "/assets/ai_assistant.png", onActivate });
  launchers.push(launcher);
  return { ...launcher, onActivate };
};
const point = (element: HTMLElement) => ({
  x: Number.parseFloat(element.style.left),
  y: Number.parseFloat(element.style.top),
});
const pointer = (target: EventTarget, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  target.dispatchEvent(event);
};
beforeEach(() => {
  viewport();
  localStorage.clear();
});
afterEach(() => {
  for (const launcher of launchers.splice(0)) launcher.dispose();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("starts hidden and places the desktop icon above the table toggle with the supplied icon", () => {
  const anchor = document.createElement("button");
  anchor.className = "map-object-table-toggle";
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 700, 80, 40));
  document.body.append(anchor);
  const launcher = make();
  expect(launcher.element.hidden).toBe(true);
  expect(point(launcher.element)).toEqual({ x: 903, y: 613 });
  expect(launcher.element.querySelector("img")!.draggable).toBe(false);
  expect(launcher.element.querySelector("img")!.getAttribute("src")).toBe(
    "/assets/ai_assistant.png",
  );
});

it("avoids mobile bottom controls and uses a separate position for standalone maps", () => {
  const row = document.createElement("div");
  row.id = "search-area";
  const control = document.createElement("button");
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 720, 1000, 50));
  row.append(control);
  document.body.append(row);
  expect(point(make("mobile").element)).toEqual({ x: 911, y: 633 });
  expect(point(make("standalone").element)).toEqual({ x: 911, y: 633 });
  expect(aiLauncherStorageKey("mobile")).not.toBe(aiLauncherStorageKey("desktop"));
});

it("only activates while enabled and prevents launch events from reaching the map", () => {
  const launcher = make();
  const background = vi.fn();
  document.body.addEventListener("click", background);
  launcher.element.click();
  expect(launcher.onActivate).not.toHaveBeenCalled();
  launcher.setEnabled(true);
  launcher.element.click();
  expect(launcher.onActivate).toHaveBeenCalledWith(launcher.element);
  expect(background).not.toHaveBeenCalled();
  launcher.setEnabled(false);
  launcher.element.click();
  expect(launcher.element.hidden).toBe(true);
  expect(launcher.onActivate).toHaveBeenCalledTimes(1);
  document.body.removeEventListener("click", background);
});

it("distinguishes clicks from drags, saves only a completed drag and suppresses its click", () => {
  const launcher = make("standalone");
  launcher.setEnabled(true);
  pointer(launcher.element, "pointerdown", 950, 750);
  pointer(window, "pointermove", 952, 752);
  pointer(window, "pointerup", 952, 752);
  launcher.element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  expect(launcher.onActivate).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(aiLauncherStorageKey("standalone"))).toBeNull();

  pointer(launcher.element, "pointerdown", 950, 750);
  pointer(window, "pointermove", 850, 650);
  expect(localStorage.getItem(aiLauncherStorageKey("standalone"))).toBeNull();
  pointer(window, "pointerup", 850, 650);
  expect(point(launcher.element)).toEqual({ x: 811, y: 611 });
  expect(JSON.parse(localStorage.getItem(aiLauncherStorageKey("standalone"))!)).toEqual({
    x: 811,
    y: 611,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  launcher.element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  expect(launcher.onActivate).toHaveBeenCalledTimes(1);
  launcher.element.click(); // Native keyboard activation has detail=0.
  expect(launcher.onActivate).toHaveBeenCalledTimes(2);
});

it("clamps on resize without overwriting the user's saved position", () => {
  const saved = JSON.stringify({ x: 900, y: 700, viewportWidth: 1000, viewportHeight: 800 });
  localStorage.setItem(aiLauncherStorageKey("desktop"), saved);
  const launcher = make();
  expect(point(launcher.element)).toEqual({ x: 900, y: 700 });
  viewport(500, 400);
  window.dispatchEvent(new Event("resize"));
  expect(point(launcher.element)).toEqual({ x: 411, y: 311 });
  expect(localStorage.getItem(aiLauncherStorageKey("desktop"))).toBe(saved);
  viewport();
  window.dispatchEvent(new Event("orientationchange"));
  expect(point(launcher.element)).toEqual({ x: 900, y: 700 });
});

it.each(["desktop", "mobile"] as const)(
  "moves away from %s controls after dragging, restoring and resizing",
  (mode) => {
    const row = document.createElement("div");
    row.id = "search-area";
    const control = document.createElement("button");
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 600, 60, 60));
    row.append(control);
    document.body.append(row);
    localStorage.setItem(
      aiLauncherStorageKey(mode),
      JSON.stringify({ x: 610, y: 610, viewportWidth: 1000, viewportHeight: 800 }),
    );
    const launcher = make(mode);
    expect(point(launcher.element)).toEqual({ x: 670, y: 610 });
    launcher.setEnabled(true);
    const start = point(launcher.element);
    pointer(launcher.element, "pointerdown", start.x + 10, start.y + 10);
    pointer(window, "pointermove", 620, 620);
    expect(point(launcher.element)).toEqual({ x: 610, y: 610 });
    pointer(window, "pointerup", 620, 620);
    expect(point(launcher.element)).toEqual({ x: 670, y: 610 });
    const saved = localStorage.getItem(aiLauncherStorageKey(mode));
    expect(JSON.parse(saved!).x).toBe(670);
    launcher.dispose();

    const restored = make(mode);
    expect(point(restored.element)).toEqual({ x: 670, y: 610 });
    viewport(700, 700);
    window.dispatchEvent(new Event("resize"));
    expect(point(restored.element)).toEqual({ x: 611, y: 513 });
    expect(localStorage.getItem(aiLauncherStorageKey(mode))).toBe(saved);
    viewport();
    window.dispatchEvent(new Event("resize"));
    expect(point(restored.element)).toEqual({ x: 670, y: 610 });
  },
);

it("ignores hidden or clipped controls and the empty space of large toolbar parents", () => {
  const toolbar = document.createElement("div");
  toolbar.className = "header-btn-zone";
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
  const visible = document.createElement("button");
  vi.spyOn(visible, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 12, 40, 40));
  const hidden = document.createElement("button");
  hidden.style.display = "none";
  vi.spyOn(hidden, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 650, 100, 150));
  const clip = document.createElement("div");
  clip.style.overflowX = "hidden";
  vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 800));
  const clipped = document.createElement("button");
  vi.spyOn(clipped, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 650, 100, 150));
  clip.append(clipped);
  toolbar.append(visible, hidden, clip);
  document.body.append(toolbar);
  expect(point(make().element)).toEqual({ x: 911, y: 647 });
});

it("uses a bounded fallback when the viewport has no free space and recovers when enlarged", () => {
  viewport(100, 100);
  const row = document.createElement("div");
  row.id = "search-area";
  const control = document.createElement("button");
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  row.append(control);
  document.body.append(row);
  const launcher = make("mobile");
  launcher.setEnabled(true);
  expect(point(launcher.element)).toEqual({ x: 11.5, y: 11.5 });
  expect(point(launcher.element).x + 77).toBeLessThanOrEqual(100);
  expect(point(launcher.element).y + 77).toBeLessThanOrEqual(100);
  viewport();
  window.dispatchEvent(new Event("resize"));
  expect(point(launcher.element)).toEqual({ x: 911, y: 711 });
});

it("scales restored coordinates to a changed viewport and rejects corrupt stored data", () => {
  localStorage.setItem(
    aiLauncherStorageKey("mobile"),
    JSON.stringify({
      x: 800,
      y: 600,
      viewportWidth: 2000,
      viewportHeight: 1600,
    }),
  );
  expect(point(make("mobile").element)).toEqual({ x: 400, y: 300 });
  localStorage.setItem(aiLauncherStorageKey("desktop"), '{"x":"900","y":700}');
  expect(point(make().element)).toEqual({ x: 911, y: 647 });
});

it("cancels unfinished drags and works when local storage is denied", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("denied");
  });
  const launcher = make("standalone");
  launcher.setEnabled(true);
  pointer(launcher.element, "pointerdown", 950, 750);
  pointer(window, "pointermove", 850, 650);
  pointer(window, "pointercancel", 850, 650);
  expect(point(launcher.element)).toEqual({ x: 911, y: 711 });
  pointer(launcher.element, "pointerdown", 950, 750);
  pointer(window, "pointermove", 850, 650);
  expect(() => pointer(window, "pointerup", 850, 650)).not.toThrow();
  launcher.element.click();
  expect(launcher.onActivate).toHaveBeenCalledTimes(1);
});

it("removes its DOM and global listeners on disposal and supports remounting", () => {
  const launcher = make();
  launcher.setEnabled(true);
  launcher.dispose();
  const before = point(launcher.element);
  viewport(300, 400);
  window.dispatchEvent(new Event("resize"));
  launcher.element.click();
  expect(point(launcher.element)).toEqual(before);
  expect(launcher.onActivate).not.toHaveBeenCalled();
  expect(document.querySelector(".ai-launcher")).toBeNull();
  expect(document.querySelector(".ai-launcher-safe-area")).toBeNull();
  const remounted = make();
  remounted.setEnabled(true);
  expect(document.querySelectorAll(".ai-launcher")).toHaveLength(1);
});
