export const NOWCAST_ROOT = "https://www.jma.go.jp/bosai/jmatile/data/nowc";
export const NOWCAST_URL = `${NOWCAST_ROOT}/latest/none/latest/surf/hrpns/{z}/{x}/{y}.png`;
export const NOWCAST_MAX_AGE = 15 * 60_000;
const INTERVAL = 300_000;
const STATUS_CHECK_INTERVAL = 60_000;
const RETRY_BASE_INTERVAL = 60_000;

export function isNowcastUrl(url: string): boolean {
  return url.trim() === NOWCAST_URL;
}

export interface NowcastTime {
  basetime: string;
  validtime: string;
  milliseconds: number;
}

export function selectNowcastTime(data: unknown, now = Date.now()): NowcastTime {
  if (!Array.isArray(data)) throw new Error("Invalid nowcast times");
  let latest: NowcastTime | undefined;
  for (const item of data) {
    if (
      !item ||
      typeof item.basetime !== "string" ||
      !/^\d{14}$/.test(item.basetime) ||
      item.basetime !== item.validtime ||
      !Array.isArray(item.elements) ||
      !item.elements.includes("hrpns")
    )
      continue;
    const t = item.basetime;
    const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}.000Z`;
    const milliseconds = Date.parse(iso);
    if (
      !Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString() !== iso ||
      milliseconds > now
    )
      continue;
    if (!latest || milliseconds > latest.milliseconds) {
      latest = { basetime: t, validtime: t, milliseconds };
    }
  }
  if (!latest) throw new Error("No nowcast analysis available");
  return latest;
}

export interface NowcastState {
  time?: NowcastTime;
  failed: boolean;
}

// One feed per page: subscribers share requests, polling and cancellation.
export function createNowcastFeed() {
  const listeners = new Set<(state: NowcastState) => void>();
  let state: NowcastState = { failed: false };
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let nextAttempt = 0;

  function publish() {
    for (const listener of listeners) listener(state);
  }
  function stop() {
    clearTimeout(timer);
    timer = undefined;
    const previous = request;
    request = undefined;
    previous?.abort();
  }
  function schedule() {
    if (!listeners.size || document.hidden) return;
    // Wake every minute even during backoff to expire old images.
    timer = setTimeout(
      () => {
        publish();
        void refresh();
      },
      Math.min(STATUS_CHECK_INTERVAL, Math.max(0, nextAttempt - Date.now())),
    );
  }
  async function refresh() {
    if (!listeners.size || document.hidden || request) return;
    clearTimeout(timer);
    if (Date.now() < nextAttempt) {
      schedule();
      return;
    }
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${NOWCAST_ROOT}/targetTimes_N1.json`, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-cache",
      });
      if (!response.ok) throw new Error("Nowcast times unavailable");
      const time = selectNowcastTime(await response.json());
      if (request !== controller) return;
      // A lagging cache must not move an already displayed analysis backwards.
      state = {
        time: state.time && state.time.milliseconds > time.milliseconds ? state.time : time,
        failed: false,
      };
      failures = 0;
    } catch {
      if (request !== controller) return;
      state = { ...state, failed: true };
      failures++;
    } finally {
      clearTimeout(timeout);
      if (request === controller) {
        request = undefined;
        nextAttempt =
          Date.now() +
          (failures === 0
            ? INTERVAL
            : Math.min(RETRY_BASE_INTERVAL * 2 ** Math.min(failures, 3), INTERVAL));
        publish();
        schedule();
      }
    }
  }
  function visibilityChanged() {
    stop();
    if (!document.hidden) {
      nextAttempt = 0;
      publish();
      void refresh();
    }
  }
  return {
    subscribe(listener: (state: NowcastState) => void) {
      const first = listeners.size === 0;
      listeners.add(listener);
      listener(state);
      if (first) {
        document.addEventListener("visibilitychange", visibilityChanged);
        nextAttempt = 0;
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop();
          state = { failed: false };
          failures = 0;
          document.removeEventListener("visibilitychange", visibilityChanged);
        }
      };
    },
  };
}

export const nowcastFeed = createNowcastFeed();
