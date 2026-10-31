import { flushPromises, mount } from "@vue/test-utils";
import { isProxy, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MapIframe from "@/components/map/MapIframe.vue";

const wrappers: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});
function setup() {
  const wrapper = mount(MapIframe, {
    attachTo: document.body,
    props: {
      srcUrl: "/map?layer=one&is_master=false&data_source=parent",
      allowedOrigins: window.location.origin,
      height: 80,
    },
  });
  wrappers.push(wrapper as never);
  const frame = wrapper.get("iframe").element as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message) => {
    structuredClone(message);
  });
  const send = (data: Record<string, unknown>, source: Window | null = frame.contentWindow) => {
    if (data.type === "mapRuntimeReady" && !("requestId" in data)) {
      const currentPost = frame.contentWindow!.postMessage as unknown as ReturnType<typeof vi.fn>;
      const probe = currentPost.mock.calls
        .filter(([message]) => message.type === "mapRuntimeProbe")
        .at(-1)?.[0];
      data = { requestId: probe?.requestId, ...data };
    }
    window.dispatchEvent(
      new MessageEvent("message", { source, origin: window.location.origin, data }),
    );
  };
  return { wrapper, frame, post, send };
}
const marker = {
  id: "m",
  layer_id: "one",
  marker_name: "saved",
  detail: "body",
  latitude: 35,
  longitude: 139,
  update_at: "2026-10-27T00:00:00",
};
const shape = {
  id: "s",
  user_id: "account",
  layer_id: "one",
  name: "pipe",
  shape_type: "polyline",
  created_at: "2026-10-27T00:00:00",
  updated_at: "2026-10-27T00:00:00",
  geojson: {
    type: "Feature",
    properties: { memo: "body" },
    geometry: {
      type: "LineString",
      coordinates: [
        [139, 35],
        [139.1, 35],
      ],
    },
  },
} as const;

