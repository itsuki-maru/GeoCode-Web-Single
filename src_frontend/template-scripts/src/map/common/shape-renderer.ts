/** Geometry records remain available even when their Leaflet layer has never been created. */
export interface ShapeRenderRecord {
  id?: string | number;
  shape_type?: unknown;
  geojson?: unknown;
}

export interface ShapeBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ShapeGeometryInfo {
  bounds: ShapeBounds;
  vertexCount: number;
}

interface RenderMapBounds {
  getSouth?(): number;
  getWest?(): number;
  getNorth?(): number;
  getEast?(): number;
}

interface RenderMap {
  getBounds?(): RenderMapBounds;
  getZoom?(): unknown;
  on(eventNames: string, listener: () => void): unknown;
  off(eventNames: string, listener: () => void): unknown;
}

export interface ShapeRenderStats {
  recordCount: number;
  renderableCount: number;
  eligibleCount: number;
  renderedCount: number;
  cachedCount: number;
  cachedVertices: number;
  inactiveCachedCount: number;
  inactiveCachedVertices: number;
  pendingCount: number;
  createdCount: number;
  disposedCount: number;
}

interface ShapeRenderOptions<TRecord extends ShapeRenderRecord, TLayer> {
  map: RenderMap;
  records?: Iterable<TRecord>;
  createLayer(record: TRecord): TLayer | null | undefined;
  addLayer(layer: TLayer, record: TRecord): void;
  removeLayer(layer: TLayer, record: TRecord): void;
  disposeLayer?(layer: TLayer, record: TRecord): void;
  isRecordVisible(record: TRecord): boolean;
  isPinned?(id: string, layer: TLayer | null): boolean;
  onLayerCreated?(layer: TLayer, record: TRecord): void;
  onLayerEvicted?(layer: TLayer, record: TRecord): void;
  onRefresh?(): void;
  minPixelSize?: number;
  padding?: number;
  maxCachedLayers?: number;
  maxCachedVertices?: number;
  batchBudgetMs?: number;
  maxBatchSize?: number;
  maxBatchVertices?: number;
  scheduleFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
  now?(): number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const EARTH_RADIUS = 6371000;
const DEG = Math.PI / 180;
const MERCATOR_MAX_LATITUDE = 85.0511287798;

/** Conservative geographic extent, including circle radius; no Leaflet object is needed. */
export function getShapeGeometryInfo(value: ShapeRenderRecord): ShapeGeometryInfo | null {
  const geojson = value?.geojson;
  if (!record(geojson)) return null;
  const geometry = geojson.type === "Feature" ? geojson.geometry : geojson;
  if (!record(geometry)) return null;
  const coordinates = geometry.coordinates;
  const validPosition = (position: unknown): position is number[] =>
    Array.isArray(position) &&
    position.length >= 2 &&
    typeof position[0] === "number" &&
    Number.isFinite(position[0]) &&
    Math.abs(position[0]) <= 180 &&
    typeof position[1] === "number" &&
    Number.isFinite(position[1]) &&
    Math.abs(position[1]) <= 90;

  if (value.shape_type === "circle") {
    const radius = Number(record(geojson.properties) ? geojson.properties.radius : undefined);
    if (
      geometry.type !== "Point" ||
      !validPosition(coordinates) ||
      !Number.isFinite(radius) ||
      radius <= 0
    )
      return null;
    const [longitude, latitude] = coordinates;
    const angularRadius = Math.min(Math.PI, radius / EARTH_RADIUS);
    const latitudeRadius = angularRadius / DEG;
    const epsilon = 1e-7;
    const south = Math.max(-90, latitude - latitudeRadius - epsilon);
    const north = Math.min(90, latitude + latitudeRadius + epsilon);
    let west = -180;
    let east = 180;
    if (south > -90 && north < 90 && angularRadius < Math.PI / 2) {
      let longitudeRadius =
        Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitude * DEG))) / DEG;
      // Leaflet projects a circle as an ellipse around the projected vertical
      // midpoint. Include that extent as well as the spherical circle bounds.
      const mercator = (lat: number) =>
        Math.log(
          Math.tan(
            Math.PI / 4 +
              (Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat)) * DEG) / 2,
          ),
        );
      const midpoint =
        2 *
          Math.atan(
            Math.exp(
              (mercator(latitude + latitudeRadius) + mercator(latitude - latitudeRadius)) / 2,
            ),
          ) -
        Math.PI / 2;
      const cosine =
        (Math.cos(angularRadius) - Math.sin(latitude * DEG) * Math.sin(midpoint)) /
        (Math.cos(latitude * DEG) * Math.cos(midpoint));
      if (Number.isFinite(cosine))
        longitudeRadius = Math.max(
          longitudeRadius,
          Math.acos(Math.max(-1, Math.min(1, cosine))) / DEG,
        );
      longitudeRadius += epsilon;
      // A circle crossing the date line is conservatively kept as a world-wide extent.
      if (longitude - longitudeRadius >= -180 && longitude + longitudeRadius <= 180) {
        west = longitude - longitudeRadius;
        east = longitude + longitudeRadius;
      }
    }
    return { bounds: { south, west, north, east }, vertexCount: 1 };
  }

  let paths: unknown[][];
  if (value.shape_type === "polyline" && geometry.type === "LineString") {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    paths = [coordinates];
  } else if (
    (value.shape_type === "polygon" || value.shape_type === "rectangle") &&
    geometry.type === "Polygon"
  ) {
    if (!Array.isArray(coordinates) || !coordinates.length) return null;
    if (coordinates.some((ring) => !Array.isArray(ring) || ring.length < 4)) return null;
    paths = coordinates;
  } else {
    return null;
  }
  const bounds: ShapeBounds = {
    south: Infinity,
    west: Infinity,
    north: -Infinity,
    east: -Infinity,
  };
  let vertexCount = 0;
  for (const path of paths) {
    for (const position of path) {
      if (!validPosition(position)) return null;
      bounds.west = Math.min(bounds.west, position[0]);
      bounds.east = Math.max(bounds.east, position[0]);
      bounds.south = Math.min(bounds.south, position[1]);
      bounds.north = Math.max(bounds.north, position[1]);
      vertexCount++;
    }
  }
  return { bounds, vertexCount };
}

