import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import apiClient from "@/axiosClient";
import AnswerMapModal from "../AnswerMapModal.vue";
import modalSource from "../AnswerMapModal.vue?raw";
vi.mock("@/axiosClient", () => ({
  default: { post: vi.fn(), get: vi.fn(), isAxiosError: () => false },
}));
const post = vi.mocked(apiClient.post);
const action = "http://localhost:3000/form-answers/map";
const keys = [
  "marker:00000000-0000-4000-8000-000000000001",
  "shape:00000000-0000-4000-8000-000000000001",
];
const query = {
  mode: "latest",
  as_of: "2026-10-20T00:00:00Z",
  common_form_id: "00000000-0000-4000-8000-000000000010",
  conditions: [],
};
const fields = [
  { id: "d", label: "建設年月日", field_type: "date", choices: [] },
  { id: "n", label: "耐用年数", field_type: "number", choices: [] },
];
const forms = [{ id: query.common_form_id, label: "施設情報" }];
const result = (targets = keys) => ({
  forms,
  fields,
  forms_overflow: false,
  targets,
  target_count: targets.length,
  answer_count: targets.length,
});
beforeEach(() => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
  post.mockReset();
  post.mockResolvedValue({ data: result() });
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const open = async (printEnabled = false) => {
  const w = mount(AnswerMapModal, {
    attachTo: document.body,
    props: { isOpen: true, action, query, printEnabled },
  });
  await flushPromises();
  return w;
};
const id = (w: ReturnType<typeof mount>) =>
  (w.get('input[name="request_id"]').element as HTMLInputElement).value;
const send = (
  w: ReturnType<typeof mount>,
  data: Record<string, unknown>,
  origin = "http://localhost:3000",
  source?: Window | null,
) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: source ?? (w.get("iframe").element as HTMLIFrameElement).contentWindow,
      data: { requestId: id(w), ...data },
    }),
  );
