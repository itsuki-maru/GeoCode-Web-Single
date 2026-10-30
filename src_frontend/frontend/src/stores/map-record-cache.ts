export interface LayerRecord {
  id: string;
  layer_id: string;
}
interface Scope {
  ids: Set<string>;
  loaded: boolean;
  generation: number;
  touched: number;
  promise?: Promise<boolean>;
  controller?: AbortController;
}
// One canonical record per ID; scopes contain IDs only, including successfully empty scopes.
export class MapRecordCache<T extends LayerRecord> {
  readonly records = new Map<string, T>();
  private scopes = new Map<string, Scope>();
  private changes = new Map<string, { revision: number; record: T | null }>();
  private revision = 0;
  private epoch = 0;
  private serial = 0;
  private account = "";
  private active = "all";
  private pending = 0;
  private accountEpoch = 0;
  private leases = new Map<string, number>();
  private removed = new Set<string>();
  private readSequence = 0;
  private observed = new Map<string, { sequence: number; deleted: boolean }>();
  get generation() {
    return this.accountEpoch;
  }
  private stamp(record: T | undefined): bigint | null {
    const value = record as (T & { updated_at?: string; update_at?: string }) | undefined;
    const text = value?.updated_at ?? value?.update_at;
    const parts = text?.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/,
    );
    if (!parts) return null;
    const base = Date.parse(parts[1] + (parts[3] ?? "Z"));
    return Number.isFinite(base)
      ? BigInt(base) * 1000000n + BigInt((parts[2] ?? "").padEnd(9, "0"))
      : null;
  }
  private older(record: T, previous: T | undefined) {
    const before = this.stamp(previous),
      after = this.stamp(record);
    return before !== null && after !== null && after < before;
  }
  private key(layerId: string, all: boolean) {
    return all ? "all" : "layer:" + layerId;
  }
  private matches(record: T, key: string) {
    return key === "all" || record.layer_id === key.slice(6);
  }
  setAccount(account: string) {
    if (account === this.account) return false;
    this.reset();
    this.account = account;
    return true;
  }
  setActive(layerId: string, all: boolean) {
    this.active = this.key(layerId, all);
  }
  retainScope(layerId: string, all: boolean): () => void {
    const key = this.key(layerId, all),
      epoch = this.accountEpoch;
    this.scope(key);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released || epoch !== this.accountEpoch) return;
      released = true;
      const count = (this.leases.get(key) ?? 1) - 1;
      if (count) this.leases.set(key, count);
      else this.leases.delete(key);
      this.prune();
    };
  }
  private scope(key: string) {
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { ids: new Set(), loaded: false, generation: 0, touched: ++this.serial };
      this.scopes.set(key, scope);
    }
    scope.touched = ++this.serial;
    return scope;
  }
  private cached(key: string) {
    const own = this.scope(key);
    if (own.loaded) return true;
    const all = this.scopes.get("all");
    if (key !== "all" && all?.loaded) {
      own.ids = new Set(
        [...all.ids].filter((id) => {
          const record = this.records.get(id);
          return record && this.matches(record, key);
        }),
      );
      own.loaded = true;
      return true;
    }
    return false;
  }
  getRecords(layerId: string, all: boolean): T[] {
    const key = this.key(layerId, all);
    const scope = this.scopes.get(key);
    const ids = scope?.loaded ? scope.ids : this.records.keys();
    const result: T[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (record && this.matches(record, key)) result.push(record);
    }
    return result;
  }
  upsert(record: T) {
    if (this.removed.has(record.id) || this.older(record, this.records.get(record.id)))
      return false;
    this.records.set(record.id, record);
    this.changes.set(record.id, { revision: ++this.revision, record });
    for (const [key, scope] of this.scopes) {
      if (this.matches(record, key)) scope.ids.add(record.id);
      else scope.ids.delete(record.id);
    }
    // Retain a moved/new record without claiming its destination was fully fetched.
    if (![...this.scopes.values()].some((scope) => scope.ids.has(record.id)))
      this.scope("layer:" + record.layer_id).ids.add(record.id);
    if (!this.pending) this.changes.clear();
    return true;
  }
  remove(id: string) {
    this.removed.add(id);
    this.records.delete(id);
    this.changes.set(id, { revision: ++this.revision, record: null });
    for (const scope of this.scopes.values()) scope.ids.delete(id);
    if (!this.pending) this.changes.clear();
  }
  invalidate() {
    ++this.epoch;
    for (const scope of this.scopes.values()) {
      ++scope.generation;
      scope.loaded = false;
      scope.controller?.abort();
      scope.promise = undefined;
      scope.controller = undefined;
    }
  }
  reset() {
    ++this.accountEpoch;
    this.leases.clear();
    this.removed.clear();
    this.invalidate();
    this.scopes.clear();
    this.records.clear();
    this.changes.clear();
    this.observed.clear();
  }
  private prune() {
    // Keep the visible scope even if it is larger than the cache budget.
    const inactive = [...this.scopes]
      .filter(([key, scope]) => key !== this.active && !scope.promise && !this.leases.has(key))
      .sort((a, b) => a[1].touched - b[1].touched);
    while (this.scopes.size > 8 && inactive.length) this.scopes.delete(inactive.shift()![0]);
    const retained = new Set<string>();
    for (const scope of this.scopes.values()) for (const id of scope.ids) retained.add(id);
    for (const id of this.changes.keys()) retained.add(id);
    for (const id of this.records.keys())
      if (!retained.has(id)) {
        this.records.delete(id);
        if (!this.pending) this.observed.delete(id);
      }
  }
  async load(
    layerId: string,
    all: boolean,
    read: (signal: AbortSignal) => Promise<T[]>,
    force = false,
  ) {
    const key = this.key(layerId, all);
    if (!force && this.cached(key)) {
      this.prune();
      return true;
    }
    const scope = this.scope(key);
    if (!force && scope.promise) return scope.promise;
    if (force) {
      ++scope.generation;
      scope.controller?.abort();
    }
    const generation = scope.generation,
      epoch = this.epoch,
      revision = this.revision;
    const sequence = ++this.readSequence;
    const controller = new AbortController();
    scope.controller = controller;
    this.pending++;
    const promise = Promise.resolve().then(async () => {
      try {
        const response = await read(controller.signal);
        if (controller.signal.aborted || epoch !== this.epoch || generation !== scope.generation)
          return false;
        const incoming = new Map(response.map((record) => [record.id, record]));
        // Replay successful writes made while this GET was in flight, including deletions.
        for (const [id, change] of this.changes)
          if (change.revision > revision) {
            if (change.record && this.matches(change.record, key)) incoming.set(id, change.record);
            else incoming.delete(id);
          }
        // A later scope read may already know newer records or deletions.
        for (const [id, observed] of this.observed)
          if (observed.sequence > sequence) {
            const record = this.records.get(id);
            if (!observed.deleted && record && this.matches(record, key)) incoming.set(id, record);
            else incoming.delete(id);
          }
        for (const id of scope.ids)
          if (!incoming.has(id)) {
            const record = this.records.get(id);
            if (
              record &&
              this.matches(record, key) &&
              (this.observed.get(id)?.sequence ?? 0) <= sequence
            ) {
              this.records.delete(id);
              this.observed.set(id, { sequence, deleted: true });
              for (const other of this.scopes.values()) other.ids.delete(id);
            }
          }
        for (const [id, candidate] of incoming) {
          const previous = this.records.get(id);
          const record = this.older(candidate, previous) ? previous! : candidate;
          if (!this.matches(record, key)) {
            incoming.delete(id);
            continue;
          }
          incoming.set(id, record);
          if (!this.matches(record, key)) throw Error("Unexpected layer in map response");
          this.records.set(id, record);
          this.removed.delete(id);
          if ((this.observed.get(id)?.sequence ?? 0) <= sequence)
            this.observed.set(id, { sequence, deleted: false });
          for (const [otherKey, other] of this.scopes) {
            if (other === scope || !other.loaded) continue;
            if (this.matches(record, otherKey)) other.ids.add(id);
            else other.ids.delete(id);
          }
        }
        if (key === "all") {
          for (const [otherKey, other] of this.scopes)
            if (other !== scope && other.loaded) {
              other.ids = new Set(
                [...incoming.values()].filter((r) => this.matches(r, otherKey)).map((r) => r.id),
              );
            }
        } else if (force) {
          const allScope = this.scopes.get("all");
          if (allScope) allScope.loaded = false;
        }
        scope.ids = new Set(incoming.keys());
        scope.loaded = true;
        return true;
      } catch {
        return false;
      } finally {
        this.pending--;
        if (scope.promise === promise) {
          scope.promise = undefined;
          scope.controller = undefined;
        }
        if (!this.pending) {
          this.changes.clear();
          this.observed.clear();
        }
        this.prune();
      }
    });
    scope.promise = promise;
    return promise;
  }
}