function readViewport(map: RenderMap, padding: number): ShapeBounds | null {
  const bounds = map.getBounds?.();
  const south = Number(bounds?.getSouth?.());
  const west = Number(bounds?.getWest?.());
  const north = Number(bounds?.getNorth?.());
  const east = Number(bounds?.getEast?.());
  if (![south, west, north, east].every(Number.isFinite) || south > north || west > east)
    return null;
  const latitudePadding = (north - south) * padding;
  const longitudePadding = (east - west) * padding;
  return {
    south: south - latitudePadding,
    west: west - longitudePadding,
    north: north + latitudePadding,
    east: east + longitudePadding,
  };
}

function intersects(bounds: ShapeBounds, viewport: ShapeBounds): boolean {
  if (bounds.north < viewport.south || bounds.south > viewport.north) return false;
  if (viewport.east - viewport.west >= 360) return true;
  const offset =
    360 * Math.round((viewport.west + viewport.east - (bounds.west + bounds.east)) / 720);
  return bounds.east + offset >= viewport.west && bounds.west + offset <= viewport.east;
}

/** EPSG:3857 is the CRS used by both the editor and read-only map. */
function screenSize(bounds: ShapeBounds, zoom: number): number {
  if (!Number.isFinite(zoom)) return Infinity;
  const scale = 256 * 2 ** zoom;
  const projectY = (latitude: number) => {
    const sine = Math.sin(
      Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, latitude)) * DEG,
    );
    return (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale;
  };
  return Math.max(
    ((bounds.east - bounds.west) / 360) * scale,
    Math.abs(projectY(bounds.north) - projectY(bounds.south)),
  );
}

/**
 * Records are registered separately from refresh(), so bulk hydration never performs
 * a full visibility scan for every inserted record. Cache limits concern inactive,
 * unpinned layers; currently visible or explicitly selected objects are never evicted.
 */
