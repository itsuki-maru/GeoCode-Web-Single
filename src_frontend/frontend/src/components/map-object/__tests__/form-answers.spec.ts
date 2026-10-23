import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Input from "../MapObjectFormInputModal.vue";
import FormAnswersModal from "@/components/map-object/FormAnswersModal.vue";
const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), isAxiosError: vi.fn(() => false) }));
vi.mock("@/axiosClient", () => ({ default: api }));
const field = { id: "amount", label: "現在の項目名", field_type: "number", choices: [] };
const row = {
  id: "answer",
  target_type: "marker",
  target_id: "target",
  target_name: "対象A",
  layer_id: "layer",
  layer_name: "レイヤ",
  create_at: "2026-01-01T00:00:00",
  source_form: { id: "common", version: 1 },
  common_form_name: "共通",
  common_form_deleted: true,
  form_snapshot: {
    form_title: "投稿時の名前",
    form_description: "当時の説明",
    form_schema: {
      fields: [
        { id: "amount", label: "当時の項目名", type: "number" },
        { id: "flag", label: "確認", type: "checkbox" },
      ],
    },
  },
  submitted_values: { amount: 0, flag: false },
};
const options = {
  forms: [{ id: "common", name: "共通", deleted: true }],
  layers: [{ id: "layer", name: "レイヤ" }],
  versions: [2, 1],
  fields: [field],
};
const result = {
  rows: [row],
  total: 60,
  as_of: "2026-01-02T00:00:00Z",
  next_cursor: { id: "answer", at: row.create_at, target_type: "marker" },
};
beforeEach(() => {
  api.get.mockResolvedValue({ data: {} });
  api.post.mockImplementation(async (url: string) => ({
    data: url.endsWith("options") ? options : url.endsWith("csv-check") ? { count: 60 } : result,
  }));
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
});
const open = async (props = {}) => {
  const wrapper = mount(FormAnswersModal, {
    attachTo: document.body,
    props: { isOpen: false, ...props },
  });
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  return wrapper;
};
const button = (wrapper: ReturnType<typeof mount>, text: string) =>
  wrapper.findAll("button").find((button) => button.text() === text)!;
const select = (wrapper: ReturnType<typeof mount>, label: string) =>
  wrapper
    .findAll("label")
    .find((item) => item.text().startsWith(label))!
    .get("select");
