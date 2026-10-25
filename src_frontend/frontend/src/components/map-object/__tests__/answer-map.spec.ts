import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import apiClient from "@/axiosClient";
import AnswerMapModal from "../AnswerMapModal.vue";
import AnswerColoringPanel from "../AnswerColoringPanel.vue";
import SaveMapPresetModal from "../SaveMapPresetModal.vue";
import SavedMapPresetsModal from "../SavedMapPresetsModal.vue";
import type { SavedMapPreset } from "@/utils/answer-map-presets";
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
  const filterPreset = (): SavedMapPreset => ({
    id: "preset",
    name: "耐用年数",
    kind: "filter",
    schema_version: 1,
    definition: {
      common_form_id: query.common_form_id,
      conditions: [
        {
          field_id: "n",
          field_type: "number",
          op: "gte",
          value: "9007199254740993.1",
          upper: null,
        },
      ],
    },
    display: {
      form_label: "施設情報",
      fields: [{ id: "n", field_type: "number", label: "耐用年数" }],
    },
    create_at: "2026-10-25T00:00:00Z",
  });
  const openSaved = async (w: ReturnType<typeof mount>) => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { items: [filterPreset()], total: 1, page: 1, page_size: 20 },
    });
    await click(w, "保存した検索条件");
    return w.getComponent(SavedMapPresetsModal);
  };
  it("保存は編集中の条件を複製し、モーダル取消で地図・入力・APIを変更しない", async () => {
    const w = await open(true);
    await ready(w);
    const iframe = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="入力項目"]').setValue("n:number");
    await w.get('[aria-label="条件の値"]').setValue("9007199254740993.1");
    const requests = post.mock.calls.length;
    await click(w, "検索条件を保存");
    const modal = w.getComponent(SaveMapPresetModal);
    expect(modal.props("draft")).toEqual({ kind: "filter", definition: filterPreset().definition });
    expect(modal.props("endpoint")).toBe("http://localhost:3000/form-answers/map-presets");
    expect(w.get(".content-fullscreen-map").attributes("inert")).toBeDefined();
    const key = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(key);
    send(w, { type: "answer-map-print-open" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(key.defaultPrevented).toBe(true);
    expect(w.emitted("close")).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(requests);
    expect(message).not.toHaveBeenCalled();
    expect(w.get('[aria-label="条件の値"]').element.value).toBe("9007199254740993.1");
    modal.vm.$emit("close");
    await flushPromises();
    expect(modal.props("isOpen")).toBe(false);
    expect(w.get("iframe").element).toBe(iframe);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    w.unmount();
  });
  it("印刷がない場合も保存一覧を開け、呼び出しは入力欄だけへ復元する", async () => {
    const w = await open();
    await ready(w);
    const iframe = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const list = await openSaved(w);
    const requests = post.mock.calls.length;
    list.vm.$emit("restore", filterPreset());
    await flushPromises();
    expect(list.props("isOpen")).toBe(false);
    expect(w.get('[aria-label="共通フォーム"]').element.value).toBe(query.common_form_id);
    expect(w.get('[aria-label="入力項目"]').element.value).toBe("n:number");
    expect(w.get('[aria-label="条件の値"]').element.value).toBe("9007199254740993.1");
    expect(post).toHaveBeenCalledTimes(requests + 1);
    expect(post.mock.calls.at(-1)![1]).toMatchObject({
      common_form_id: query.common_form_id,
      conditions: [],
      options_only: true,
    });
    expect(message).not.toHaveBeenCalled();
    expect(w.get(".map-status").text()).toContain("一覧と同じ範囲");
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(false);
    expect(w.get("iframe").element).toBe(iframe);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    await click(w, "絞り込み実行");
    expect(message.mock.calls.at(-1)![0]).toMatchObject({
      type: "answer-map-filter",
      targets: keys,
    });
    w.unmount();
  });
  it("色分けの呼び出しは絞り込みの編集中条件と反映済み表示を維持する", async () => {
    const w = await open();
    await ready(w);
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="入力項目"]').setValue("n:number");
    await w.get('[aria-label="条件の値"]').setValue("25");
    const iframe = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const list = await openSaved(w);
    const preset: SavedMapPreset = {
      ...filterPreset(),
      kind: "coloring",
      definition: {
        common_form_id: query.common_form_id,
        rules: [
          {
            id: "fifty",
            label: "50年以上",
            color: "#2166ac",
            conditions: [
              { field_id: "n", field_type: "number", op: "gte", value: "50", upper: null },
            ],
          },
        ],
      },
    };
    list.vm.$emit("restore", preset);
    await flushPromises();
    expect(list.props("isOpen")).toBe(false);
    expect(w.get('[aria-label="条件の値"]').element.value).toBe("25");
    expect(w.get('[aria-label="分類名"]').element.value).toBe("50年以上");
    expect(w.get('[aria-label="色分けの条件値"]').element.value).toBe("50");
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(false);
    expect(message).not.toHaveBeenCalled();
    expect(w.get(".map-status").text()).toContain("一覧と同じ範囲");
    w.unmount();
  });
  it("項目の不整合や候補取得の失敗では一覧を維持し、現在の入力を消さない", async () => {
    const w = await open();
    await ready(w);
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="入力項目"]').setValue("n:number");
    await w.get('[aria-label="条件の値"]').setValue("25");
    const list = await openSaved(w);
    const preset = filterPreset();
    if (preset.kind === "filter") preset.definition.conditions[0]!.field_type = "text";
    if (preset.kind === "filter") preset.definition.conditions[0]!.op = "eq";
    list.vm.$emit("restore", preset);
    await flushPromises();
    expect(list.props("isOpen")).toBe(true);
    expect(list.props("restoreError")).toContain("項目が見つかりません");
    expect(w.get('[aria-label="条件の値"]').element.value).toBe("25");
    post.mockRejectedValueOnce(Error("network"));
    list.vm.$emit("restore", filterPreset());
    await flushPromises();
    expect(list.props("restoreError")).toContain("現在の入力を維持");
    expect(w.get('[aria-label="条件の値"]').element.value).toBe("25");
    const requests = post.mock.calls.length;
    const incompatible = filterPreset();
    incompatible.definition.common_form_id = "other";
    list.vm.$emit("restore", incompatible);
    await flushPromises();
    expect(list.props("restoreError")).toContain("共通フォームが異なる");
    expect(post).toHaveBeenCalledTimes(requests);
    w.unmount();
  });
  it("呼び出し中に一覧を閉じた後の応答は破棄する", async () => {
    const w = await open();
    await ready(w);
    const list = await openSaved(w);
    let resolve!: (response: { data: ReturnType<typeof result> }) => void;
    post.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    list.vm.$emit("restore", filterPreset());
    await flushPromises();
    expect(list.props("restoring")).toBe(true);
    list.vm.$emit("close");
    await flushPromises();
    resolve({ data: result() });
    await flushPromises();
    expect(list.props("isOpen")).toBe(false);
    expect(w.get('[aria-label="共通フォーム"]').element.value).toBe("");
    expect(w.find('[aria-label="条件の値"]').exists()).toBe(false);
    w.unmount();
  });
  it("分類の優先順位を保って一括送信し、ACK後だけ反映済みにし、解除ではAPI再検索しない", async () => {
    const w = await open();
    await ready(w);
    const iframe = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const specification = {
      common_form_id: query.common_form_id,
      rules: [
        {
          id: "first",
          label: "優先",
          color: "#d73027",
          conditions: [
            { field_id: "n", field_type: "number", op: "gte", value: "20", upper: null },
          ],
        },
        {
          id: "second",
          label: "次",
          color: "#2166ac",
          conditions: [{ field_id: "n", field_type: "number", op: "gte", value: "0", upper: null }],
        },
      ],
    };
    post
      .mockResolvedValueOnce({ data: result([keys[0]]) })
      .mockResolvedValueOnce({ data: result(keys) });
    w.getComponent(AnswerColoringPanel).vm.$emit("apply", specification);
    await flushPromises();
    const command = message.mock.calls.at(-1)![0];
    expect(command).toMatchObject({
      type: "answer-map-filter",
      targets: keys,
      coloring: {
        version: 1,
        targets: { [keys[0]]: "first", [keys[1]]: "second" },
      },
    });
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(false);
    send(w, {
      type: "answer-map-filter-applied",
      updateId: command.updateId,
      visible: 2,
      renderable: 2,
    });
    await flushPromises();
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(true);
    const requests = post.mock.calls.length;
    w.getComponent(AnswerColoringPanel).vm.$emit("apply", null);
    await flushPromises();
    expect(post).toHaveBeenCalledTimes(requests);
    const clear = message.mock.calls.at(-1)![0];
    expect(clear).toMatchObject({ type: "answer-map-filter", targets: keys, coloring: null });
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(true);
    send(w, {
      type: "answer-map-filter-applied",
      updateId: clear.updateId,
      visible: 2,
      renderable: 2,
    });
    await flushPromises();
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(false);
    expect(w.get("iframe").element).toBe(iframe);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1);
    w.unmount();
  });
  it("色分けは未反映の絞り込み編集を使わず、反映済み条件と同じ回答に適用する", async () => {
    const w = await open();
    await ready(w);
    const iframe = w.get("iframe").element as HTMLIFrameElement;
    const message = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    await w.get('[aria-label="共通フォーム"]').setValue(query.common_form_id);
    await flushPromises();
    await click(w, "条件を追加");
    await w.get('[aria-label="入力項目"]').setValue("n:number");
    await w.get('[aria-label="条件の値"]').setValue("20");
    await click(w, "絞り込み実行");
    send(w, {
      type: "answer-map-filter-applied",
      updateId: message.mock.calls.at(-1)![0].updateId,
      visible: 2,
      renderable: 2,
    });
    await flushPromises();
    await w.get('[aria-label="条件の値"]').setValue("999");
    w.getComponent(AnswerColoringPanel).vm.$emit("apply", {
      common_form_id: query.common_form_id,
      rules: [
        {
          id: "a",
          label: "分類",
          color: "#2166ac",
          conditions: [
            { field_id: "n", field_type: "number", op: "lte", value: "30", upper: null },
          ],
        },
      ],
    });
    await flushPromises();
    const request = post.mock.calls.at(-1)![1] as any;
    expect(request.query.conditions).toEqual([]);
    expect(request.conditions.map((c: any) => c.value)).toEqual(["20", "30"]);
    expect(w.get('[aria-label="条件の値"]').element).toHaveProperty("value", "999");
    w.unmount();
  });
  it("分類の一部取得失敗では地図へ何も送らず、直前表示を維持する", async () => {
    const w = await open();
    await ready(w);
    const message = vi
      .spyOn((w.get("iframe").element as HTMLIFrameElement).contentWindow!, "postMessage")
      .mockImplementation(() => {});
    post.mockResolvedValueOnce({ data: result(keys) }).mockRejectedValueOnce(Error("network"));
    const rule = {
      label: "分類",
      color: "#2166ac",
      conditions: [{ field_id: "n", field_type: "number", op: "gte", value: "20", upper: null }],
    };
    w.getComponent(AnswerColoringPanel).vm.$emit("apply", {
      common_form_id: query.common_form_id,
      rules: [
        { ...rule, id: "a" },
        { ...rule, id: "b" },
      ],
    });
    await flushPromises();
    expect(message).not.toHaveBeenCalled();
    expect(w.text()).toContain("直前の表示を維持");
    expect(w.getComponent(AnswerColoringPanel).props("active")).toBe(false);
    w.unmount();
  });
  it("絞り込み再実行では反映済みの分類を再評価し、閉じた後の分類応答は破棄する", async () => {
    const w = await open();
    await ready(w);
    const message = vi
      .spyOn((w.get("iframe").element as HTMLIFrameElement).contentWindow!, "postMessage")
      .mockImplementation(() => {});
    const specification = {
      common_form_id: query.common_form_id,
      rules: [
        {
          id: "a",
          label: "反映済み",
          color: "#2166ac",
          conditions: [
            { field_id: "n", field_type: "number", op: "gte", value: "20", upper: null },
          ],
        },
      ],
    };
    w.getComponent(AnswerColoringPanel).vm.$emit("apply", specification);
    await flushPromises();
    send(w, {
      type: "answer-map-filter-applied",
      updateId: message.mock.calls.at(-1)![0].updateId,
      visible: 2,
      renderable: 2,
    });
    await flushPromises();
    specification.rules[0].conditions[0].value = "999";
    post
      .mockResolvedValueOnce({ data: result([keys[1]]) })
      .mockResolvedValueOnce({ data: result([keys[1]]) });
    await click(w, "絞り込み実行");
    const request = post.mock.calls.at(-1)![1] as any;
    expect(request.conditions[0].value).toBe("20");
    const update = message.mock.calls.at(-1)![0];
    expect(update).toMatchObject({ targets: [keys[1]], coloring: { targets: { [keys[1]]: "a" } } });
    send(w, {
      type: "answer-map-filter-applied",
      updateId: update.updateId,
      visible: 1,
      renderable: 1,
    });
    await flushPromises();
    let resolve!: (value: any) => void;
    post.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const count = message.mock.calls.length;
    w.getComponent(AnswerColoringPanel).vm.$emit("apply", specification);
    await flushPromises();
    await w.setProps({ isOpen: false });
    resolve({ data: result(keys) });
    await flushPromises();
    expect(message).toHaveBeenCalledTimes(count);
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
    const requestId = id(w);
    send(w, error);
    await flushPromises();
    expect(apiClient.get).toHaveBeenCalledWith(
      "/account/auth",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
    expect(id(w)).toBe(requestId);
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
