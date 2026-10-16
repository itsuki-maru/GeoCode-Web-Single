import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyLayerObjects } from "../src/map/common/lazy-layer-objects";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
function setup(concurrency = 4) {
  const selected = new Set<string>();
  const apply = vi.fn();
  const onChange = vi.fn();
  const fetchData = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    const id = parsed.searchParams.get("layer") ?? parsed.searchParams.get("layer_id");
    return response(
      parsed.pathname === "/shapes"
        ? [{ id: `shape-${id}`, layer_id: id }]
        : { [`marker-${id}`]: { id: `marker-${id}`, layer_id: id } },
    );
  });
  const loader = createLazyLayerObjects({
    layerIds: ["a", "b", "c", "master"],
    getSelectedLayerIds: () => [...selected],
    apply,
    onChange,
    fetchData,
    concurrency,
    timeoutMs: 100,
  });
  return { loader, selected, apply, onChange, fetchData };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lazy map group objects", () => {
  it("fetches nothing initially, uses group filters even for master, and reuses successful data", async () => {
    const { loader, fetchData, apply, selected } = setup();
    expect(fetchData).not.toHaveBeenCalled();
    selected.add("master");
    await loader.load("master");
    expect(fetchData).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchData.mock.calls) {
      const params = new URL(String(url), "http://localhost").searchParams;
      expect(params.get("is_master")).toBe("false");
      expect(params.get("layer") ?? params.get("layer_id")).toBe("master");
      expect(options?.credentials).toBe("same-origin");
      expect(options?.cache).toBe("no-store");
    }
    selected.delete("master");
    selected.add("master");
    await loader.load("master");
    expect(apply).toHaveBeenCalledOnce();
    expect(loader.state("master")).toBe("loaded");
    expect(fetchData).toHaveBeenCalledTimes(2);
    loader.dispose();
  });

  it("shares in-flight requests and excludes unchecked failures from print readiness", async () => {
    const { loader, selected, fetchData, apply } = setup();
    const pending = deferred<Response>();
    fetchData.mockReturnValue(pending.promise);
    selected.add("a");
    const first = loader.load("a");
    expect(loader.load("a")).toBe(first);
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(loader.getStatus()).toEqual({ loading: true, failed: false });
    selected.delete("a");
    expect(loader.getStatus()).toEqual({ loading: false, failed: false });
    pending.resolve({ ok: true, json: async () => [] } as unknown as Response);
    await first;
    expect(apply).not.toHaveBeenCalled();
    // 不正なマーカーデータは取得成功としてキャッシュせず、再試行できる状態にしておく。
    expect(loader.state("a")).toBe("error");
    expect(loader.getStatus()).toEqual({ loading: false, failed: false });
    loader.dispose();
  });

  it("keeps a successful unchecked result cached for the next selection", async () => {
    const { loader, selected, fetchData, apply } = setup();
    const marker = deferred<Response>(),
      shapes = deferred<Response>();
    fetchData.mockReturnValueOnce(marker.promise).mockReturnValueOnce(shapes.promise);
    selected.add("a");
    const pending = loader.load("a");
    selected.delete("a");
    marker.resolve(response({ m: { id: "m", layer_id: "a" } }));
    shapes.resolve(response([]));
    await pending;
    expect(apply).toHaveBeenCalledOnce();
    expect(selected.has("a")).toBe(false);
    selected.add("a");
    await loader.load("a");
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    loader.dispose();
  });

  it("does not cache partial failures and retries both endpoints on the next check", async () => {
    const { loader, selected, fetchData, apply } = setup();
    selected.add("a");
    fetchData.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}, 500));
    await loader.load("a");
    expect(apply).not.toHaveBeenCalled();
    expect(loader.getStatus()).toEqual({ loading: false, failed: true });
    await loader.retrySelected();
    expect(loader.state("a")).toBe("loaded");
    expect(apply).toHaveBeenCalledOnce();
    expect(fetchData).toHaveBeenCalledTimes(4);
    loader.dispose();
  });

  it("limits concurrent group loads for select-all and caches empty groups", async () => {
    const { loader, fetchData, selected } = setup(1);
    const markers = deferred<Response>(),
      shapes = deferred<Response>();
    fetchData.mockReturnValueOnce(markers.promise).mockReturnValueOnce(shapes.promise);
    ["a", "b", "c"].forEach((id) => selected.add(id));
    const all = ["a", "b", "c"].map(loader.load);
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(loader.state("b")).toBe("loading");
    markers.resolve(response({}));
    shapes.resolve(response([]));
    await Promise.all(all);
    expect(fetchData).toHaveBeenCalledTimes(6);
    await loader.load("a");
    expect(fetchData).toHaveBeenCalledTimes(6);
    loader.dispose();
  });

  it("rejects data for an unexpected group and unknown group requests", async () => {
    const { loader, fetchData, apply } = setup();
    await loader.load("unknown");
    expect(fetchData).not.toHaveBeenCalled();
    fetchData
      .mockResolvedValueOnce(response({ m: { id: "m", layer_id: "other" } }))
      .mockResolvedValueOnce(response([]));
    await loader.load("a");
    expect(loader.state("a")).toBe("error");
    expect(apply).not.toHaveBeenCalled();
    loader.dispose();
  });

  it("times out stalled requests and makes them retryable", async () => {
    vi.useFakeTimers();
    const { loader, fetchData } = setup();
    fetchData.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const pending = loader.load("a");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(loader.state("a")).toBe("error");
    loader.dispose();
  });

  it("aborts active requests and resolves queued work without starting it on disposal", async () => {
    const { loader, fetchData, apply, onChange } = setup(1);
    fetchData.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const first = loader.load("a"),
      queued = loader.load("b");
    const changeCount = onChange.mock.calls.length;
    loader.dispose();
    await Promise.all([first, queued]);
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(changeCount);
    await loader.load("a");
    expect(fetchData).toHaveBeenCalledTimes(2);
  });
});