it("CSVの実ダウンロードで401になっても適用済み条件のまま再送し、閉じると通知を破棄する", async () => {
  const wrapper = await open({ initialFormId: "common" });
  await button(wrapper, "CSV出力").trigger("click");
  await flushPromises();
  const form = wrapper
    .findAll("form")
    .find((f) =>
      new URL(f.attributes("action") || location.href, location.href).pathname.endsWith(
        "/form-answers/download",
      ),
    )!;
  const query = form.get('input[name="query"]').element as HTMLInputElement;
  const originalQuery = query.value;
  const frame = wrapper.get('iframe[title="回答CSVダウンロード"]').element as HTMLIFrameElement;
  const action = new URL(form.attributes("action")!);
  const sendError = () =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: action.origin,
        data: {
          type: "native-form-auth-error",
          requestId: action.searchParams.get("native_request_id"),
          error: "token_expired",
        },
      }),
    );
  sendError();
  await flushPromises();
  expect(api.get).toHaveBeenCalledWith(
    "/account/auth",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
  expect(query.value).toBe(originalQuery);
  expect(api.post.mock.calls.filter(([url]) => url === "/form-answers/csv-check")).toHaveLength(1);
  await wrapper.setProps({ isOpen: false });
  sendError();
  await flushPromises();
  expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
  wrapper.unmount();
});
describe("回答一覧", () => {
  it("地図には未反映の変更を混ぜず、一覧の全ページ条件と検索基準日時を渡す", async () => {
    const wrapper = await open({ initialFormId: "common" });
    await select(wrapper, "表示モード").setValue("latest");
    await button(wrapper, "地図で確認").trigger("click");
    await flushPromises();
    const native = wrapper
      .findAll("form")
      .find((f) =>
        new URL(f.attributes("action")!, window.location.href).pathname.endsWith(
          "/form-answers/map",
        ),
      )!;
    const sent = JSON.parse((native.get('input[name="query"]').element as HTMLInputElement).value);
    expect(sent).toEqual(
      expect.objectContaining({
        common_form_id: "common",
        mode: "history",
        as_of: result.as_of,
        cursor: null,
      }),
    );
    expect(wrapper.find('iframe[title="回答条件に一致する対象の地図"]').exists()).toBe(true);
    const close = wrapper.get(".answer-map-overlay").get("button");
    await close.trigger("click");
    expect(wrapper.find(".answer-map-overlay").exists()).toBe(false);
    expect(wrapper.text()).toContain("60件");
    wrapper.unmount();
  });
  it("該当回答がない場合は地図を開けない", async () => {
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("options") ? options : { ...result, rows: [], total: 0 },
    }));
    const wrapper = await open();
    expect(button(wrapper, "地図で確認").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
  it("APIのフォーム入力順を表示項目とテーブル列に維持する", async () => {
    const fields = [
      { id: "z-last-id", label: "最初の質問", field_type: "text", choices: [] },
      { id: "a-first-id", label: "次の質問", field_type: "text", choices: [] },
      { id: "m-middle-id", label: "最後の質問", field_type: "text", choices: [] },
    ];
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("options") ? { ...options, fields } : result,
    }));
    const wrapper = await open({ initialFormId: "common" });
    expect(wrapper.findAll(".column-options label").map((label) => label.text())).toEqual(
      fields.map((field) => field.label),
    );
    const middle = wrapper.findAll(".column-options input")[1]!;
    await middle.setValue(false);
    await middle.setValue(true);
    expect(
      wrapper
        .findAll("thead th")
        .slice(3, -1)
        .map((th) => th.text()),
    ).toEqual(fields.map((field) => field.label));
    wrapper.unmount();
  });
  it("検索操作を同じ行にまとめ、絞り込み後も検索欄を開いたままにする", async () => {
    const wrapper = await open({ initialFormId: "common" });
    await wrapper
      .findAll("button")
      .find((b) => b.text().startsWith("絞り込み"))!
      .trigger("click");
    expect(
      wrapper
        .get(".filter-actions")
        .findAll("button")
        .map((b) => b.text()),
    ).toEqual(["条件を追加", "条件をクリア", "絞り込む"]);
    await wrapper.get("form.search-form").trigger("submit");
    await flushPromises();
    expect(wrapper.get(".search-form").attributes("style") || "").not.toContain("display: none");
    expect(
      wrapper
        .findAll("button")
        .find((b) => b.text().startsWith("絞り込み"))!
        .attributes("aria-expanded"),
    ).toBe("true");
    wrapper.unmount();
  });
  it("? ボタンで一覧とCSVの説明を開閉する", async () => {
    const wrapper = await open();
    const help = wrapper.get('button[aria-label="一覧とCSVについて"]');
    expect(help.text()).toBe("?");
    expect(wrapper.find(".usage-help").exists()).toBe(false);
    await help.trigger("click");
    expect(help.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get(".usage-help").text()).toContain("全ページを出力");
    await help.trigger("click");
    expect(wrapper.find(".usage-help").exists()).toBe(false);
    wrapper.unmount();
  });
  it("共通フォームの検索と削除済み表示、投稿時定義の詳細を表示する", async () => {
    const wrapper = await open({ initialFormId: "common" });
    expect(api.post).toHaveBeenCalledWith(
      "/form-answers/search",
      expect.objectContaining({ common_form_id: "common", mode: "history" }),
    );
    expect(wrapper.text()).toContain("60件");
    expect(wrapper.text()).toContain("削除済み");
    await button(wrapper, "詳細を見る").trigger("click");
    expect(wrapper.text()).toContain("投稿時の名前");
    expect(wrapper.text()).toContain("当時の項目名");
    expect(wrapper.text()).toContain("いいえ");
    expect(wrapper.findAll("td").some((td) => td.text() === "0")).toBe(true);
    wrapper.unmount();
  });
  it("最新回答と数値条件をサーバーへ送り、同じ条件と基準時刻で次ページを取得する", async () => {
    const wrapper = await open({ initialFormId: "common" });
    await select(wrapper, "表示モード").setValue("latest");
    await button(wrapper, "条件を追加").trigger("click");
    const condition = wrapper.get(".condition-row");
    await condition.findAll("select")[1]!.setValue("gte");
    await condition.get("input").setValue("10");
    await wrapper.get("form.search-form").trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/search",
      expect.objectContaining({
        mode: "latest",
        conditions: [
          expect.objectContaining({
            field_id: "amount",
            field_type: "number",
            op: "gte",
            value: "10",
          }),
        ],
      }),
    );
    await button(wrapper, "次へ").trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/search",
      expect.objectContaining({ mode: "latest", as_of: result.as_of, cursor: result.next_cursor }),
    );
    wrapper.unmount();
  });
  it("未適用の条件編集をCSVへ混ぜず、表示中の全件をネイティブダウンロードする", async () => {
    const wrapper = await open({ initialFormId: "common" });
    await select(wrapper, "表示モード").setValue("latest");
    await button(wrapper, "CSV出力").trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/csv-check",
      expect.objectContaining({ mode: "history", as_of: result.as_of, cursor: null }),
    );
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    expect(wrapper.text()).not.toContain("CSVのダウンロードを開始しました。");
    const request = JSON.parse(
      (wrapper.get('input[name="query"]').element as HTMLInputElement).value,
    );
    expect(request.mode).toBe("history");
    expect(request.cursor).toBeNull();
    wrapper.unmount();
  });
  it("個別対象の履歴を開き、定義なしの回答を代替項目名で表示する", async () => {
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("options")
        ? { ...options, fields: [] }
        : {
            ...result,
            rows: [
              {
                ...row,
                form_snapshot: null,
                source_form: null,
                common_form_name: null,
                submitted_values: { legacy: "旧回答" },
              },
            ],
          },
    }));
    const wrapper = await open({ targetType: "marker", targetId: "target" });
    expect(api.post).toHaveBeenCalledWith(
      "/form-answers/search",
      expect.objectContaining({ target_type: "marker", target_id: "target" }),
    );
    expect(wrapper.text()).toContain("投稿時の定義情報なし");
    await button(wrapper, "詳細を見る").trigger("click");
    expect(wrapper.get("dl").text()).toContain("項目名不明の項目 1");
    expect(wrapper.get("dl").text()).not.toContain("legacy");
    expect(wrapper.get(".management-info").attributes("open")).toBeUndefined();
    expect(wrapper.text()).toContain("旧回答");
    wrapper.unmount();
  });
  it("CSVの事前検証失敗を表示し、ダウンロードを開始しない", async () => {
    const wrapper = await open({ initialFormId: "common" });
    api.post.mockRejectedValueOnce(new Error("failure"));
    await button(wrapper, "CSV出力").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("CSVを出力できませんでした");
    expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("検索欄を閉じて開き、フォーム変更は明示的に反映し、適用前の一覧を保持する", async () => {
    const wrapper = await open();
    expect(wrapper.get(".search-form").attributes("style")).toContain("display: none");
    expect(wrapper.find('input[placeholder="UUID（任意）"]').exists()).toBe(false);
    await wrapper
      .findAll("button")
      .find((b) => b.text().startsWith("絞り込み"))!
      .trigger("click");
    expect(wrapper.get(".search-form").attributes("style") || "").not.toContain("display: none");
    api.post.mockClear();
    await select(wrapper, "共通フォーム").setValue("common");
    await flushPromises();
    expect(api.post.mock.calls.every(([url]) => url.endsWith("options"))).toBe(true);
    expect(wrapper.text()).toContain("条件が変更されています");
    expect(wrapper.text()).toContain("60件");
    await wrapper.get("form.search-form").trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/search",
      expect.objectContaining({ common_form_id: "common" }),
    );
    expect(wrapper.text()).not.toContain("条件が変更されています");
    wrapper.unmount();
  });
  it("同名項目をIDを表示せず区別し、選択肢はチェックボックスで検索する", async () => {
    const fields = [
      { id: "internal-one", label: "状態", field_type: "select", choices: ["良好", "要確認"] },
      { id: "internal-two", label: "状態", field_type: "select", choices: ["その他"] },
    ];
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("options") ? { ...options, fields } : result,
    }));
    const wrapper = await open({ initialFormId: "common" });
    await button(wrapper, "条件を追加").trigger("click");
    const condition = wrapper.get(".condition-row");
    expect(condition.text()).toContain("状態（選択・1）");
    expect(condition.text()).toContain("状態（選択・2）");
    expect(condition.text()).not.toContain("internal-one");
    await condition.findAll('input[type="checkbox"]')[0]!.setValue(true);
    await wrapper.get("form.search-form").trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/search",
      expect.objectContaining({
        conditions: [expect.objectContaining({ field_id: "internal-one", value: ["良好"] })],
      }),
    );
    wrapper.unmount();
  });
  it("条件クリアでも呼び出し元の対象範囲を保持する", async () => {
    const wrapper = await open({ targetId: "target", targetType: "marker" });
    await wrapper
      .findAll("label")
      .find((l) => l.text().startsWith("対象名"))!
      .get("input")
      .setValue("検索語");
    await button(wrapper, "条件をクリア").trigger("click");
    await wrapper.get("form.search-form").trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/search",
      expect.objectContaining({ target_id: "target", target_type: "marker", target_name: null }),
    );
    wrapper.unmount();
  });
});

