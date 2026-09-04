// @ts-nocheck -- Leaflet is provided as a browser global by the server template.
import {
  createCollapsibleLayerControl,
  createCurrentLocationControl,
  createNameVisibilityControl,
  focusSharedLocation,
} from "../live-map/controls";

export {};
type LivePosition = {
  id: string;
  display_name: string;
  marker_color: string;
  status: "live" | "stale" | "offline";
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  heading_deg: number | null;
  speed_mps: number | null;
  observed_at: string | null;
  received_at: string | null;
};

const bootstrap = window.__GEOCODE_LIVE_MAP_BOOTSTRAP__;
const map = L.map("map").setView([39.2, 138.5], 6);
const tileServers = bootstrap.tileServers as Record<string, any>;
const tileServerEntries = Object.entries(tileServers);
const defaultTileServerId = tileServers["1"] ? "1" : tileServerEntries[0]?.[0];
const japanBounds = L.latLngBounds(
  L.latLng(20.25, 122.56),
  L.latLng(45.55, 153.59),
);
let tileLayer: any = null;

function selectTileServer(tileServerId: string): void {
  const tileServer = tileServers[tileServerId];
  if (!tileServer) return;
  if (tileLayer) map.removeLayer(tileLayer);
  map.setMaxBounds(tileServer.include_foreign_tiles ? null : japanBounds);
  tileLayer = L.tileLayer(tileServer.url, {
    attribution: tileServer.attribution,
    minZoom: tileServer.min_zoom ?? 5,
    maxZoom: tileServer.max_zoom ?? 18,
  }).addTo(map);
}

if (defaultTileServerId) selectTileServer(defaultTileServerId);

if (tileServerEntries.length) {
  const TileControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control live-tile-control");
      const form = document.createElement("form");
      form.className = "radio-zone";
      for (const [tileServerId, tileServer] of tileServerEntries) {
        const row = document.createElement("label");
        row.className = "tile-option";
        const radio = document.createElement("input");
        radio.className = "tile-radio";
        radio.type = "radio";
        radio.name = "live-map-tile";
        radio.value = tileServerId;
        radio.checked = tileServerId === defaultTileServerId;
        radio.addEventListener("change", () => selectTileServer(tileServerId));
        const label = document.createElement("span");
        label.className = "tile-radio-label";
        label.textContent = tileServer.label;
        row.append(radio, label);
        form.appendChild(row);
      }
      container.appendChild(form);
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation?.(container);
      return container;
    },
  });
  map.addControl(new TileControl());
}

const markers = new Map<string, any>();
const memberLayers = new Map<string, { displayName: string; group: any }>();
const isMobile = window.matchMedia("(max-width: 700px)").matches;
const locationLayersControl = L.control.layers(null, null, {
  collapsed: false,
}).addTo(map);
const collapsibleLocationLayers = isMobile
  ? createCollapsibleLayerControl({
      container: locationLayersControl.getContainer(),
      leaflet: L,
      map,
    })
  : null;
let fittedOnce = false;
let timer: number | null = null;
let resizeFrame: number | null = null;
let failures = 0;
const title = document.getElementById("map-title")!;
const status = document.getElementById("connection-status")!;
const errorBox = document.getElementById("error")!;
const vehicleList = document.getElementById("vehicle-list")!;

const nameVisibility = createNameVisibilityControl({
  getMarkers: () => markers.values(),
  leaflet: L,
  map,
  position: isMobile ? "topleft" : "topright",
});
map.addControl(nameVisibility.control);
map.addControl(createCurrentLocationControl({
  geolocation: navigator.geolocation,
  leaflet: L,
  map,
  onError: () => {
    errorBox.textContent = "現在位置を取得できませんでした。ブラウザの位置情報設定を確認してください。";
    errorBox.style.display = "block";
  },
  position: isMobile ? "bottomleft" : "topright",
}));