export function createShapeRenderManager<TRecord extends ShapeRenderRecord, TLayer>({
  map,
  records: initialRecords = [],
  createLayer,
  addLayer,
  removeLayer,
  disposeLayer,
  isRecordVisible,
  isPinned = () => false,
  onLayerCreated,
  onLayerEvicted,
  onRefresh = () => {},
  minPixelSize = 4,
  padding = 0.2,
  maxCachedLayers = 256,
  maxCachedVertices = 50000,
  batchBudgetMs = 8,
  maxBatchSize = 500,
  maxBatchVertices = 10000,
  scheduleFrame = (callback) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : window.setTimeout(callback, 0),
  cancelFrame = (handle) =>
    typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame(handle)
      : window.clearTimeout(handle),
  now = () => performance.now(),
}: ShapeRenderOptions<TRecord, TLayer>) {
  interface Entry {
    id: string;
    record: TRecord;
    info: ShapeGeometryInfo | null;
    layer: TLayer | null;
    failed: boolean;
    lastUsed: number;
  }
  interface Work {
    generation: number;
    operations: Array<{ id: string; attach: boolean }>;
    index: number;
  }
  const entries = new Map<string, Entry>();
  const cached = new Set<Entry>();
  const attached = new Set<string>();
  const idleWaiters = new Set<() => void>();
  let frame: number | null = null;
  let work: Work | null = null;
  let generation = 0;
  let serial = 0;
  let disposed = false;
  let zooming = false;
  let moving = false;
  let refreshRequested = false;
  let createdCount = 0;
  let disposedCount = 0;
  let logicalStatsDirty = true;
  let renderableCount = 0;
  let eligibleCount = 0;

  const resolveIdle = () => {
    if (!disposed && (frame !== null || work || refreshRequested || zooming || moving)) return;
    const callbacks = [...idleWaiters];
    idleWaiters.clear();
    callbacks.forEach((resolve) => resolve());
  };
  const cancelWork = () => {
    generation++;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    work = null;
  };
  const detach = (entry: Entry) => {
    if (!attached.delete(entry.id) || entry.layer === null) return;
    removeLayer(entry.layer, entry.record);
  };
  const evict = (entry: Entry) => {
    if (entry.layer === null) return;
    detach(entry);
    const layer = entry.layer;
    entry.layer = null;
    cached.delete(entry);
    onLayerEvicted?.(layer, entry.record);
    disposeLayer?.(layer, entry.record);
    disposedCount++;
  };
  const eligible = (entry: Entry): boolean =>
    !!entry.info && !entry.failed && isRecordVisible(entry.record);
  const create = (entry: Entry): TLayer | null => {
    if (entry.layer !== null) {
      entry.lastUsed = ++serial;
      return entry.layer;
    }
    if (!entry.info || entry.failed) return null;
    let layer: TLayer | null | undefined;
    try {
      layer = createLayer(entry.record);
    } catch {
      layer = null;
    }
    if (layer == null) {
      entry.failed = true;
      logicalStatsDirty = true;
      return null;
    }
    entry.layer = layer;
    cached.add(entry);
    entry.lastUsed = ++serial;
    createdCount++;
    onLayerCreated?.(layer, entry.record);
    return layer;
  };
  const pruneCache = () => {
    const inactive = [...cached]
      .filter(
        (entry) =>
          entry.layer !== null && !attached.has(entry.id) && !isPinned(entry.id, entry.layer),
      )
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let count = inactive.length;
    let vertices = inactive.reduce((total, entry) => total + (entry.info?.vertexCount ?? 0), 0);
    for (const entry of inactive) {
      if (count <= Math.max(0, maxCachedLayers) && vertices <= Math.max(0, maxCachedVertices))
        break;
      count--;
      vertices -= entry.info?.vertexCount ?? 0;
      evict(entry);
    }
  };
  const scheduleBatch = (next: () => void) => {
    const scheduledGeneration = generation;
    frame = scheduleFrame(() => {
      if (disposed || scheduledGeneration !== generation) return;
      frame = null;
      next();
    });
  };
  const runBatch = () => {
    const current = work;
    if (!current || disposed || zooming || moving || current.generation !== generation) return;
    const started = now();
    let processed = 0;
    let generatedVertices = 0;
    try {
      while (current.index < current.operations.length && current.generation === generation) {
        const operation = current.operations[current.index];
        const entry = entries.get(operation.id);
        const shouldAttach = !!entry && operation.attach && eligible(entry);
        const vertices = shouldAttach && entry.layer === null ? entry.info!.vertexCount : 0;
        if (processed > 0 && generatedVertices + vertices > Math.max(1, maxBatchVertices)) break;
        current.index++;
        if (entry) {
          if (!operation.attach) detach(entry);
          else if (shouldAttach) {
            const layer = create(entry);
            if (layer !== null && !attached.has(entry.id)) {
              addLayer(layer, entry.record);
              attached.add(entry.id);
            }
          }
        }
        generatedVertices += vertices;
        processed++;
        if (
          processed >= Math.max(1, maxBatchSize) ||
          generatedVertices >= Math.max(1, maxBatchVertices) ||
          now() - started >= Math.max(1, batchBudgetMs)
        )
          break;
      }
      if (current.generation !== generation || disposed) return;
      if (current.index < current.operations.length) scheduleBatch(runBatch);
      else {
        work = null;
        pruneCache();
      }
      onRefresh();
      resolveIdle();
    } catch (error) {
      cancelWork();
      refreshRequested = false;
      resolveIdle();
      throw error;
    }
  };

  const refresh = () => {
    if (disposed) return;
    cancelWork();
    refreshRequested = false;
    if (zooming || moving) {
      refreshRequested = true;
      return;
    }
    const viewport = readViewport(map, Math.max(0, padding));
    const zoom = Number(map.getZoom?.());
    const wanted = new Set<string>();
    renderableCount = 0;
    eligibleCount = 0;
    for (const entry of entries.values()) {
      if (entry.info && !entry.failed) renderableCount++;
      if (!eligible(entry)) continue;
      eligibleCount++;
      if (
        isPinned(entry.id, entry.layer) ||
        ((!viewport || intersects(entry.info!.bounds, viewport)) &&
          screenSize(entry.info!.bounds, zoom) >= Math.max(0, minPixelSize))
      )
        wanted.add(entry.id);
    }
    logicalStatsDirty = false;
    const operations: Work["operations"] = [];
    for (const id of attached) if (!wanted.has(id)) operations.push({ id, attach: false });
    for (const id of wanted) {
      const entry = entries.get(id)!;
      entry.lastUsed = ++serial;
      if (!attached.has(id)) operations.push({ id, attach: true });
    }
    if (operations.length) {
      work = { generation, operations, index: 0 };
      runBatch();
    } else {
      pruneCache();
      onRefresh();
      resolveIdle();
    }
  };
  const scheduleRefresh = () => {
    if (disposed) return;
    refreshRequested = true;
    logicalStatsDirty = true;
    // A new view supersedes unfinished work rather than drawing stale candidates.
    if (work) cancelWork();
    if (frame !== null || zooming || moving) return;
    scheduleBatch(refresh);
  };
  const upsert = (value: TRecord, existingLayer?: TLayer): void => {
    if (disposed || value.id == null || String(value.id) === "") return;
    cancelWork();
    refreshRequested = false;
    const id = String(value.id);
    const previous = entries.get(id);
    const info = getShapeGeometryInfo(value);
    if (previous && previous.layer !== null && previous.layer !== existingLayer) evict(previous);
    const entry: Entry = {
      id,
      record: value,
      info,
      layer: info ? (existingLayer ?? null) : null,
      failed: false,
      lastUsed: ++serial,
    };
    if (previous && previous.layer === entry.layer) cached.delete(previous);
    if (!info && previous?.layer != null) evict(previous);
    entries.set(id, entry);
    if (entry.layer !== null) cached.add(entry);
    logicalStatsDirty = true;
    if (entry.layer !== null && previous?.layer !== entry.layer) {
      onLayerCreated?.(entry.layer, value);
    }
    resolveIdle();
  };
  const remove = (idValue: string | number): void => {
    if (disposed) return;
    cancelWork();
    refreshRequested = false;
    const id = String(idValue);
    const entry = entries.get(id);
    if (entry) evict(entry);
    entries.delete(id);
    logicalStatsDirty = true;
    attached.delete(id);
    resolveIdle();
  };
  const replaceRecords = (values: Iterable<TRecord>): void => {
    if (disposed) return;
    cancelWork();
    refreshRequested = false;
    logicalStatsDirty = true;
    const next = new Map<string, TRecord>();
    for (const value of values)
      if (value.id != null && String(value.id) !== "") next.set(String(value.id), value);
    for (const [id, entry] of entries)
      if (!next.has(id)) {
        evict(entry);
        entries.delete(id);
      }
    for (const [id, value] of next) if (entries.get(id)?.record !== value) upsert(value);
    resolveIdle();
  };
  const getStats = (): ShapeRenderStats => {
    if (logicalStatsDirty) {
      renderableCount = 0;
      eligibleCount = 0;
      for (const entry of entries.values()) {
        if (entry.info && !entry.failed) renderableCount++;
        if (eligible(entry)) eligibleCount++;
      }
      logicalStatsDirty = false;
    }
    let cachedCount = 0;
    let cachedVertices = 0;
    let inactiveCachedCount = 0;
    let inactiveCachedVertices = 0;
    for (const entry of cached) {
      cachedCount++;
      cachedVertices += entry.info?.vertexCount ?? 0;
      if (!attached.has(entry.id) && !isPinned(entry.id, entry.layer)) {
        inactiveCachedCount++;
        inactiveCachedVertices += entry.info?.vertexCount ?? 0;
      }
    }
    return {
      recordCount: entries.size,
      renderableCount,
      eligibleCount,
      renderedCount: attached.size,
      cachedCount,
      cachedVertices,
      inactiveCachedCount,
      inactiveCachedVertices,
      pendingCount: work
        ? work.operations.length - work.index
        : frame !== null || refreshRequested || zooming || moving
          ? 1
          : 0,
      createdCount,
      disposedCount,
    };
  };
  const pauseMovement = () => {
    moving = true;
    cancelWork();
    refreshRequested = true;
  };
  const resumeMovement = () => {
    moving = false;
    scheduleRefresh();
  };
  const pauseZoom = () => {
    zooming = true;
    cancelWork();
    refreshRequested = true;
  };
  const resumeZoom = () => {
    zooming = false;
    scheduleRefresh();
  };
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    cancelWork();
    refreshRequested = false;
    map.off("movestart", pauseMovement);
    map.off("moveend", resumeMovement);
    map.off("resize", scheduleRefresh);
    map.off("zoomstart", pauseZoom);
    map.off("zoomend", resumeZoom);
    map.off("unload", destroy);
    for (const entry of entries.values()) evict(entry);
    entries.clear();
    logicalStatsDirty = true;
    resolveIdle();
  };
  map.on("movestart", pauseMovement);
  map.on("moveend", resumeMovement);
  map.on("resize", scheduleRefresh);
  map.on("zoomstart", pauseZoom);
  map.on("zoomend", resumeZoom);
  map.on("unload", destroy);
  replaceRecords(initialRecords);

  return {
    replaceRecords,
    upsert,
    remove,
    getRecord: (id: string | number) => entries.get(String(id))?.record ?? null,
    getRecords: () => [...entries.values()].map((entry) => entry.record),
    getGeometryInfo: (id: string | number) => entries.get(String(id))?.info ?? null,
    isRenderable: (id: string | number) => {
      const entry = entries.get(String(id));
      return !!entry?.info && !entry.failed;
    },
    isVisible: (id: string | number) => {
      const entry = entries.get(String(id));
      return !!entry && eligible(entry);
    },
    getLayer: (id: string | number) => entries.get(String(id))?.layer ?? null,
    ensureLayer: (id: string | number) => {
      if (disposed) return null;
      const entry = entries.get(String(id));
      return entry ? create(entry) : null;
    },
    refresh,
    scheduleRefresh,
    whenIdle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
        resolveIdle();
      }),
    getStats,
    destroy,
  };
}
