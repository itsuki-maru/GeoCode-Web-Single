import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraUrl, installMjpegCameras, renderCameraImage } from "../src/map/common/mjpeg-camera";
import { setupDetailsLazyImages } from "../src/map/common/content";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function fixture(
  content = renderCameraImage({ href: "https://camera.test/stream?a=1&b=2", text: "camera" })!,
) {
  const listeners = new Map<string, Function>();
  const map = {
    on: (name: string, fn: Function) => listeners.set(name, fn),
    off: (name: string) => listeners.delete(name),
  };
  const popup = document.createElement("div");
  popup.className = "leaflet-popup";
  popup.innerHTML = content;
  document.body.append(popup);
  cleanups.push(installMjpegCameras(map));
  const emit = (name: string) => listeners.get(name)?.({ popup: { getElement: () => popup } });
  return { popup, emit, listeners };
}

describe("MJPEG camera rendering", () => {
  it("creates an inert escaped marker without thumbnail or preview URLs", () => {
    const html = renderCameraImage({ href: 'https://camera.test/stream?x="<>&', text: "camera" })!;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    expect(wrapper.querySelector("img")).toBeNull();
    expect(wrapper.firstElementChild?.getAttribute("data-camera-src")).toBe(
      'https://camera.test/stream?x="<>&',
    );
    expect(html).not.toContain("thumb=true");
    expect(html).not.toContain("marker-preview-image");
    expect(renderCameraImage({ href: "/photo.jpg", text: "photo" })).toBeNull();
  });
  it("blocks unsafe URLs even when supplied via raw custom HTML", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:image/png,xx",
      "ftp://camera/stream",
      "http://u:p@camera/stream",
      "/stream",
      "https://u:p@camera/stream",
      "https:\\camera/stream",
      "https://cam\nera/stream",
    ]) {
      expect(cameraUrl(url)).toBeNull();
    }
    const { popup, emit } = fixture(
      '<app-camera data-camera-src="javascript:alert(1)"></app-camera>',
    );
    emit("popupopen");
    expect(popup.querySelector("img")).toBeNull();
  });
  it("renders only a placeholder in the print/PDF document", () => {
    const html = renderCameraImage({ href: "https://camera/stream", text: "camera" }, true)!;
    expect(html).toContain("印刷には映像を含みません");
    expect(html).not.toContain("app-camera");
    expect(html).not.toContain("https:");
  });
});

describe("MJPEG lifecycle", () => {
  it.each(["http://192.168.1.20:8080/stream", "http://raspberrypi.local/stream"])(
    "loads a LAN HTTP stream without rewriting the URL: %s",
    (url) => {
      expect(cameraUrl(url)).toBe(url);
      const { popup, emit } = fixture(renderCameraImage({ href: url, text: "camera" })!);
      expect(popup.querySelector("img")).toBeNull();
      emit("popupopen");
      const image = popup.querySelector("img")!;
      expect(image.getAttribute("src")).toBe(url);
      emit("popupclose");
      expect(image.hasAttribute("src")).toBe(false);
    },
  );
  it("opens one connection only on popupopen and cancels immediately on close, then reconnects", async () => {
    const { popup, emit } = fixture();
    await settle();
    expect(popup.querySelector("img")).toBeNull();
    emit("popupopen");
    const image = popup.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("https://camera.test/stream?a=1&b=2");
    emit("popupopen");
    await settle();
    expect(popup.querySelectorAll("img")).toHaveLength(1);
    expect(popup.querySelector("img")).toBe(image);
    emit("popupclose");
    expect(image.getAttribute("src")).toBeNull();
    expect(popup.querySelector("img")).toBeNull();
    await settle(); // Leaflet may keep a closed popup in the DOM during fade-out.
    expect(popup.querySelector("img")).toBeNull();
    emit("popupopen");
    expect(popup.querySelector("img")).not.toBe(image);
  });
  it("cancels detached popups even without a close event", async () => {
    const { popup, emit } = fixture();
    emit("popupopen");
    const image = popup.querySelector("img")!;
    popup.remove();
    await settle();
    expect(image.getAttribute("src")).toBeNull();
  });
  it("respects all nested details and does not conflict with image lazy loading", async () => {
    const html = renderCameraImage({ href: "https://camera/stream", text: "camera" });
    const { popup, emit } = fixture(
      `<details class="details"><details class="details">${html}</details></details>`,
    );
    emit("popupopen");
    const details = popup.querySelectorAll("details");
    details[1]!.open = true;
    await settle();
    expect(popup.querySelector("img")).toBeNull();
    details[0]!.open = true;
    await settle();
    const image = popup.querySelector("img")!;
    setupDetailsLazyImages(popup);
    expect(image.hasAttribute("src")).toBe(true);
    expect(image.hasAttribute("data-src")).toBe(false);
    details[0]!.open = false;
    await settle();
    expect(image.hasAttribute("src")).toBe(false);
  });
  it("stops in background and during print, and resumes only an open popup", () => {
    const { popup, emit } = fixture();
    emit("popupopen");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(popup.querySelector("img")).toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(popup.querySelector("img")).not.toBeNull();
    window.dispatchEvent(new Event("beforeprint"));
    expect(popup.querySelector("img")).toBeNull();
    emit("popupclose");
    window.dispatchEvent(new Event("afterprint"));
    expect(popup.querySelector("img")).toBeNull();
  });
  it("supports error/manual retry and cancels old requests without cache-busting the URL", async () => {
    const { popup, emit } = fixture();
    emit("popupopen");
    const first = popup.querySelector("img")!;
    first.dispatchEvent(new Event("error"));
    await settle();
    expect(popup.textContent).toContain("映像を取得できません");
    expect(popup.querySelector("img")).toBeNull();
    popup.querySelector("button")!.click();
    const second = popup.querySelector("img")!;
    expect(second.src).toBe("https://camera.test/stream?a=1&b=2");
    popup.querySelector("button")!.click();
    expect(second.hasAttribute("src")).toBe(false);
    expect(popup.querySelectorAll("img")).toHaveLength(1);
  });
  it("handles pagehide/bfcache restore and unload cleanup", () => {
    const { popup, emit, listeners } = fixture();
    emit("popupopen");
    window.dispatchEvent(new Event("pagehide"));
    expect(popup.querySelector("img")).toBeNull();
    window.dispatchEvent(new Event("pageshow"));
    expect(popup.querySelector("img")).not.toBeNull();
    emit("unload");
    expect(popup.querySelector("img")).toBeNull();
    expect(listeners.size).toBe(0);
  });
});