function escapeHtml(value: string): string {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function statusLabel(value: LivePosition["status"]): string {
  return value === "live" ? "共有中" : value === "stale" ? "更新遅延" : "オフライン";
}

function ensureMemberLayer(position: LivePosition): any {
  const existing = memberLayers.get(position.id);
  if (existing) {
    if (existing.displayName !== position.display_name) {
      locationLayersControl.removeLayer(existing.group);
      locationLayersControl.addOverlay(existing.group, escapeHtml(position.display_name));
      existing.displayName = position.display_name;
      collapsibleLocationLayers?.sync();
    }
    return existing.group;
  }
  const group = L.layerGroup().addTo(map);
  memberLayers.set(position.id, { displayName: position.display_name, group });
  locationLayersControl.addOverlay(group, escapeHtml(position.display_name));
  collapsibleLocationLayers?.sync();
  return group;
}

function render(snapshot: any): void {
  title.textContent = snapshot.map.name;
  status.textContent = `最終確認 ${new Date(snapshot.server_time).toLocaleTimeString("ja-JP")}`;
  errorBox.style.display = "none";
  const memberIds = new Set<string>();
  const bounds: [number, number][] = [];
  vehicleList.replaceChildren();

  for (const position of snapshot.positions as LivePosition[]) {
    memberIds.add(position.id);
    const memberLayer = ensureMemberLayer(position);
    const item = document.createElement("li");
    item.className = "vehicle";
    const focusButton = document.createElement("button");
    focusButton.className = "vehicle-focus";
    focusButton.type = "button";
    const received = position.received_at
      ? new Date(position.received_at).toLocaleTimeString("ja-JP")
      : "位置情報なし";
    const hasPosition = position.latitude !== null && position.longitude !== null;
    focusButton.disabled = !hasPosition;
    focusButton.setAttribute(
      "aria-label",
      hasPosition
        ? `${position.display_name}の位置へ移動`
        : `${position.display_name}（位置情報なし）`,
    );
    focusButton.innerHTML = `<span class="vehicle-dot" style="background:${position.marker_color}"></span>`
      + `<span class="vehicle-name">${escapeHtml(position.display_name)}</span>`
      + `<span class="status-${position.status}">${statusLabel(position.status)}</span>`
      + `<span class="vehicle-time">最終受信: ${received}</span>`;
    focusButton.addEventListener("click", () => {
      focusSharedLocation({
        map,
        marker: markers.get(position.id),
        memberLayer,
      });
    });
    item.appendChild(focusButton);
    vehicleList.appendChild(item);

    if (!hasPosition) {
      const existing = markers.get(position.id);
      if (existing) {
        memberLayer.removeLayer(existing);
        markers.delete(position.id);
      }
      continue;
    }
    if (map.hasLayer(memberLayer)) bounds.push([position.latitude, position.longitude]);
    const icon = L.divIcon({
      className: "live-location-marker",
      html: `<div class="live-location-dot ${position.status === "stale" ? "stale" : ""}" style="background:${position.marker_color}"></div>`,
      iconAnchor: [10, 10],
      iconSize: [20, 20],
    });
    const popup = `<strong>${escapeHtml(position.display_name)}</strong><br>${statusLabel(position.status)}<br>最終受信: ${received}`;
    const existing = markers.get(position.id);
    if (existing) {
      existing.setLatLng([position.latitude, position.longitude]);
      existing.setIcon(icon);
      existing.setPopupContent(popup);
      existing.setTooltipContent(`<div class="custom-tooltip">${escapeHtml(position.display_name)}</div>`);
      nameVisibility.syncMarker(existing);
    } else {
      const marker = L.marker([position.latitude, position.longitude], { icon })
        .bindPopup(popup)
        .bindTooltip(`<div class="custom-tooltip">${escapeHtml(position.display_name)}</div>`, {
          permanent: false,
          direction: "top",
          offset: [0, -10],
        })
        .addTo(memberLayer);
      markers.set(position.id, marker);
      nameVisibility.syncMarker(marker);
    }
  }
  for (const [id, layer] of memberLayers) {
    if (!memberIds.has(id)) {
      const marker = markers.get(id);
      if (marker) {
        layer.group.removeLayer(marker);
        markers.delete(id);
      }
      map.removeLayer(layer.group);
      locationLayersControl.removeLayer(layer.group);
      memberLayers.delete(id);
      collapsibleLocationLayers?.sync();
    }
  }
  if (!fittedOnce && bounds.length) {
    fittedOnce = true;
    bounds.length === 1 ? map.setView(bounds[0], 16) : map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function schedule(delay: number): void {
  if (timer !== null) window.clearTimeout(timer);
  const jitter = Math.floor(Math.random() * 1000) - 500;
  timer = window.setTimeout(load, Math.max(1000, delay + jitter));
}

function invalidateMapSize(): void {
  if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    map.invalidateSize({ pan: false });
  });
}

async function load(): Promise<void> {
  try {
    const response = await fetch(`/live-api/maps/${bootstrap.publicId}/positions`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.assign(`/live/${bootstrap.publicId}`);
      return;
    }
    if (!response.ok) throw new Error(response.status === 404 ? "共有リンクは無効または期限切れです。" : "位置情報を取得できません。");
    const snapshot = await response.json();
    failures = 0;
    render(snapshot);
    schedule(snapshot.refresh_after_ms ?? 5000);
  } catch (error) {
    failures += 1;
    errorBox.textContent = error instanceof Error ? error.message : "位置情報を取得できません。";
    errorBox.style.display = "block";
    status.textContent = "再接続しています…";
    schedule(Math.min(30000, 5000 * 2 ** Math.min(failures - 1, 3)));
  }
}

window.addEventListener("pagehide", () => {
  if (timer !== null) window.clearTimeout(timer);
  if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
});
window.addEventListener("resize", invalidateMapSize);
window.addEventListener("orientationchange", invalidateMapSize);
void load();
