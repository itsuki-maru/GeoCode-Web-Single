import Panzoom from "@panzoom/panzoom";

import { requireElement } from "../dom";

export function initializeImagePreview(): void {
  const closeButton = requireElement("#close-tab", HTMLElement);
  const panzoomElement = requireElement("#panzoom-element", HTMLElement);
  const panzoomParent = panzoomElement.parentElement;

  if (!panzoomParent) {
    throw new Error("Panzoom parent element was not found");
  }

  closeButton.addEventListener("click", () => {
    window.parent.postMessage(
      { type: "callParentImagePreview", message: "" },
      "*",
    );
  });

  const panzoom = Panzoom(panzoomElement, {
    contain: "outside",
    maxScale: 5,
    minScale: 1,
  });

  panzoomParent.addEventListener("wheel", panzoom.zoomWithWheel);
}

initializeImagePreview();
