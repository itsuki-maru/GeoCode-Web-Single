import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { reactive } from "vue";
import MapIframe from "../MapIframe.vue";

let wrapper: VueWrapper;
afterEach(() => {
  wrapper?.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
});
const coloring = {
  version: 1 as const,
  rules: [{ id: "red", label: "要対応", color: "#ff0000" }],
  targets: { "shape:one": "red", "marker:two": "red" },
};
async function setup() {
  const mounted = mount(MapIframe, {
    attachTo: document.body,
    props: { srcUrl: "/map?layer=one", height: 80, allowedOrigins: window.location.origin },
  });
  wrapper = mounted;
  const iframe = mounted.get("iframe");
  const frameWindow = (iframe.element as HTMLIFrameElement).contentWindow!;
  const post = vi.spyOn(frameWindow, "postMessage").mockImplementation((message) => {
    structuredClone(message);
  });
  const send = (
    data: Record<string, unknown>,
    source: Window = frameWindow,
    origin = window.location.origin,
  ) => window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
  await iframe.trigger("load");
  send({ type: "mapRuntimeReady", runtimeId: "current" });
  const probe = post.mock.calls.at(-1)![0];
  send({ type: "mapRuntimeReady", runtimeId: "current", requestId: probe.requestId });
  post.mockClear();
  return { mounted, iframe, post, send };
}

it.each(["coloring", "filter"])(
  "%sは対応する地図・送信元・要求の完了応答だけで確定する",
  async (kind) => {
    const { mounted, post, send } = await setup();
    const pending =
      kind === "coloring"
        ? mounted.vm.setColoring(reactive(coloring))
        : mounted.vm.filterMapObjectsAndWait(["two"], ["one"]);
    const request = post.mock.calls.at(-1)![0];
    expect(request).toMatchObject({
      type: kind === "coloring" ? "mapColoringApply" : "mapObjectFilter",
      runtimeId: "current",
    });
    expect(() => structuredClone(request)).not.toThrow();
    const reply = {
      type: kind === "coloring" ? "mapColoringApplyResult" : "mapObjectFilterResult",
      runtimeId: "current",
      requestId: request.requestId,
      success: true,
    };
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    send(reply, window);
    send({ ...reply, runtimeId: "old" });
    send({ ...reply, runtimeId: undefined });
    send({ ...reply, requestId: "old" });
    await flushPromises();
    expect(finished).toBe(false);
    send(reply);
    await expect(pending).resolves.toBe(true);
  },
);

it("失敗応答やタイムアウトでは成功せず、直前の色分けを再描画時に復元する", async () => {
  vi.useFakeTimers();
  const { mounted, iframe, post, send } = await setup();
  const first = mounted.vm.setColoring(coloring);
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: post.mock.calls.at(-1)![0].requestId,
    success: true,
  });
  await expect(first).resolves.toBe(true);
  const failed = mounted.vm.setColoring({ ...coloring, targets: {} });
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: post.mock.calls.at(-1)![0].requestId,
    success: false,
  });
  await expect(failed).resolves.toBe(false);
  const timeout = mounted.vm.filterMapObjectsAndWait(null, null);
  await vi.advanceTimersByTimeAsync(10000);
  await expect(timeout).resolves.toBe(false);
  await iframe.trigger("load");
  const restored = post.mock.calls.filter(([m]) => m.type === "mapColoringApply").at(-1)![0];
  expect(restored.coloring).toEqual(coloring);
});

it("レイヤ切替後の遅い応答を破棄し、適用待ちだった色分けを復元しない", async () => {
  const { mounted, post, send } = await setup();
  const pending = mounted.vm.setColoring(coloring);
  const old = post.mock.calls.at(-1)![0];
  await mounted.setProps({ srcUrl: "/map?layer=other" });
  await expect(pending).resolves.toBe(false);
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: old.requestId,
    success: true,
  });
  post.mockClear();
  await mounted.get("iframe").trigger("load");
  expect(post.mock.calls.some(([m]) => m.type === "mapColoringApply")).toBe(false);
});

