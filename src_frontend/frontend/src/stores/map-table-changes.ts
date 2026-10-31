export type TableObjectType = "marker" | "shape";
export type TableChange = { type: "reset" } | { type: "record"; kind: TableObjectType; id: string };

// 同期通知は、地図の一時的な dirtyIds が消費された後も届く。
// 購読側で描画前にまとめて処理し、通知バス自体はレコードや履歴を保持しない。
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
