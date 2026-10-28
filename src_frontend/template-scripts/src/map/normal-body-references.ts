type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const invalid = (): never => {
  throw new Error("Answer-map body references are invalid");
};

function referenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid();
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !id.length || id.length > 128 || id.includes(":") || seen.has(id))
      return invalid();
    seen.add(id);
  }
  return value;
}

/** Restore only the private, freshly parsed JSON value before it is published. */
export function restoreNormalBodyReferences(value: RecordValue): void {
  if (!own(value, "normalBodyReferences")) return;
  const metadata = value.normalBodyReferences;
  if (
    value.page !== "form-answer-map" ||
    !record(metadata) ||
    Object.keys(metadata).length !== 3 ||
    !own(metadata, "version") ||
    !own(metadata, "markers") ||
    !own(metadata, "shapes") ||
    metadata.version !== 1 ||
    !record(value.markers) ||
    !Array.isArray(value.shapes) ||
    !record(value.popupBodies)
  )
    return invalid();
  const markerIds = referenceIds(metadata.markers);
  const shapeIds = referenceIds(metadata.shapes);
  const shapes = new Map<string, RecordValue>();
  for (const shape of value.shapes) {
    if (!record(shape) || !own(shape, "id") || typeof shape.id !== "string") continue;
    if (shapes.has(shape.id)) return invalid();
    shapes.set(shape.id, shape);
  }

  const updates: Array<{ target: RecordValue; field: string; free: string; managed: string }> = [];
  const prepare = (kind: "marker" | "shape", id: string, target: RecordValue, field: string) => {
    const key = `${kind}:${id}`;
    const popups = value.popupBodies as RecordValue;
    if (field in target || !own(popups, key)) return invalid();
    const popup = popups[key];
    if (
      !record(popup) ||
      !own(popup, "free_text") ||
      !own(popup, "managed_markdown") ||
      !own(popup, "sync_required") ||
      typeof popup.free_text !== "string" ||
      typeof popup.managed_markdown !== "string" ||
      typeof popup.sync_required !== "boolean"
    )
      return invalid();
    updates.push({ target, field, free: popup.free_text, managed: popup.managed_markdown });
  };
  for (const id of markerIds) {
    if (!own(value.markers, id)) return invalid();
    const marker = value.markers[id];
    if (!record(marker) || !own(marker, "id") || marker.id !== id) return invalid();
    prepare("marker", id, marker, "detail");
  }
  for (const id of shapeIds) {
    const shape = shapes.get(id);
    if (
      !shape ||
      !own(shape, "geojson") ||
      !record(shape.geojson) ||
      !own(shape.geojson, "properties") ||
      !record(shape.geojson.properties)
    )
      return invalid();
    prepare("shape", id, shape.geojson.properties, "memo");
  }

  // Validate every reference first. No trimming, normalization or boundary inference.
  for (const { target, field, free, managed } of updates) target[field] = free + managed;
  delete value.normalBodyReferences;
}