it("適用済みの色分けを解除すると再描画時にも復元しない", async () => {
  const { mounted, iframe, post, send } = await setup();
  const pending = mounted.vm.setColoring(coloring);
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: post.mock.calls.at(-1)![0].requestId,
    success: true,
  });
  await expect(pending).resolves.toBe(true);
  const clear = mounted.vm.setColoring(null);
  const clearRequest = post.mock.calls.at(-1)![0];
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: clearRequest.requestId,
    success: true,
  });
  await expect(clear).resolves.toBe(true);
  post.mockClear();
  await iframe.trigger("load");
  expect(post.mock.calls.some(([m]) => m.type === "mapColoringApply")).toBe(false);
});

it("色分け解除に失敗した後も確定済みの色分けを再描画できる", async () => {
  const { mounted, iframe, post, send } = await setup();
  const pending = mounted.vm.setColoring(coloring);
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: post.mock.calls.at(-1)![0].requestId,
    success: true,
  });
  await expect(pending).resolves.toBe(true);
  const clear = mounted.vm.setColoring(null);
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: post.mock.calls.at(-1)![0].requestId,
    success: false,
  });
  await expect(clear).resolves.toBe(false);
  post.mockClear();
  await iframe.trigger("load");
  expect(
    post.mock.calls.some(
      ([m]) => m.type === "mapColoringApply" && m.coloring?.targets["shape:one"] === "red",
    ),
  ).toBe(true);
});
it("解除がタイムアウトしても確定済みの色を再描画できる", async () => {
  vi.useFakeTimers();
  const { mounted, iframe, post, send } = await setup();
  const pending = mounted.vm.setColoring(coloring);
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: post.mock.calls.at(-1)![0].requestId,
    success: true,
  });
  await expect(pending).resolves.toBe(true);
  const clear = mounted.vm.setColoring(null);
  await vi.advanceTimersByTimeAsync(10000);
  await expect(clear).resolves.toBe(false);
  post.mockClear();
  await iframe.trigger("load");
  expect(post.mock.calls.find(([m]) => m.type === "mapColoringApply")?.[0].coloring).toEqual(
    coloring,
  );
});

it("レイヤ切替による破棄は失敗応答や遅い適用成功が届いても旧色を復元しない", async () => {
  const { mounted, iframe, post, send } = await setup();
  const pending = mounted.vm.setColoring(coloring);
  const old = post.mock.calls.at(-1)![0];
  const discard = mounted.vm.discardColoring();
  const clear = post.mock.calls.at(-1)![0];
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: clear.requestId,
    success: false,
  });
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: old.requestId,
    success: true,
  });
  await expect(discard).resolves.toBe(false);
  await expect(pending).resolves.toBe(false);
  post.mockClear();
  await iframe.trigger("load");
  expect(post.mock.calls.some(([m]) => m.type === "mapColoringApply")).toBe(false);
});

it("古い解除の完了応答で新しい色分けの復元データを消さない", async () => {
  const { mounted, iframe, post, send } = await setup();
  const clear = mounted.vm.setColoring(null),
    clearRequest = post.mock.calls.at(-1)![0];
  const next = mounted.vm.setColoring(coloring),
    nextRequest = post.mock.calls.at(-1)![0];
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: nextRequest.requestId,
    success: true,
  });
  send({
    type: "mapColoringApplyResult",
    runtimeId: "current",
    requestId: clearRequest.requestId,
    success: true,
  });
  await expect(next).resolves.toBe(true);
  await expect(clear).resolves.toBe(false);
  post.mockClear();
  await iframe.trigger("load");
  expect(post.mock.calls.find(([m]) => m.type === "mapColoringApply")?.[0].coloring).toEqual(
    coloring,
  );
});
