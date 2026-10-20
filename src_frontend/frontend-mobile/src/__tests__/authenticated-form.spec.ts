import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
const state = vi.hoisted(() => ({ logout: vi.fn(), push: vi.fn() }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ logout: state.logout }) }));
vi.mock("@/router", () => ({ default: { push: state.push } }));
vi.mock("@/router/urls", () => ({ refreshTokenUrl: "/account/refresh" }));
vi.mock("@/setting", () => ({ baseUrl: location.origin }));
vi.mock("@/settingMobile", () => ({ baseUrl: location.origin }));
import apiClient from "@/axiosClient";
import { submitAuthenticatedForm } from "@/utils/authenticated-form";

const disposers: (() => void)[] = [];
let authCount = 0,
  expirationCount = 1,
  failRefresh = false;
const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
  const response = { data: {}, status: 200, statusText: "OK", headers: {}, config };
  if (config.url === "/account/refresh" && failRefresh)
    throw new AxiosError("expired", "ERR_BAD_REQUEST", config, undefined, {
      ...response,
      status: 401,
      data: { error: "refresh_token_expired" },
    });
  if (config.url === "/account/auth" && ++authCount <= expirationCount)
    throw new AxiosError("expired", "ERR_BAD_REQUEST", config, undefined, {
      ...response,
      status: 401,
      data: { error: "token_expired" },
    });
  return response;
});
beforeEach(() => {
  authCount = 0;
  expirationCount = 1;
  failRefresh = false;
  adapter.mockClear();
  state.logout.mockClear();
  state.push.mockClear();
  apiClient.defaults.adapter = adapter;
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function setup(path: string) {
  const form = document.createElement("form"),
    frame = document.createElement("iframe");
  form.action = location.origin + path;
  form.method = "post";
  form.innerHTML =
    '<input name="query" value=\'{"mode":"latest","as_of":"2026-10-20T00:00:00Z"}\'>';
  document.body.append(form, frame);
  const error = vi.fn();
  const dispose = submitAuthenticatedForm(form, frame, error);
  disposers.push(dispose);
  const action = new URL(form.action);
  const send = (data = {}, origin = location.origin, source: Window | null = frame.contentWindow) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: {
          type: "native-form-auth-error",
          error: "token_expired",
          requestId: action.searchParams.get("native_request_id"),
          ...data,
        },
      }),
    );
  return { form, frame, send, dispose, error };
}
describe("native form authentication recovery using the real apiClient interceptors", () => {
  it("shares one refresh between concurrent map and CSV recovery", async () => {
    expirationCount = 2;
    const map = setup("/form-answers/map"),
      csv = setup("/form-answers/download");
    map.send();
    csv.send();
    await flushPromises();
    expect(adapter.mock.calls.filter(([c]) => c.url === "/account/refresh")).toHaveLength(1);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(4);
    expect(map.form.method).toBe("post");
    expect(csv.form.method).toBe("post");
    expect(map.error).not.toHaveBeenCalled();
    expect(csv.error).not.toHaveBeenCalled();
  });
  it.each(["/form-answers/map", "/form-answers/download", "/form-answers/map-csv-download"])(
    "%s: refreshes and retries the same native POST once",
    async (path) => {
      const s = setup(path),
        query = new FormData(s.form).get("query");
      s.send();
      await flushPromises();
      expect(adapter.mock.calls.map(([c]) => c.url)).toEqual([
        "/account/auth",
        "/account/refresh",
        "/account/auth",
      ]);
      expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
      expect(new FormData(s.form).get("query")).toBe(query);
      expect(s.error).not.toHaveBeenCalled();
      s.send();
      await flushPromises();
      expect(s.error).toHaveBeenCalledOnce();
      expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
    },
  );
  it("ignores other origins, frames, IDs and duplicated recovery messages", async () => {
    const s = setup("/form-answers/map");
    s.send({}, "https://foreign.example");
    s.send({}, location.origin, window);
    s.send({ requestId: "old" });
    expect(adapter).not.toHaveBeenCalled();
    s.send();
    s.send();
    await flushPromises();
    expect(adapter.mock.calls.filter(([c]) => c.url === "/account/refresh")).toHaveLength(1);
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2);
  });
  it("does not resubmit after closing while authentication is pending", async () => {
    const s = setup("/form-answers/download");
    s.send();
    s.dispose();
    await flushPromises();
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    expect(s.error).not.toHaveBeenCalled();
  });
  it("reports refresh failure and preserves the existing login redirection", async () => {
    failRefresh = true;
    const s = setup("/form-answers/map");
    s.send();
    await flushPromises();
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    expect(s.error).toHaveBeenCalledOnce();
    expect(state.logout).toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledWith("/account/login");
  });
});
