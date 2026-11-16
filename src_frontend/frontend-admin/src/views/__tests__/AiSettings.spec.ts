import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminAiSettingsUrl } from "@/router/urls";
import AiSettings from "../AiSettings.vue";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));

const configured = {
  revision: "revision-1",
  enabled: false,
  writeEnabled: false,
  provider: "openai",
  baseUrl: "https://llm.example.test/v1",
  model: "fixture-model",
  speechEnabled: false,
  speechBaseUrl: "https://speech.example.test/v1",
  speechModel: "fixture-transcribe",
  timeoutSeconds: 60,
  maxOutputTokens: 2048,
  maxRequestsPerMinute: 20,
  hasApiKey: true,
  hasSpeechApiKey: true,
  keyStorageConfigured: true,
};

let wrapper: VueWrapper | undefined;
async function open(data = configured) {
  api.get.mockResolvedValueOnce({ data });
  wrapper = mount(AiSettings);
  await flushPromises();
  return wrapper;
}
function button(text: string) {
  const found = wrapper!.findAll("button").find((item) => item.text() === text);
  if (!found) throw Error(`ボタンが見つかりません。${text}`);
  return found;
}
async function click(text: string) {
  await button(text).trigger("click");
  await flushPromises();
}
async function save() {
  await wrapper!.get("form").trigger("submit");
  await flushPromises();
}
function expectMessage(text: string) {
  expect(wrapper!.get('[role="dialog"]').isVisible()).toBe(true);
  expect(wrapper!.get('[role="dialog"]').text()).toContain(text);
}
function expectedInput() {
  const {
    hasApiKey: _key,
    hasSpeechApiKey: _speech,
    keyStorageConfigured: _storage,
    ...body
  } = configured;
  return body;
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("AI設定", () => {
  it("作成・保存は初期状態で不許可とし、管理者の明示設定を保存する", async () => {
    const view = await open();
    expect(view.get<HTMLInputElement>("#ai-write-enabled").element.checked).toBe(false);
    await view.get("#ai-write-enabled").setValue(true);
    api.put.mockResolvedValueOnce({ data: { ...configured, writeEnabled: true } });
    await save();
    expect(api.put).toHaveBeenCalledWith(
      adminAiSettingsUrl,
      expect.objectContaining({ writeEnabled: true }),
    );
  });
  it("保存済みキーを再表示せず、接続確認は保存と分けて実行する", async () => {
    const view = await open();
    expect(view.findAll('input[type="password"]')).toHaveLength(0);
    expect(view.text()).toContain("設定済み");
    api.post.mockResolvedValueOnce({ data: { ok: true } });
    await click("LLM接続確認");
    expect(api.post).toHaveBeenCalledWith(`${adminAiSettingsUrl}/check`, expectedInput());
    expect(api.put).not.toHaveBeenCalled();
    expectMessage("接続と応答形式を確認");
  });

  it("AI有効化と制限値を保存し、APIキー原文を送らずに維持できる", async () => {
    const view = await open();
    await view.get("#ai-enabled").setValue(true);
    await view.get("#ai-max-requests").setValue(15);
    api.put.mockResolvedValueOnce({
      data: { ...configured, enabled: true, maxRequestsPerMinute: 15 },
    });
    await save();
    expect(api.put).toHaveBeenCalledWith(adminAiSettingsUrl, {
      ...expectedInput(),
      enabled: true,
      maxRequestsPerMinute: 15,
    });
    expectMessage("地図画面で利用できます");
  });

  it("接続先変更時に古いキーの維持を拒否し、明示した置換だけを送る", async () => {
    const view = await open();
    await view.get("#ai-base-url").setValue("https://new.example.test/v1");
    await save();
    expect(api.put).not.toHaveBeenCalled();
    expectMessage("APIキーの置換または削除");
    await click("閉じる");
    await view.get("#ai-key-action").setValue("replace");
    const key = view.get<HTMLInputElement>("#ai-api-key");
    expect(key.element.type).toBe("password");
    await key.setValue("fixture-new-secret");
    api.put.mockResolvedValueOnce({
      data: { ...configured, baseUrl: "https://new.example.test/v1" },
    });
    await save();
    expect(api.put).toHaveBeenCalledWith(
      adminAiSettingsUrl,
      expect.objectContaining({
        baseUrl: "https://new.example.test/v1",
        apiKey: "fixture-new-secret",
      }),
    );
    expect(view.find("#ai-api-key").exists()).toBe(false);
    expect(view.text()).not.toContain("fixture-new-secret");
  });

  it("キー不要の接続先へ切替え、LLMと音声認識のキー削除を明示できる", async () => {
    const view = await open();
    await view.get("#ai-key-action").setValue("clear");
    await view.get("#ai-speech-enabled").setValue(true);
    await view.get("#ai-speech-key-action").setValue("clear");
    api.put.mockResolvedValueOnce({
      data: { ...configured, speechEnabled: true, hasApiKey: false, hasSpeechApiKey: false },
    });
    await save();
    expect(api.put).toHaveBeenCalledWith(adminAiSettingsUrl, {
      ...expectedInput(),
      speechEnabled: true,
      clearApiKey: true,
      clearSpeechApiKey: true,
    });
  });

  it("接続方式を変更すると接続先を切り替え、旧サービスのキーを送らない", async () => {
    const view = await open();
    await view.get("#ai-provider").setValue("anthropic");
    expect(view.get<HTMLInputElement>("#ai-base-url").element.value).toBe(
      "https://api.anthropic.com/v1",
    );
    expect(view.get<HTMLInputElement>("#ai-model").element.value).toBe("");
    expect(view.get<HTMLSelectElement>("#ai-key-action").element.value).toBe("replace");
    await view.get("#ai-model").setValue("fixture-claude");
    await click("LLM接続確認");
    expectMessage("新しいAPIキーを入力");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("入力形式と制限値が不正なら接続要求や保存を送らない", async () => {
    const view = await open();
    await view.get("#ai-base-url").setValue("https://user:secret@example.test/v1");
    await click("LLM接続確認");
    expectMessage("URLに認証情報");
    expect(api.post).not.toHaveBeenCalled();
    await click("閉じる");
    await view.get("#ai-base-url").setValue(configured.baseUrl);
    await view.get("#ai-timeout").setValue(121);
    await save();
    expectMessage("タイムアウトは5〜120秒");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("暗号鍵がない場合は保存を無効にして設定方法を表示する", async () => {
    await open({ ...configured, keyStorageConfigured: false });
    expect(wrapper!.text()).toContain("AI_ENCRYPTION_KEY");
    expect(button("AI設定を保存").element.matches(":disabled")).toBe(true);
    await save();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("設定競合では入力キーを消し、最新設定を取得するまで保存を止める", async () => {
    const view = await open();
    await view.get("#ai-key-action").setValue("replace");
    await view.get("#ai-api-key").setValue("fixture-draft-secret");
    api.put.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
    await save();
    expectMessage("別の操作でAI設定が更新");
    expect(view.get<HTMLInputElement>("#ai-api-key").element.value).toBe("");
    expect(button("AI設定を保存").element.matches(":disabled")).toBe(true);
    await click("閉じる");
    api.get.mockResolvedValueOnce({
      data: { ...configured, revision: "revision-2", model: "updated-model" },
    });
    await click("最新の設定を取得");
    expect(view.get<HTMLInputElement>("#ai-model").element.value).toBe("updated-model");
    expect(button("AI設定を保存").element.matches(":disabled")).toBe(false);
  });

  it("失敗時は入力を保持し、サーバーが整形した接続エラーを表示する", async () => {
    const view = await open();
    await view.get("#ai-key-action").setValue("replace");
    await view.get("#ai-api-key").setValue("fixture-secret");
    api.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 502,
        data: { error: "LLM接続先がモデル名を受け付けませんでした（HTTP 400）。" },
      },
    });
    await click("LLM接続確認");
    expectMessage("接続を確認できません");
    expectMessage("詳細：LLM接続先がモデル名を受け付けませんでした（HTTP 400）。");
    expect(view.get<HTMLInputElement>("#ai-api-key").element.value).toBe("fixture-secret");
  });

  it("エラーの詳細は文字で表示し、入力中のキーを含めない", async () => {
    const view = await open();
    await view.get("#ai-key-action").setValue("replace");
    await view.get("#ai-api-key").setValue("fixture-llm-secret");
    await view.get("#ai-speech-key-action").setValue("replace");
    await view.get("#ai-speech-api-key").setValue("fixture-speech-secret");
    api.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 502,
        data: {
          error: '<img src="x" onerror="alert(1)"> fixture-llm-secret fixture-speech-secret',
        },
      },
    });
    await click("LLM接続確認");
    const dialog = view.get('[role="dialog"]');
    expect(dialog.text()).toContain('<img src="x" onerror="alert(1)">');
    expect(dialog.find("img").exists()).toBe(false);
    expect(dialog.text()).not.toContain("fixture-llm-secret");
    expect(dialog.text()).not.toContain("fixture-speech-secret");
    expect(dialog.text()).toContain("[非表示]");
  });

  it("詳細のない接続失敗では固定の案内を表示する", async () => {
    await open();
    api.post.mockRejectedValueOnce(new Error("network failure"));
    await click("LLM接続確認");
    expectMessage("LLMの接続を確認できませんでした。");
    expect(wrapper!.get('[role="dialog"]').text()).not.toContain("詳細：");
  });

  it("管理者認証に失敗したら保存を拒否し、取得の再試行を可能にする", async () => {
    api.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 403, data: { error: "private-detail" } },
    });
    wrapper = mount(AiSettings);
    await flushPromises();
    expectMessage("管理者権限が必要");
    expect(wrapper.text()).not.toContain("private-detail");
    expect(button("AI設定を保存").element.matches(":disabled")).toBe(true);
    await click("閉じる");
    api.get.mockResolvedValueOnce({ data: configured });
    await click("最新の設定を取得");
    expect(button("AI設定を保存").element.matches(":disabled")).toBe(false);
  });
});