it("CSVと地図それぞれの横に説明を置き、地図の対象範囲を独立して案内する", async () => {
  const w = await open();
  expect(
    w
      .get(".result-actions")
      .findAll("button")
      .map((b) => b.text()),
  ).toEqual(["CSV出力", "?", "地図で確認", "?"]);
  await w.get('[aria-label="地図で確認について"]').trigger("click");
  expect(w.text()).toContain("個別フォームの回答条件は、一覧で指定してください");
  expect(w.get('[aria-label="一覧とCSVについて"]').attributes("aria-expanded")).toBe("false");
  await w.setProps({ isOpen: false });
  await w.setProps({ isOpen: true });
  await flushPromises();
  expect(w.get('[aria-label="地図で確認について"]').attributes("aria-expanded")).toBe("false");
  w.unmount();
});

it("一覧と詳細の編集から同じ回答を開き、保存後は基準日時を更新して再取得する", async () => {
  api.get.mockResolvedValue({
    data: { ...row.form_snapshot, revision: 1, values: row.submitted_values },
  });
  api.post.mockImplementation(async (url: string) => ({
    data: url.endsWith("options") ? options : { ...result, editing_supported: true },
  }));
  const wrapper = await open();
  await button(wrapper, "編集").trigger("click");
  expect(wrapper.getComponent(Input).props()).toMatchObject({
    answerId: "answer",
    targetId: "target",
    targetType: "marker",
    isOpen: true,
  });
  wrapper.getComponent(Input).vm.$emit("close");
  await flushPromises();
  await button(wrapper, "詳細を見る").trigger("click");
  await button(wrapper, "回答を編集").trigger("click");
  expect(wrapper.getComponent(Input).props("answerId")).toBe("answer");
  const object = { id: "target", detail: "更新後" };
  const listener = vi.fn();
  window.addEventListener("geocode-answer-updated", listener);
  wrapper.getComponent(Input).vm.$emit("saved", object);
  await flushPromises();
  expect(wrapper.findComponent(Input).exists()).toBe(false);
  expect(listener).toHaveBeenCalledOnce();
  expect(api.post.mock.calls.at(-1)![1]).not.toHaveProperty("as_of");
  expect(wrapper.text()).toContain("回答を更新しました。");
  window.removeEventListener("geocode-answer-updated", listener);
  wrapper.unmount();
});
it("編集API未対応のバックエンドでは編集操作を表示しない", async () => {
  const wrapper = await open();
  expect(wrapper.findAll("button").some((b) => b.text() === "編集")).toBe(false);
  wrapper.unmount();
});
