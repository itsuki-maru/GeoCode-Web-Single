import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMapContentActions,
  resolveSameOriginContentUrl,
} from "../src/map/common/content-actions";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  cleanupCallbacks.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
});

describe("map common content actions", () => {
  it("resolves only non-empty same-origin URLs", () => {
    const origin = "https://example.test";

    expect(
      resolveSameOriginContentUrl("/static/images/map.png", origin)?.pathname,
    ).toBe("/static/images/map.png");
    expect(
      resolveSameOriginContentUrl(
        "https://example.test/images/html/info.html",
        origin,
      )?.pathname,
    ).toBe("/images/html/info.html");
    expect(
      resolveSameOriginContentUrl("https://attacker.example/map.png", origin),
    ).toBeNull();
    expect(resolveSameOriginContentUrl(42, origin)).toBeNull();
  });

  it("previews only approved same-origin image paths", () => {
    document.body.innerHTML = `
      <img id="allowed" class="marker-preview-image" data-preview-src="/static/images/photo.png?size=full#image">
      <img id="blocked-path" class="marker-preview-image" data-preview-src="/private/photo.png">
      <img id="blocked-origin" class="marker-preview-image" data-preview-src="https://attacker.example/static/images/photo.png">
    `;
    const previewImage = vi.fn();
    cleanupCallbacks.push(
      installMapContentActions({
        origin: "https://example.test",
        previewImage,
      }),
    );

    click("allowed");
    click("blocked-path");
    click("blocked-origin");

    expect(previewImage).toHaveBeenCalledExactlyOnceWith(
      "/static/images/photo.png?size=full#image",
    );
  });

  it("delegates same-origin downloads and prevents navigation", () => {
    document.body.innerHTML = `
      <a id="allowed" class="markdown-download-link" data-download-href="/static/images/document.pdf?download=1">Download</a>
      <a id="blocked" class="markdown-download-link" data-download-href="https://attacker.example/document.pdf">Blocked</a>
    `;
    const downloadFile = vi.fn();
    cleanupCallbacks.push(
      installMapContentActions({
        downloadFile,
        origin: "https://example.test",
      }),
    );

    const allowedEvent = click("allowed");
    const blockedEvent = click("blocked");

    expect(allowedEvent.defaultPrevented).toBe(true);
    expect(blockedEvent.defaultPrevented).toBe(true);
    expect(downloadFile).toHaveBeenCalledExactlyOnceWith(
      "/static/images/document.pdf?download=1",
    );
  });

  it("handles clicks from descendants through event delegation", () => {
    document.body.innerHTML = `
      <a class="markdown-download-link" data-download-href="/document.pdf"><span id="child">Download</span></a>
    `;
    const downloadFile = vi.fn();
    cleanupCallbacks.push(
      installMapContentActions({
        downloadFile,
        origin: "https://example.test",
      }),
    );

    click("child");
    expect(downloadFile).toHaveBeenCalledWith("/document.pdf");
  });
});

function click(elementId: string): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(elementId)?.dispatchEvent(event);
  return event;
}
