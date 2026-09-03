import { beforeEach, describe, expect, it, vi } from "vitest";

const zoomWithWheel = vi.fn();
const panzoom = vi.fn(() => ({ zoomWithWheel }));

vi.mock("@panzoom/panzoom", () => ({ default: panzoom }));

describe("image preview entry", () => {
  beforeEach(() => {
    vi.resetModules();
    panzoom.mockClear();
    zoomWithWheel.mockClear();
    document.body.innerHTML = `
      <div id="image-container">
        <div id="panzoom-element"></div>
        <button id="close-tab" type="button">閉じる</button>
      </div>
    `;
  });

  it("initializes panzoom and notifies its parent when closed", async () => {
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    await import("../src/entries/image-preview");

    expect(panzoom).toHaveBeenCalledOnce();
    document.querySelector<HTMLElement>("#close-tab")!.click();
    expect(postMessage).toHaveBeenCalledWith(
      { type: "callParentImagePreview", message: "" },
      "*",
    );
  });
});
