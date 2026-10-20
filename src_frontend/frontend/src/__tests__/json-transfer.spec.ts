import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
const state = vi.hoisted(() => ({ logout: vi.fn(), push: vi.fn() }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ logout: state.logout }) }));
vi.mock("@/router", () => ({ default: { push: state.push } }));
vi.mock("@/router/urls", () => ({ refreshTokenUrl: "/account/refresh" }));
vi.mock("@/setting", () => ({ baseUrl: location.origin }));
import apiClient from "@/axiosClient";
import { fetchJsonExport } from "@/utils/json-transfer";

const exact = '{"version":3,"n":9007199254740993.01234567890123456789,"flag":false}';
let requests = 0;
let expired = false;
let failure = 0;
const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
  const response = { data: exact, status: 200, statusText: "OK", headers: {}, config };
  if (config.url === "/account/refresh") return { ...response, data: "{}" };
  requests++;
  const status = failure || (expired && requests === 1 ? 401 : 0);
  if (status)
    throw new AxiosError("failed", "ERR_BAD_REQUEST", config, undefined, {
      ...response,
      status,
      data: JSON.stringify({ error: status === 401 ? "token_expired" : "容量超過" }),
    });
  return response;
});
function text(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}
beforeEach(() => {
  requests = 0;
  expired = false;
  failure = 0;
  adapter.mockClear();
  state.logout.mockClear();
  state.push.mockClear();
  apiClient.defaults.adapter = adapter;
});
describe("JSON transfer without JavaScript number conversion", () => {
  it("keeps the exact response bytes", async () => {
    expect(await text(await fetchJsonExport("/file/export/l"))).toBe(exact);
  });
  it("refreshes an expired token and retries the unchanged export", async () => {
    expired = true;
    expect(await text(await fetchJsonExport("/file/export/l"))).toBe(exact);
    expect(requests).toBe(2);
    expect(adapter.mock.calls.filter(([c]) => c.url === "/file/export/l")).toHaveLength(2);
    expect(adapter.mock.calls.filter(([c]) => c.url === "/account/refresh")).toHaveLength(1);
    expect(state.logout).not.toHaveBeenCalled();
  });
  it("preserves a capacity error as JSON for the caller", async () => {
    failure = 413;
    await expect(fetchJsonExport("/file/export/l")).rejects.toMatchObject({
      response: { status: 413, data: { error: "容量超過" } },
    });
    expect(requests).toBe(1);
  });
});
