import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnswerDeleteModal from "../AnswerDeleteModal.vue";
import FormAnswersModal from "../FormAnswersModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import type { FormAnswer } from "@/utils/answer-presentation";

const api = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  isAxiosError: vi.fn(),
}));
vi.mock("@/axiosClient", () => ({ default: api }));
const answer: FormAnswer = {
  id: "answer",
  revision: 2,
  target_type: "marker",
  target_id: "target",
  target_name: "対象A",
  layer_id: null,
  layer_name: null,
  create_at: "2026-01-01T00:00:00",
  form_snapshot: null,
  source_form: null,
  common_form_name: null,
  common_form_deleted: null,
  submitted_values: {},
};
const body = {
  body: "本文",
  body_token: "token",
  free_text: "本文",
  sync_required: false,
  managed_markdown: "登録部分",
  parts: [],
};
const options = { forms: [], layers: [], fields: [], versions: [] };
const page = {
  rows: [answer],
  total: 1,
  as_of: "2026-01-02T00:00:00Z",
  next_cursor: null,
  editing_supported: true,
  deletion_supported: true,
};
const object = { id: "target", detail: "削除後" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const mounted: VueWrapper[] = [];
const mountDelete = async (props = {}) => {
  const wrapper = mount(AnswerDeleteModal, {
    props: { answer, session: 1, ...props },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
};
const mountList = async () => {
  const wrapper = mount(FormAnswersModal, { props: { isOpen: false }, attachTo: document.body });
  mounted.push(wrapper);
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  return wrapper;
};
const button = (wrapper: VueWrapper, text: string) =>
  wrapper.findAll("button").find((item) => item.text() === text)!;
beforeEach(() => {
  vi.clearAllMocks();
  api.isAxiosError.mockImplementation((error) => !!error?.response);
  api.get.mockResolvedValue({ data: body });
  api.delete.mockResolvedValue({ data: { message: "削除しました", object } });
  api.post.mockImplementation(async (url: string) => ({
    data: url.endsWith("options") ? options : page,
  }));
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("登録の削除確認", () => {
  it("フォーム定義がなくても削除対象を確認でき、閉じるだけでは削除しない", async () => {
    const wrapper = await mountDelete();
    expect(api.get).toHaveBeenCalledWith(
      "/marker/target/form/body",
      expect.objectContaining({
        headers: { "Cache-Control": "no-store" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(wrapper.text()).toContain("対象A");
    expect(wrapper.text()).toContain("本文・メモに反映された登録内容を削除");
    expect(wrapper.find(".answer-delete-free-text").exists()).toBe(false);
    await button(wrapper, "閉じる").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("送信中は閉じると二重送信を防ぎ、成功した削除を一度だけ同期する", async () => {
    const pending = deferred<{ data: { message: string; object: typeof object } }>();
    api.delete.mockReturnValue(pending.promise);
    const update = vi.fn();
    window.addEventListener("geocode-answer-updated", update);
    const wrapper = await mountDelete();
    await button(wrapper, "削除").trigger("click");
    await button(wrapper, "削除").trigger("click");
    await button(wrapper, "閉じる").trigger("click");
    expect(button(wrapper, "閉じる").attributes("disabled")).toBeDefined();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith("/form-answers/marker/answer", {
      data: { revision: 2 },
    });
    pending.resolve({ data: { message: "削除しました", object } });
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0]![0] as CustomEvent).detail).toEqual(object);
    expect(wrapper.emitted("deleted")).toEqual([[1]]);
    await button(wrapper, "削除").trigger("click");
    expect(api.delete).toHaveBeenCalledTimes(1);
    window.removeEventListener("geocode-answer-updated", update);
  });

  it("確認取得と削除の失敗を表示し、削除失敗時は確認内容を保持する", async () => {
    api.get.mockRejectedValueOnce(new Error("offline"));
    const wrapper = await mountDelete();
    expect(button(wrapper, "削除").attributes("disabled")).toBeDefined();
    await button(wrapper, "再読み込み").trigger("click");
    await flushPromises();
    api.delete.mockRejectedValueOnce({ response: { status: 500, data: { error: "削除失敗" } } });
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    expect(wrapper.get(".answer-delete-error").text()).toBe("削除失敗");
    expect(wrapper.text()).toContain("対象A");
    expect(wrapper.emitted("deleted")).toBeUndefined();
    expect(button(wrapper, "削除").attributes("disabled")).toBeUndefined();
  });

  it("更新競合後は古いrevisionで再送しない", async () => {
    api.delete.mockRejectedValue({ response: { status: 409, data: {} } });
    const wrapper = await mountDelete();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    expect(wrapper.get(".answer-delete-error").text()).toContain("他で更新");
    await button(wrapper, "削除").trigger("click");
    expect(api.delete).toHaveBeenCalledTimes(1);
    await button(wrapper, "閉じる").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("revisionがない古い一覧データでは削除を送信しない", async () => {
    const wrapper = await mountDelete({ answer: { ...answer, revision: undefined } });
    expect(wrapper.get(".answer-delete-error").text()).toContain("一覧を再検索");
    expect(button(wrapper, "削除").attributes("disabled")).toBeDefined();
    expect(api.get).not.toHaveBeenCalled();
    await button(wrapper, "削除").trigger("click");
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("曖昧な本文は自由記述と確認チェックを揃えた時だけreconcileを送る", async () => {
    api.get.mockResolvedValue({ data: { ...body, sync_required: true } });
    const wrapper = await mountDelete({ answer: { ...answer, target_type: "shape" } });
    expect(button(wrapper, "削除").attributes("disabled")).toBeDefined();
    await wrapper.get(".answer-delete-free-text").setValue("残す自由記述");
    await wrapper.get(".answer-delete-reconcile-confirm").setValue(true);
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith("/form-answers/shape/answer", {
      data: { revision: 2, reconcile: { free_text: "残す自由記述", token: "token" } },
    });
  });

  it("対象変更後に古い本文が到着しても新しい削除確認へ適用しない", async () => {
    const pending = deferred<{ data: typeof body }>();
    api.get.mockReturnValueOnce(pending.promise);
    const wrapper = await mountDelete();
    await wrapper.setProps({
      answer: { ...answer, id: "second", target_id: "second-target" },
      session: 2,
    });
    await flushPromises();
    pending.resolve({ data: { ...body, sync_required: true } });
    await flushPromises();
    expect(wrapper.find(".answer-delete-free-text").exists()).toBe(false);
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith("/form-answers/marker/second", {
      data: { revision: 2 },
    });
  });

  it("送信中に画面が破棄されても確定した削除を地図へ一度通知する", async () => {
    const pending = deferred<{ data: { message: string; object: typeof object } }>();
    api.delete.mockReturnValue(pending.promise);
    const update = vi.fn();
    window.addEventListener("geocode-answer-updated", update);
    const wrapper = await mountDelete();
    await button(wrapper, "削除").trigger("click");
    wrapper.unmount();
    pending.resolve({ data: { message: "削除しました", object } });
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);
    window.removeEventListener("geocode-answer-updated", update);
  });
});

describe("登録一覧からの削除", () => {
  it("編集不可の過去登録も削除でき、キャンセル時は一覧を保つ", async () => {
    const wrapper = await mountList();
    expect(button(wrapper, "編集").attributes("disabled")).toBeDefined();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-modal header button").trigger("click");
    expect(wrapper.find(".answer-delete-modal").exists()).toBe(false);
    expect(wrapper.get("tbody").text()).toContain("対象A");
    expect(api.delete).not.toHaveBeenCalled();
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
  });

  it("削除APIの対応が明示されなければ操作を出さない", async () => {
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("options") ? options : { ...page, deletion_supported: false },
    }));
    const wrapper = await mountList();
    expect(wrapper.find(".delete-button").exists()).toBe(false);
  });

  it("削除後に検索基準とページを更新し、件数・最新登録・検索項目を再取得する", async () => {
    let deleted = false;
    api.delete.mockImplementation(async () => {
      deleted = true;
      return { data: { message: "削除しました", object } };
    });
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("options")
        ? options
        : { ...page, rows: deleted ? [] : [answer], total: deleted ? 0 : 1 },
    }));
    const wrapper = await mountList();
    await wrapper.get("select").setValue("latest");
    await wrapper.get(".search-form").trigger("submit");
    await flushPromises();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    await flushPromises();
    const searches = api.post.mock.calls.filter(([url]) => url === "/form-answers/search");
    expect(searches.at(-1)![1]).toMatchObject({ mode: "latest", cursor: null });
    expect(searches.at(-1)![1]).not.toHaveProperty("as_of");
    expect(api.post.mock.calls.filter(([url]) => url === "/form-answers/options")).toHaveLength(2);
    expect(wrapper.getComponent(MessageModal).props()).toMatchObject({
      isOpen: true,
      message: "削除しました。",
      zIndex: 130,
    });
    expect(wrapper.text()).toContain("該当する登録はありません。");
    expect(wrapper.find(".answer-delete-modal").exists()).toBe(false);
  });

  it("一覧の再取得を待たず成功通知を前面に出し、閉じた通知を再表示しない", async () => {
    const pendingDelete = deferred<{ data: { message: string; object: typeof object } }>();
    const pendingSearch = deferred<{ data: typeof page }>();
    api.delete.mockReturnValue(pendingDelete.promise);
    let searches = 0;
    api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("options")) return { data: options };
      if (++searches === 2) return pendingSearch.promise;
      return { data: page };
    });
    const wrapper = await mountList();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
    pendingDelete.resolve({ data: { message: "削除しました", object } });
    await flushPromises();
    const result = wrapper.get(".answer-delete-result");
    expect(result.get("strong").text()).toBe("削除しました。");
    expect(wrapper.get(".answers-modal").attributes()).toHaveProperty("inert");
    const progress = document.body.querySelector<HTMLElement>(".answer-search-progress")!;
    expect(progress.hasAttribute("inert")).toBe(true);
    expect(Number((result.element as HTMLElement).style.zIndex)).toBeGreaterThan(
      Number(progress.style.zIndex),
    );
    await result.get("button").trigger("click");
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
    expect(progress.hasAttribute("inert")).toBe(false);
    pendingSearch.resolve({ data: { ...page, rows: [], total: 0 } });
    await flushPromises();
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
    expect(wrapper.find(".answers-modal").attributes()).not.toHaveProperty("inert");
    expect(wrapper.text()).toContain("該当する登録はありません。");
    expect(api.delete).toHaveBeenCalledTimes(1);
  });

  it("削除失敗時は確認画面にエラーを示し、成功通知を出さない", async () => {
    api.delete.mockRejectedValue({ response: { status: 500, data: { error: "削除失敗" } } });
    const wrapper = await mountList();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    await flushPromises();
    expect(wrapper.get(".answer-delete-error").text()).toBe("削除失敗");
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
    expect(wrapper.get("tbody").text()).toContain("対象A");
  });

  it("再取得失敗を削除失敗と区別し、削除済み登録を再送できる状態に戻さない", async () => {
    let searches = 0;
    api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("options")) return { data: options };
      if (++searches > 1) throw new Error("offline");
      return { data: page };
    });
    const wrapper = await mountList();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain(
      "削除は完了していますが、一覧や検索項目を再取得できませんでした。",
    );
    expect(wrapper.getComponent(MessageModal).props("message")).toBe("削除しました。");
    expect(wrapper.find(".delete-button").exists()).toBe(false);
    expect(api.delete).toHaveBeenCalledTimes(1);
  });

  it("削除後に検索項目だけ再取得できなくても削除済みの行を残さない", async () => {
    let optionRequests = 0;
    api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("options")) {
        if (++optionRequests > 1) throw new Error("offline");
        return { data: options };
      }
      return { data: page };
    });
    const wrapper = await mountList();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain(
      "削除は完了していますが、一覧や検索項目を再取得できませんでした。",
    );
    expect(wrapper.getComponent(MessageModal).props("message")).toBe("削除しました。");
    expect(wrapper.find(".delete-button").exists()).toBe(false);
    expect(wrapper.find("tbody").exists()).toBe(false);
    expect(api.delete).toHaveBeenCalledTimes(1);
  });

  it("削除送信後に一覧を開き直しても古い成功通知や再検索を持ち込まない", async () => {
    const pending = deferred<{ data: { message: string; object: typeof object } }>();
    api.delete.mockReturnValue(pending.promise);
    const wrapper = await mountList();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    await flushPromises();
    const count = api.post.mock.calls.length;
    pending.resolve({ data: { message: "削除しました", object } });
    await flushPromises();
    expect(api.post.mock.calls).toHaveLength(count);
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
    expect(wrapper.get("tbody").text()).toContain("対象A");
  });

  it("削除後の再取得中に対象を切り替えても旧結果を新しい一覧に書き戻さない", async () => {
    const pending = deferred<{ data: typeof page }>();
    let searches = 0;
    api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("options")) return { data: options };
      if (++searches === 2) return pending.promise;
      return {
        data: {
          ...page,
          rows: [{ ...answer, target_name: searches > 2 ? "切替先の登録" : "対象A" }],
        },
      };
    });
    const wrapper = await mountList();
    await button(wrapper, "削除").trigger("click");
    await flushPromises();
    await wrapper.get(".answer-delete-submit").trigger("click");
    await flushPromises();
    await wrapper.setProps({ targetId: "new-target", targetType: "shape" });
    await flushPromises();
    pending.resolve({ data: page });
    await flushPromises();
    expect(wrapper.get("tbody").text()).toContain("切替先の登録");
    expect(wrapper.find(".answer-delete-result").exists()).toBe(false);
    expect(api.post).toHaveBeenLastCalledWith(
      "/form-answers/search",
      expect.objectContaining({ target_id: "new-target", target_type: "shape" }),
    );
  });
});