describe("parent-owned map data", () => {
  it("waits for runtime and application ACK, unwraps nested Vue records, and ignores stale ACK", async () => {
    const { wrapper, post, send } = setup();
    const snapshot = reactive({ markers: { m: marker }, shapes: [structuredClone(shape)] });
    const initialization = wrapper.vm.initializeMapObjects(snapshot as never);
    send({ type: "mapRuntimeReady", runtimeId: "previous-document" });
    expect(post.mock.calls.some(([message]) => message.type === "mapObjectsInitialize")).toBe(
      false,
    );
    await wrapper.get("iframe").trigger("load");
    expect(wrapper.emitted("mapLoaded")).toBeUndefined();
    send({ type: "mapRuntimeReady", runtimeId: "current" });
    await flushPromises();
    const message = post.mock.calls
      .filter(([entry]) => entry.type === "mapObjectsInitialize")
      .at(-1)![0];
    expect(message.runtimeId).toBe("current");
    expect(post.mock.calls.filter(([entry]) => entry.type === "mapObjectsInitialize")).toHaveLength(
      2,
    );
    expect(isProxy(message.snapshot.shapes[0].geojson)).toBe(false);
    expect(() => structuredClone(message.snapshot)).not.toThrow();
    let finished = false;
    void initialization.then(() => {
      finished = true;
    });
    send({
      type: "mapObjectsInitializeResult",
      runtimeId: "previous-document",
      requestId: message.requestId,
      success: true,
    });
    await flushPromises();
    expect(finished).toBe(false);
    send({
      type: "mapObjectsInitializeResult",
      runtimeId: "current",
      requestId: message.requestId,
      success: true,
    });
    expect(await initialization).toBe(true);
    expect(wrapper.emitted("mapLoaded")).toHaveLength(1);
  });

  it("acknowledges a saved mutation only after the parent applies it and deduplicates retries", () => {
    const { wrapper, send, post } = setup();
    // 転送データの読み込み後に、実行時のメッセージが届く。
    (wrapper.vm as any).$el.querySelector("iframe").dispatchEvent(new Event("load"));
    send({ type: "mapRuntimeReady", runtimeId: "current" });
    const change = {
      operation: "upsert",
      objectType: "marker",
      object: marker,
      mutationId: "op-1",
    };
    send({ type: "mapObjectChanged", runtimeId: "current", change }, window);
    expect(wrapper.emitted("mapObjectChanged")).toBeUndefined();
    send({ type: "mapObjectChanged", runtimeId: "current", change });
    expect(wrapper.emitted("mapObjectChanged")).toHaveLength(1);
    const acknowledge = wrapper.emitted("mapObjectChanged")![0]![1] as (success: boolean) => void;
    expect(post.mock.calls.some(([entry]) => entry.type === "mapObjectChangedResult")).toBe(false);
    acknowledge(true);
    send({ type: "mapObjectChanged", runtimeId: "current", change });
    expect(wrapper.emitted("mapObjectChanged")).toHaveLength(1);
    expect(
      post.mock.calls.filter(([entry]) => entry.type === "mapObjectChangedResult"),
    ).toHaveLength(2);
  });

  it("requires the latest runtime probe nonce before accepting a recreated frame", async () => {
    const { wrapper, send, post } = setup();
    await wrapper.get("iframe").trigger("load");
    const firstProbe = post.mock.calls
      .filter(([message]) => message.type === "mapRuntimeProbe")
      .at(-1)![0].requestId;
    send({ type: "mapRuntimeReady", runtimeId: "first" });
    const first = wrapper.vm.initializeMapObjects({ markers: {}, shapes: [] });
    await flushPromises();
    const firstMessage = post.mock.calls.find(
      ([message]) => message.type === "mapObjectsInitialize",
    )![0];
    send({
      type: "mapObjectsInitializeResult",
      runtimeId: "first",
      requestId: firstMessage.requestId,
      success: true,
    });
    expect(await first).toBe(true);
    send({ type: "mapRuntimeReady", runtimeId: "unconfirmed", requestId: undefined });
    send({ type: "mapRuntimeReady", runtimeId: "stale", requestId: firstProbe });
    expect(wrapper.emitted("mapDataRequested")).toBeUndefined();
    send({ type: "mapRuntimeReady", runtimeId: "second" });
    expect(wrapper.emitted("mapDataRequested")).toHaveLength(1);
    const latest = wrapper.vm.initializeMapObjects({ markers: {}, shapes: [] });
    await flushPromises();
    const latestMessage = post.mock.calls
      .filter(([message]) => message.type === "mapObjectsInitialize")
      .at(-1)![0];
    expect(latestMessage.runtimeId).toBe("second");
    send({ type: "mapRuntimeReady", runtimeId: "stale", requestId: firstProbe });
    send({
      type: "mapObjectsInitializeResult",
      runtimeId: "second",
      requestId: latestMessage.requestId,
      success: true,
    });
    expect(await latest).toBe(true);
  });

  it("keeps a write owned by the parent after its originating frame is replaced", async () => {
    const { wrapper, send, post } = setup();
    await wrapper.get("iframe").trigger("load");
    send({ type: "mapRuntimeReady", runtimeId: "current" });
    const request = {
      requestId: "write-1",
      url: "/shape",
      method: "POST",
      body: { layer_id: "one" },
    };
    send({ type: "mapObjectWriteRequested", runtimeId: "current", request });
    expect(wrapper.emitted("mapObjectWriteRequested")).toHaveLength(1);
    const reply = wrapper.emitted("mapObjectWriteRequested")![0]![1] as (result: {
      status: number;
      data: unknown;
    }) => void;
    await wrapper.setProps({ srcUrl: "/map?layer=other&data_source=parent" });
    reply({ status: 201, data: { object: shape } });
    expect(post.mock.calls.some(([entry]) => entry.type === "mapObjectWriteResult")).toBe(false);
  });

  it("can transfer forty thousand records and restores the snapshot after frame regeneration", async () => {
    const { wrapper, send, post } = setup();
    await wrapper.get("iframe").trigger("load");
    send({ type: "mapRuntimeReady", runtimeId: "first" });
    const shapes = Array.from({ length: 40000 }, (_, i) => ({ ...shape, id: "s-" + i }));
    const initialization = wrapper.vm.initializeMapObjects({ markers: {}, shapes } as never);
    await flushPromises();
    const first = post.mock.calls.find(([entry]) => entry.type === "mapObjectsInitialize")![0];
    expect(first.snapshot.shapes).toHaveLength(40000);
    expect(first.snapshot.shapes).toBe(shapes);
    send({
      type: "mapObjectsInitializeResult",
      runtimeId: "first",
      requestId: first.requestId,
      success: true,
    });
    expect(await initialization).toBe(true);
    post.mockClear();
    expect(wrapper.vm.reloadMapFrame()).toBe(true);
    const replacementFrame = wrapper.get("iframe").element as HTMLIFrameElement;
    const replacementPost = vi
      .spyOn(replacementFrame.contentWindow!, "postMessage")
      .mockImplementation((message) => {
        structuredClone(message);
      });
    await wrapper.get("iframe").trigger("load");
    send({ type: "mapRuntimeReady", runtimeId: "second" });
    await flushPromises();
    expect(wrapper.emitted("mapDataRequested")).toHaveLength(1);
    expect(
      replacementPost.mock.calls.some(([entry]) => entry.type === "mapObjectsInitialize"),
    ).toBe(false);
    const latest = wrapper.vm.initializeMapObjects({
      markers: {},
      shapes: shapes.slice(1),
    } as never);
    await flushPromises();
    const second = replacementPost.mock.calls.find(
      ([entry]) => entry.type === "mapObjectsInitialize",
    )![0];
    expect(second.snapshot.shapes).toHaveLength(39999);
    expect(second.snapshot.shapes[0].id).toBe("s-1");
    expect(second.runtimeId).toBe("second");
    send({
      type: "mapObjectsInitializeResult",
      runtimeId: "second",
      requestId: second.requestId,
      success: true,
    });
    expect(await latest).toBe(true);
    expect(wrapper.emitted("mapLoaded")).toHaveLength(2);
  });
});
