export type TableObjectType = "marker" | "shape";
export type TableChange = { type: "reset" } | { type: "record"; kind: TableObjectType; id: string };

// Synchronous notifications survive consumption of the map's transient dirtyIds.
// Subscribers batch them before rendering; the bus holds neither records nor a history.
export class MapTableChanges {
  private listeners = new Set<(change: TableChange) => void>();
  subscribe(listener: (change: TableChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(change: TableChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
