import { awaitWithAbort } from "./progress-spinner";

// 一覧と編集中の条件が同じ取得を待つ場合、最後の利用者が離れた時だけ中断する。
export class PresetPageReads<T> {
  private pending = new Map<string, { job: AbortController; read: Promise<T>; users: number }>();

  async get(key: string, signal: AbortSignal, load: (request: AbortSignal) => Promise<T>) {
    signal.throwIfAborted();
    let entry = this.pending.get(key);
    if (!entry) {
      const job = new AbortController();
      entry = { job, read: awaitWithAbort(load(job.signal), job.signal), users: 0 };
      this.pending.set(key, entry);
    }
    entry.users++;
    try {
      return await awaitWithAbort(entry.read, signal);
    } finally {
      entry.users--;
      if (!entry.users && this.pending.get(key) === entry) {
        this.pending.delete(key);
        entry.job.abort();
      }
    }
  }

  clear() {
    for (const { job } of this.pending.values()) job.abort();
    this.pending.clear();
  }
}