// Local text edits use literal substrings, two optional AND terms, and no trimming.
// Preserve server results for unchanged text: database case folding can differ from JavaScript.
export function matchesMapSearch(fields: Array<string | null | undefined>, terms: string[]) {
  const values = fields.map((value) => (value ?? "").toLowerCase());
  return terms.every((term) => !term || values.some((value) => value.includes(term.toLowerCase())));
}

export class MapSearchMatches {
  readonly records = new Map<string, { layerId: string; fields: string[] }>();
  readonly ids: Set<string>;

  constructor(records: Iterable<readonly [string, string, string[]]>, ids: Iterable<string>) {
    this.ids = new Set(ids);
    for (const [id, layerId, fields] of records) this.records.set(id, { layerId, fields });
  }

  matches(id: string, layerId: string, fields: string[], terms: string[]) {
    const previous = this.records.get(id);
    if (
      previous?.layerId === layerId &&
      previous.fields.every((value, index) => value === fields[index])
    )
      return this.ids.has(id);
    // A server-matched shape can be loaded into the canonical cache after the query.
    const matched = (!previous && this.ids.has(id)) || matchesMapSearch(fields, terms);
    this.records.set(id, { layerId, fields });
    if (matched) this.ids.add(id);
    else this.ids.delete(id);
    return matched;
  }
}
