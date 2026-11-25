import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminOsrmSettingsUrl as url } from "@/router/urls";
import OsrmSettings from "../OsrmSettings.vue";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));

const driveUrl = "https://osrm.example.test/car";
const walkUrl = "https://osrm.example.test/foot";
const unconfigured = { baseUrl: null as string | null, hasApiKey: false, keyUsable: false };
const noKey = { ...unconfigured, baseUrl: driveUrl };
const saved = { baseUrl: driveUrl, hasApiKey: true, keyUsable: true };
const settings = {
  revision: "old",
  keyStorageConfigured: true,
  drive: saved,
  walk: { ...unconfigured, baseUrl: walkUrl },
};
const origin = { lat: 35.681, lng: 139.767 };
const destination = { lat: 35.684, lng: 139.773 };
type Mode = "drive" | "walk";

let wrapper: VueWrapper | undefined;

async function open(data = settings) {
  api.get.mockResolvedValueOnce({ data });
  wrapper = mount(OsrmSettings);
  await flushPromises();
  return wrapper;
}

function profile(mode: Mode) {
  return wrapper!.get(`section[aria-labelledby="osrm-${mode}-title"]`);
}

function checkButton(mode: Mode) {
  return profile(mode).get<HTMLButtonElement>('form[aria-label$="の接続確認"] button');
}

function urlInput(mode: Mode) {
  return profile(mode).get<HTMLInputElement>(`#osrm-${mode}-url`);
}

function saveButton(mode: Mode) {
  return profile(mode).get<HTMLButtonElement>(
    'form[aria-label$="の接続設定"] button[type="submit"]',
  );
}

function disableButton(mode: Mode) {
  return profile(mode).get<HTMLButtonElement>(
    'form[aria-label$="の接続設定"] button[type="button"]',
  );
}

async function chooseKey(mode: Mode, action: "set" | "clear", apiKey = "") {
  await profile(mode).get(`#osrm-${mode}-key-action`).setValue(action);
  if (action === "set") await profile(mode).get(`#osrm-${mode}-api-key`).setValue(apiKey);
}

async function enterPoints(mode: Mode) {
  for (const [endpoint, coordinate] of Object.entries({ origin, destination })) {
    await profile(mode).get(`#osrm-${mode}-${endpoint}-lat`).setValue(coordinate.lat);
    await profile(mode).get(`#osrm-${mode}-${endpoint}-lng`).setValue(coordinate.lng);
  }
}

async function check(mode: Mode) {
  await profile(mode).get('form[aria-label$="の接続確認"]').trigger("submit");
  await flushPromises();
}

async function save(mode: Mode) {
  await profile(mode).get('form[aria-label$="の接続設定"]').trigger("submit");
  await flushPromises();
}

function messageDialog() {
  return wrapper!.get('[role="dialog"]');
}

function visibleMessage() {
  const dialog = messageDialog();
  expect(dialog.isVisible()).toBe(true);
  return dialog.get(".message-text").text();
}

async function closeMessage() {
  const dialog = messageDialog();
  await dialog.get("button").trigger("click");
  expect(dialog.isVisible()).toBe(false);
}

