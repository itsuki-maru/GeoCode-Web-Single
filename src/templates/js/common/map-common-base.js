// Shared map helpers used by map and temporary map templates.

// This file is intentionally non-module so existing inline template scripts can use globals.

function createLayerBulkToggleControl({
  map,
  overlayLayers,
  position = "topright",
}) {
  const targetLayers = Array.isArray(overlayLayers)
    ? overlayLayers.filter(Boolean)
    : [];

  const LayerBulkToggleControl = L.Control.extend({
    options: {
      position,
    },
    onAdd: function () {
      const container = L.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control layer-bulk-toggle-control",
      );
      const button = L.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      );
      button.type = "button";

      const hasVisibleLayer = () =>
        targetLayers.some((layer) => map.hasLayer(layer));

      const updateButtonState = () => {
        const shouldClear = hasVisibleLayer();
        button.textContent = shouldClear ? "全解除" : "全選択";
        button.setAttribute("aria-label", button.textContent);
      };

      const toggleAllLayers = () => {
        const shouldClear = hasVisibleLayer();
        targetLayers.forEach((layer) => {
          if (shouldClear) {
            if (map.hasLayer(layer)) {
              map.removeLayer(layer);
            }
            return;
          }

          if (!map.hasLayer(layer)) {
            map.addLayer(layer);
          }
        });
        updateButtonState();
      };

      L.DomEvent.on(button, "click", (event) => {
        L.DomEvent.stop(event);
        toggleAllLayers();
      });

      map.on("overlayadd overlayremove", (event) => {
        if (!targetLayers.includes(event.layer)) {
          return;
        }
        updateButtonState();
      });

      L.DomEvent.disableClickPropagation(container);
      if (L.DomEvent.disableScrollPropagation) {
        L.DomEvent.disableScrollPropagation(container);
      }
      updateButtonState();
      return container;
    },
  });

  return new LayerBulkToggleControl();
}
function extractYouTubeId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const allowYouTubeList = [
      "www.youtube.com",
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtube-nocookie.com",
    ];
    if (!allowYouTubeList.includes(host)) return null;

    // shorts / watch / youtu.be に対応
    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return ID_RE.test(id) ? id : null;
    }
    if (url.pathname.startsWith("/shorts/")) {
      const id = url.pathname.split("/")[2] ?? "";
      return ID_RE.test(id) ? id : null;
    }
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v") ?? "";
      return ID_RE.test(id) ? id : null;
    }
    if (url.pathname.startsWith("/embed/")) {
      const id = url.pathname.split("/")[2] ?? "";
      return ID_RE.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