const ready = async (w: ReturnType<typeof mount>) => {
  send(w, {
    type: "answer-map-ready",
    answerCount: 2,
    targetCount: 2,
    displayed: 2,
    skipped: 0,
    query,
    targets: keys,
  });
  await flushPromises();
};
const click = async (w: ReturnType<typeof mount>, text: string) => {
  await w
    .findAll("button")
    .find((b) => b.text() === text)!
    .trigger("click");
  await flushPromises();
};
describe("回答地図の非同期絞り込み", () => {
  it("モバイル専用の機能切替指定を地図要求に付ける", async () => {
    const w = await open();
    const native = w.get('form[target^="answer-map-"]');
    const url = new URL(native.attributes("action")!);
    expect(url.searchParams.get("map_ui")).toBe("mobile");
    expect(url.pathname).toBe("/form-answers/map");
    w.unmount();
  });
  it("CSV用iframeは地図用CSSがあっても非表示を保ち、レイアウトへ参加しない", async () => {
    const style = document.createElement("style");
    style.textContent = modalSource.match(/<style scoped>([\s\S]*?)<\/style>/)![1];
    document.head.append(style);
    const w = await open(true);
    try {
      const map = w.get('iframe[title="回答条件に一致する対象の地図"]').element;
      const csv = w.get('iframe[title="回答地図CSVダウンロード"]').element;
      expect(getComputedStyle(map).display).toBe("block");
      expect(getComputedStyle(csv).display).toBe("none");
    } finally {
      w.unmount();
      style.remove();
    }
  });
  it("CSVは未反映の編集を使わず、表示対象と反映済み条件を固定して認証更新後も同じ内容を送る", async () => {
    const w = await open(true);
    await ready(w);
    const frame = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="入力項目"]').setValue("n:number");
    await w.get('[aria-label="条件の値"]').setValue("20");
    await click(w, "絞り込み実行");
    const updateId = message.mock.calls.at(-1)![0].updateId;
    send(w, { type: "answer-map-filter-applied", updateId, visible: 2, renderable: 2 });
    await flushPromises();
    await w.get('[aria-label="条件の値"]').setValue("999");
    await click(w, "CSV出力");
    const capture = message.mock.calls.at(-1)![0];
    expect(capture.type).toBe("answer-map-csv-request");
    const calls = post.mock.calls.length;
    send(w, { type: "answer-map-csv-targets", csvRequestId: "old", updateId, targets: keys });
    await flushPromises();
    expect(post).toHaveBeenCalledTimes(calls);
    post.mockResolvedValueOnce({ data: { count: 3 } });
    send(w, {
      type: "answer-map-csv-targets",
      csvRequestId: capture.csvRequestId,
      updateId,
      targets: [keys[0]],
    });
    await flushPromises();
    const [url, body] = post.mock.calls.at(-1)!;
    expect(url).toBe("http://localhost:3000/form-answers/map-csv-check");
    expect(body).toMatchObject({
      query,
      targets: [keys[0]],
      common_form_id: query.common_form_id,
      conditions: [{ field_id: "n", field_type: "number", op: "gte", value: "20" }],
    });
    const form = w
      .findAll("form")
      .find((f) => f.attributes("action")?.includes("map-csv-download"))!;
    const frozen = new FormData(form.element as HTMLFormElement).get("query");
    expect(JSON.parse(frozen as string)).toEqual(body);
    const csvFrame = w.get('iframe[title="回答地図CSVダウンロード"]').element as HTMLIFrameElement;
    send(
      w,
      {
        type: "native-form-auth-error",
        error: "token_expired",
        requestId: new URL(form.attributes("action")!).searchParams.get("native_request_id"),
      },
      undefined,
      csvFrame.contentWindow,
    );
    await flushPromises();
    expect(apiClient.get).toHaveBeenCalledWith("/account/auth", expect.anything());
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(3);
    expect(new FormData(form.element as HTMLFormElement).get("query")).toBe(frozen);
    expect(w.get("iframe").element).toBe(frame);
    await click(w, "地図条件を解除");
    const reset = message.mock.calls.at(-1)![0];
    send(w, {
      type: "answer-map-filter-applied",
      updateId: reset.updateId,
      visible: 2,
      renderable: 2,
    });
    await flushPromises();
    await click(w, "CSV出力");
    const next = message.mock.calls.at(-1)![0];
    post.mockResolvedValueOnce({ data: { count: 0 } });
    send(w, {
      type: "answer-map-csv-targets",
      csvRequestId: next.csvRequestId,
      updateId: reset.updateId,
      targets: keys,
    });
    await flushPromises();
    expect(post.mock.calls.at(-1)![1]).toMatchObject({ common_form_id: null, conditions: [] });
    expect(w.text()).toContain("出力対象の回答がありません");
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(3);
    w.unmount();
  });
  it("CSVの不正な対象を拒否し、通信中に閉じた場合は送信しない", async () => {
    const w = await open(true);
    await ready(w);
    const frame = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await click(w, "CSV出力");
    let capture = message.mock.calls.at(-1)![0];
    const calls = post.mock.calls.length;
    send(w, {
      type: "answer-map-csv-targets",
      csvRequestId: capture.csvRequestId,
      updateId: "",
      targets: ["marker:outside"],
    });
    await flushPromises();
    expect(post).toHaveBeenCalledTimes(calls);
    expect(w.text()).toContain("CSVの対象を取得できませんでした");
    await click(w, "CSV出力");
    capture = message.mock.calls.at(-1)![0];
    let resolve!: (v: any) => void;
    post.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    send(w, {
      type: "answer-map-csv-targets",
      csvRequestId: capture.csvRequestId,
      updateId: "",
      targets: keys,
    });
    await flushPromises();
    const signal = post.mock.calls.at(-1)![2]!.signal!;
    await w.setProps({ isOpen: false });
    expect(signal.aborted).toBe(true);
    resolve({ data: { count: 2 } });
    await flushPromises();
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    w.unmount();
  });
  it("PCだけで反映済み地図の印刷状態を要求し、古い応答を無視して閉じた後も地図を保持する", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    const w = await open(true);
    await ready(w);
    const originalFrame = w.get('iframe[title="回答条件に一致する対象の地図"]')
      .element as HTMLIFrameElement;
    const postMessage = vi.spyOn(originalFrame.contentWindow!, "postMessage");
    await click(w, "地図を印刷");
    const command = postMessage.mock.calls.at(-1)![0];
    expect(command.type).toBe("answer-map-print-request");
    send(w, { type: "answer-map-print-state", printRequestId: "old", snapshot: {}, updateId: "" });
    await flushPromises();
    expect(w.find("dialog").exists()).toBe(false);
    send(w, {
      type: "answer-map-print-state",
      printRequestId: command.printRequestId,
      snapshot: { state: {}, bootstrap: {} },
      updateId: "",
    });
    await flushPromises();
    expect(w.find("dialog").exists()).toBe(true);
    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    window.dispatchEvent(escape);
    expect(w.emitted("close")).toBeUndefined();
    await w.get(".print-header button").trigger("click");
    await flushPromises();
    expect(w.find("dialog").exists()).toBe(false);
    expect(w.get('iframe[title="回答条件に一致する対象の地図"]').element).toBe(originalFrame);
    expect(w.text()).toContain("一致2件");
    w.unmount();
    const mobile = await open();
    await ready(mobile);
    expect(mobile.findAll("button").some((b) => b.text() === "地図を印刷")).toBe(false);
    mobile.unmount();
  });
  it("初回表示の401では認証を確認して同じフォームを再送し、ready後は再送しない", async () => {
    const w = await open();
    const action = new URL(w.get("form").attributes("action")!);
    const error = {
      type: "native-form-auth-error",
      requestId: action.searchParams.get("native_request_id"),
      error: "token_expired",
    };
    expect(action.searchParams.get("map_ui")).toBe("mobile");
    const requestId = id(w);
    send(w, error);
    await flushPromises();
    expect(apiClient.get).toHaveBeenCalledWith(
      "/account/auth",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
    expect(id(w)).toBe(requestId);
    expect(new URL(w.get("form").attributes("action")!).searchParams.get("map_ui")).toBe("mobile");
    await ready(w);
    send(w, error);
    await flushPromises();
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
    w.unmount();
  });
  it("絞り込みエリアを開閉しても入力条件とiframeを再作成しない", async () => {
    const w = await open();
    await ready(w);
    expect(w.get('[role="dialog"]').attributes("aria-label")).toBe("地図で分析・検索・出力");
    expect(w.get("header strong").text()).toBe("地図で分析・検索・出力");
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="条件の値"]').setValue("2020-04-01");
    const iframe = w.get("iframe").element;
    const input = w.get('[aria-label="条件の値"]').element;
    const requests = post.mock.calls.length;
    const toggle = w.get(".answer-map-filter-toggle");
    expect(toggle.attributes("aria-controls")).toBe(w.get(".filter-sidebar").attributes("id"));
    await click(w, "絞り込みを閉じる");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(w.get(".answer-map-body").classes()).toContain("filters-closed");
    await click(w, "絞り込みを開く");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(w.get('[aria-label="条件の値"]').element).toBe(input);
    expect((input as HTMLInputElement).value).toBe("2020-04-01");
    expect(w.get("iframe").element).toBe(iframe);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(requests);
    w.unmount();
  });
  it("初期表示では送信元・要求IDを検証し、不正な通知を無視する", async () => {
    const w = await open();
    const data = {
      type: "answer-map-ready",
      answerCount: 12,
      targetCount: 5,
      displayed: 4,
      skipped: 1,
    };
    send(w, data, "http://wrong.test");
    send(w, data, undefined, window);
    send(w, { ...data, requestId: "old" });
    await flushPromises();
    expect(w.text()).toContain("読み込んでいます");
    send(w, data);
    await flushPromises();
    expect(w.text()).toContain("一致回答12件");
    expect(w.text()).toContain("1件を表示できませんでした");
    await click(w, "閉じる");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
  it("サーバーの初期エラーと再試行を処理する", async () => {
    const w = await open(),
      old = id(w);
    send(w, { type: "answer-map-error", message: "条件を絞り込んでください。" });
    await flushPromises();
    expect(w.text()).toContain("条件を絞り込んでください");
    await click(w, "再試行");
    expect(id(w)).not.toBe(old);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
    w.unmount();
  });
  it("日付・数値条件をJSON送信し、iframeを再読込せずACK後に件数を反映する", async () => {
    const w = await open();
    await ready(w);
    const iframe = w.get("iframe").element;
    const message = vi
      .spyOn((iframe as HTMLIFrameElement).contentWindow!, "postMessage")
      .mockImplementation(() => {});
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="比較方法"]').setValue("between");
    await w.get('[aria-label="条件の値"]').setValue("2020-04-01");
    await w.get('[aria-label="範囲の終了値"]').setValue("2025-03-31");
    await click(w, "条件を追加");
    await w.findAll('[aria-label="入力項目"]')[1].setValue("n:number");
    await w.findAll('[aria-label="条件の値"]')[1].setValue("20");
    post.mockResolvedValueOnce({ data: result([keys[0]]) });
    await click(w, "絞り込み実行");
    const body = post.mock.calls.at(-1)![1] as any;
    expect(body.query).toEqual(query);
    expect(body.targets).toEqual(keys);
    expect(body.conditions).toEqual([
      {
        field_id: "d",
        field_type: "date",
        op: "between",
        value: "2020-04-01",
        upper: "2025-03-31",
      },
      { field_id: "n", field_type: "number", op: "gte", value: "20", upper: null },
    ]);
    const command = message.mock.calls.at(-1)![0];
    expect(command.type).toBe("answer-map-filter");
    expect(w.text()).toContain("一致2件");
    send(w, { type: "answer-map-filter-applied", updateId: "stale", visible: 1, renderable: 1 });
    await flushPromises();
    expect(w.text()).toContain("一致2件");
    send(w, {
      type: "answer-map-filter-applied",
      updateId: command.updateId,
      visible: 1,
      renderable: 1,
    });
    await flushPromises();
    expect(w.text()).toContain("一致1件");
    expect(w.get("iframe").element).toBe(iframe);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    await click(w, "地図条件を解除");
    const resetBody = post.mock.calls.at(-1)![1] as any;
    expect(resetBody.conditions).toEqual([]);
    expect(resetBody.common_form_id).toBeNull();
    expect(resetBody.query).toEqual(query);
    w.unmount();
  });
  it("0件でも地図・条件を維持し、通信失敗では直前の表示を変えない", async () => {
    const w = await open();
    await ready(w);
    const frame = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    post.mockResolvedValueOnce({ data: result([]) });
    await click(w, "絞り込み実行");
    const command = message.mock.calls.at(-1)![0];
    send(w, {
      type: "answer-map-filter-applied",
      updateId: command.updateId,
      visible: 0,
      renderable: 0,
    });
    await flushPromises();
    expect(w.text()).toContain("条件に一致する対象がありません");
    post.mockRejectedValueOnce(new Error("network"));
    await click(w, "絞り込み実行");
    expect(w.text()).toContain("直前の表示を維持");
    expect(w.text()).toContain("一致0件");
    expect(w.get("iframe").element).toBe(frame);
    w.unmount();
  });
  it("閉じた画面のAPI応答を無視する", async () => {
    const w = await open();
    let resolve!: (value: any) => void;
    post.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    send(w, {
      type: "answer-map-ready",
      answerCount: 2,
      targetCount: 2,
      displayed: 2,
      skipped: 0,
      query,
      targets: keys,
    });
    await flushPromises();
    const signal = post.mock.calls.at(-1)![2]!.signal!;
    await w.setProps({ isOpen: false });
    expect(signal.aborted).toBe(true);
    resolve({ data: result() });
    await flushPromises();
    expect(w.find("iframe").exists()).toBe(false);
    w.unmount();
  });
  it("初期応答がなくても閉じられる", async () => {
    vi.useFakeTimers();
    const w = await open();
    await vi.advanceTimersByTimeAsync(60000);
    expect(w.text()).toContain("再試行してください");
    await click(w, "閉じる");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
});