function reloadButton() {
  return wrapper!.findAll("button").find((button) => button.text() === "最新の設定を取得");
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("OSRM設定", () => {
  it("車・徒歩別に現在の接続先を表示し、未設定の接続先も入力できる", async () => {
    const view = await open({ ...settings, walk: unconfigured });
    expect(api.get).toHaveBeenCalledWith(url);
    expect(profile("drive").text()).toContain(driveUrl);
    expect(profile("walk").text()).toContain("現在の接続先未設定APIキーキーなし");
    expect(urlInput("drive").element.value).toBe(driveUrl);
    expect(urlInput("walk").element.value).toBe("");
    expect(urlInput("walk").element.matches(":disabled")).toBe(false);
    expect(saveButton("walk").element.matches(":disabled")).toBe(true);
    expect(view.find('input[type="password"]').exists()).toBe(false);
    expect(messageDialog().isVisible()).toBe(false);
  });

  it("候補のURLとキーで接続を確認し、別操作で選んだ移動手段だけを保存する", async () => {
    const view = await open();
    const candidateUrl = "https://new-osrm.example.test/car";
    const walkDraft = "https://new-osrm.example.test/foot";
    await urlInput("drive").setValue(candidateUrl);
    await urlInput("walk").setValue(walkDraft);
    await chooseKey("drive", "set", "new drive key");
    await chooseKey("walk", "set", "walk-draft");
    await enterPoints("drive");
    api.post.mockResolvedValueOnce({ data: { routeFound: true } });
    await check("drive");
    const key = { action: "set", apiKey: "new drive key" };
    expect(api.post).toHaveBeenCalledWith(url + "/check", {
      revision: "old",
      travelMode: "DRIVE",
      baseUrl: candidateUrl,
      origin,
      destination,
      key,
    });
    expect(api.put).not.toHaveBeenCalled();
    expect(visibleMessage()).toContain("経路を取得しました");
    expect(view.get<HTMLInputElement>("#osrm-drive-api-key").element.value).toBe("new drive key");
    await closeMessage();

    api.put.mockResolvedValueOnce({
      data: { ...settings, revision: "next", drive: { ...saved, baseUrl: candidateUrl } },
    });
    await save("drive");
    expect(api.put).toHaveBeenCalledWith(url, {
      revision: "old",
      drive: { baseUrl: candidateUrl, key },
    });
    expect(visibleMessage()).toContain("保存しました");
    expect(profile("drive").text()).toContain(candidateUrl);
    expect(view.find("#osrm-drive-api-key").exists()).toBe(false);
    expect(urlInput("walk").element.value).toBe(walkDraft);
    expect(view.get<HTMLInputElement>("#osrm-walk-api-key").element.value).toBe("walk-draft");
  });

  it("暗号鍵が未設定でも車用URLをキーなしで登録でき、徒歩は車用の保存後に設定できる", async () => {
    const initial = {
      ...settings,
      keyStorageConfigured: false,
      drive: unconfigured,
      walk: unconfigured,
    };
    await open(initial);
    await urlInput("walk").setValue(walkUrl);
    await urlInput("drive").setValue(driveUrl);
    expect(saveButton("walk").element.matches(":disabled")).toBe(true);
    expect(checkButton("walk").element.matches(":disabled")).toBe(true);
    expect(saveButton("drive").element.matches(":disabled")).toBe(false);
    api.put.mockResolvedValueOnce({ data: { ...initial, revision: "next", drive: noKey } });
    await save("drive");
    expect(api.put).toHaveBeenCalledWith(url, { revision: "old", drive: { baseUrl: driveUrl } });
    expect(urlInput("walk").element.value).toBe(walkUrl);
    expect(saveButton("walk").element.matches(":disabled")).toBe(false);
  });

  it("旧設定のキーだけが残る場合も従来のURLで接続確認し、キーを維持して移行できる", async () => {
    await open({
      ...settings,
      drive: { ...saved, baseUrl: null, keyUsable: false },
      walk: unconfigured,
    });
    expect(profile("drive").text()).toContain("設定済み・接続先未登録");
    expect(profile("drive").text()).toContain("これまで使っていたベースURLを入力");
    expect(profile("drive").text()).not.toContain("キーを更新するか、キーなしで接続を確認");

    const existingUrl = driveUrl + "/";
    await urlInput("drive").setValue(existingUrl);
    await enterPoints("drive");
    expect(checkButton("drive").element.matches(":disabled")).toBe(false);
    expect(saveButton("drive").element.matches(":disabled")).toBe(false);
    api.post.mockResolvedValueOnce({ data: { routeFound: true } });
    await check("drive");
    expect(api.post).toHaveBeenCalledWith(url + "/check", {
      revision: "old",
      travelMode: "DRIVE",
      baseUrl: existingUrl,
      origin,
      destination,
    });
    await closeMessage();

    api.put.mockResolvedValueOnce({
      data: { ...settings, revision: "migrated", walk: unconfigured },
    });
    await save("drive");
    expect(api.put).toHaveBeenCalledWith(url, { revision: "old", drive: { baseUrl: existingUrl } });
    expect(urlInput("drive").element.value).toBe(driveUrl);
    expect(profile("drive").text()).toContain("APIキー設定済み");
  });

  it("保存済みキーを再送せずURLの同一性をサーバーに確認させ、変更時はキーなしを明示できる", async () => {
    await open();
    const same = driveUrl + "/";
    await urlInput("drive").setValue(same);
    api.put.mockResolvedValueOnce({ data: { ...settings, revision: "migrated" } });
    await save("drive");
    expect(api.put).toHaveBeenCalledWith(url, { revision: "old", drive: { baseUrl: same } });
    expect(urlInput("drive").element.value).toBe(driveUrl);
    await closeMessage();

    const changed = "https://new-osrm.example.test/car";
    await urlInput("drive").setValue(changed);
    const URL_KEY_ERROR = "接続先を変更する場合は、APIキーを入力し直すか、削除してください。";
    api.put.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: URL_KEY_ERROR } },
    });
    await save("drive");
    expect(visibleMessage()).toBe(URL_KEY_ERROR);
    expect(api.put).toHaveBeenLastCalledWith(url, {
      revision: "migrated",
      drive: { baseUrl: changed },
    });
    await closeMessage();

    await chooseKey("drive", "clear");
    api.put.mockResolvedValueOnce({
      data: { ...settings, revision: "updated", drive: { ...noKey, baseUrl: changed } },
    });
    await save("drive");
    expect(api.put).toHaveBeenLastCalledWith(url, {
      revision: "migrated",
      drive: { baseUrl: changed, key: { action: "clear" } },
    });
  });

  it("不正な接続先を保存・確認に送信しない", async () => {
    await open();
    await enterPoints("drive");
    for (const invalid of [
      "https://user@osrm.example.test/car",
      "https://osrm.example.test/car?key=1",
    ]) {
      await urlInput("drive").setValue(invalid);
      await save("drive");
      expect(visibleMessage()).toContain("HTTP(S)のベースURLを入力");
      await closeMessage();
      await check("drive");
      expect(visibleMessage()).toContain("HTTP(S)のベースURLを入力");
      await closeMessage();
    }
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("徒歩を先に無効にすると、車を無効にして保存済みキーも消せる", async () => {
    await open();
    expect(disableButton("drive").element.matches(":disabled")).toBe(true);
    expect(profile("drive").text()).toContain("先に徒歩用OSRMを無効にしてください");
    const walkDisabled = { ...settings, revision: "next", walk: unconfigured };
    api.put.mockResolvedValueOnce({ data: walkDisabled });
    await disableButton("walk").trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith(url, { revision: "old", walk: { baseUrl: null } });
    expect(urlInput("walk").element.value).toBe("");
    expect(disableButton("drive").element.matches(":disabled")).toBe(false);
    expect(profile("drive").text()).toContain("保存済みのAPIキーも削除");
    expect(visibleMessage()).toContain("徒歩用OSRMを無効にしました");
    await closeMessage();

    api.put.mockResolvedValueOnce({ data: { ...walkDisabled, drive: unconfigured } });
    await disableButton("drive").trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith(url, { revision: "next", drive: { baseUrl: null } });
    expect(urlInput("drive").element.value).toBe("");
    expect(profile("drive").text()).toContain("キーなし");
    expect(visibleMessage()).toContain("車用OSRMを無効にしました");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("利用できない保存済みキーを使わずに接続を試し、暗号鍵なしで削除できる", async () => {
    const withUnusable = {
      ...settings,
      keyStorageConfigured: false,
      drive: { ...saved, keyUsable: false },
    };
    const view = await open(withUnusable);
    expect(view.text()).toContain("OSRM_ENCRYPTION_KEY");
    expect(profile("drive").text()).toContain("利用不可");
    expect(checkButton("drive").element.matches(":disabled")).toBe(true);
    await chooseKey("drive", "clear");
    await enterPoints("drive");
    api.post.mockResolvedValueOnce({ data: { routeFound: false } });
    await check("drive");
    expect(api.post).toHaveBeenCalledWith(url + "/check", {
      revision: "old",
      travelMode: "DRIVE",
      baseUrl: driveUrl,
      origin,
      destination,
      key: { action: "clear" },
    });
    expect(visibleMessage()).toContain("OSRMに接続できました。経路が見つかりません");
    expect(api.put).not.toHaveBeenCalled();
    await closeMessage();

    expect(saveButton("drive").element.matches(":disabled")).toBe(false);
    api.put.mockResolvedValueOnce({ data: { ...withUnusable, revision: "next", drive: noKey } });
    await save("drive");
    expect(api.put).toHaveBeenCalledWith(url, {
      revision: "old",
      drive: { baseUrl: driveUrl, key: { action: "clear" } },
    });
    expect(profile("drive").text()).toContain("キーなし");
  });

  it("保存の暗号鍵がなくても候補キーを確認でき、不正な座標やキーを送信しない", async () => {
    await open({ ...settings, keyStorageConfigured: false });
    await chooseKey("walk", "set", " leading-space");
    expect(saveButton("walk").element.matches(":disabled")).toBe(true);
    await enterPoints("walk");
    await check("walk");
    expect(visibleMessage()).toContain("APIキーは先頭と末尾");
    expect(api.post).not.toHaveBeenCalled();
    await closeMessage();

    await profile("walk").get("#osrm-walk-api-key").setValue("foot-key");
    const latitude = profile("walk").get("#osrm-walk-origin-lat");
    await latitude.setValue(91);
    await check("walk");
    expect(visibleMessage()).toContain("出発地と目的地の緯度");
    expect(api.post).not.toHaveBeenCalled();
    await closeMessage();

    await latitude.setValue(origin.lat);
    api.post.mockResolvedValueOnce({ data: { routeFound: true } });
    await check("walk");
    expect(api.post).toHaveBeenCalledWith(url + "/check", {
      revision: "old",
      travelMode: "WALK",
      baseUrl: walkUrl,
      origin,
      destination,
      key: { action: "set", apiKey: "foot-key" },
    });
    expect(api.put).not.toHaveBeenCalled();
  });

  it("更新競合のあと再取得しても、URLと座標を維持しキーを取り除く", async () => {
    const view = await open();
    const draftUrl = "https://draft-osrm.example.test/car";
    const updatedUrl = "https://updated-osrm.example.test/car";
    await urlInput("drive").setValue(draftUrl);
    await enterPoints("drive");
    await chooseKey("drive", "set", "stale-secret");
    api.put.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
    await save("drive");
    expect(visibleMessage()).toContain("別の操作で設定が更新");
    expect(view.find("#osrm-drive-api-key").exists()).toBe(false);
    expect(checkButton("drive").element.matches(":disabled")).toBe(true);
    await closeMessage();

    api.get.mockResolvedValueOnce({
      data: { ...settings, revision: "current", drive: { ...saved, baseUrl: updatedUrl } },
    });
    await reloadButton()!.trigger("click");
    await flushPromises();
    expect(reloadButton()).toBeUndefined();
    expect(urlInput("drive").element.value).toBe(draftUrl);
    expect(profile("drive").text()).toContain(updatedUrl);
    expect(view.find("#osrm-drive-api-key").exists()).toBe(false);
    await chooseKey("drive", "clear");
    api.post.mockResolvedValueOnce({ data: { routeFound: true } });
    await check("drive");
    expect(api.post).toHaveBeenCalledWith(url + "/check", {
      revision: "current",
      travelMode: "DRIVE",
      baseUrl: draftUrl,
      origin,
      destination,
      key: { action: "clear" },
    });
  });

  it("接続確認の認証エラーを表示し、通信障害には専用の案内を表示する", async () => {
    const view = await open();
    await enterPoints("drive");
    const authMessage = "OSRMの認証に失敗しました。APIキーを確認してください。";
    api.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: authMessage } },
    });
    await check("drive");
    expect(visibleMessage()).toBe(authMessage);
    expect(checkButton("drive").element.matches(":disabled")).toBe(false);
    await closeMessage();

    api.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 502, data: { error: "private-upstream-detail" } },
    });
    await check("drive");
    expect(visibleMessage()).toContain("接続先とネットワークを確認");
    expect(view.text()).not.toContain("private-upstream-detail");
  });

  it("管理者権限がない場合は操作を表示せず、上流の詳細を出さない", async () => {
    api.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 403, data: { error: "private-detail" } },
    });
    wrapper = mount(OsrmSettings);
    await flushPromises();
    expect(visibleMessage()).toContain("管理者権限が必要");
    expect(wrapper.text()).not.toContain("private-detail");
    expect(wrapper.find("form").exists()).toBe(false);
  });

  it("初回取得失敗のモーダルを閉じたあとも再取得できる", async () => {
    api.get.mockRejectedValueOnce(new Error("fixture unavailable"));
    wrapper = mount(OsrmSettings);
    await flushPromises();
    expect(visibleMessage()).toContain("OSRM設定を取得できませんでした");
    await closeMessage();

    api.get.mockResolvedValueOnce({ data: settings });
    await reloadButton()!.trigger("click");
    await flushPromises();
    expect(reloadButton()).toBeUndefined();
    expect(urlInput("drive").element.value).toBe(driveUrl);
    expect(messageDialog().isVisible()).toBe(false);
  });
});
