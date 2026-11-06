import { flushPromises, mount } from "@vue/test-utils";
import { expect, it, vi } from "vitest";
import MapDisplaySettings from "../MapDisplaySettings.vue";
import { adminMapDisplaySettingsUrl } from "@/router/urls";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));

it("範囲内の整数を保存し、成功するたびに完了メッセージをモーダルに表示する", async () => {
  api.get.mockResolvedValueOnce({ data: { clusteringMinZoom: 15 } });
  const wrapper = mount(MapDisplaySettings, { attachTo: document.body });
  await flushPromises();
  expect(api.get).toHaveBeenCalledWith(adminMapDisplaySettingsUrl);
  const input = wrapper.get<HTMLInputElement>("input");
  const dialog = wrapper.get('[role="dialog"]');
  const submit = async () => {
    await wrapper.get("form").trigger("submit");
    await flushPromises();
  };
  expect(input.element.value).toBe("15");

  for (const invalid of ["", "-1", "1.5", "23"]) {
    await input.setValue(invalid);
    await submit();
    expect(wrapper.get('[role="alert"]').text()).toContain("0〜22の整数");
  }
  expect(api.put).not.toHaveBeenCalled();
  expect(dialog.isVisible()).toBe(false);

  api.put.mockResolvedValueOnce({ data: { clusteringMinZoom: 0 } });
  await input.setValue("0");
  await submit();
  expect(api.put).toHaveBeenCalledWith(adminMapDisplaySettingsUrl, { clusteringMinZoom: 0 });
  expect(input.element.value).toBe("0");
  expect(dialog.isVisible()).toBe(true);
  expect(dialog.get(".message-text").text()).toBe(
    "地図表示設定を保存しました。地図の再読み込み時に反映されます。",
  );
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  await dialog.get("button").trigger("click");
  expect(dialog.isVisible()).toBe(false);

  api.put.mockRejectedValueOnce(new Error("保存失敗"));
  await input.setValue("12");
  await submit();
  expect(dialog.isVisible()).toBe(false);
  expect(wrapper.get('[role="alert"]').text()).toContain("保存できませんでした");
  expect(input.element.value).toBe("12");

  api.put.mockResolvedValueOnce({ data: { clusteringMinZoom: 12 } });
  await submit();
  expect(dialog.isVisible()).toBe(true);
  wrapper.unmount();
});
