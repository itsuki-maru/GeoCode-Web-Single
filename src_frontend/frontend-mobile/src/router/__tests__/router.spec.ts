import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authCheck: vi.fn(),
  mapObjectsInit: vi.fn(),
  layersInit: vi.fn(),
  imagesInit: vi.fn(),
}));

vi.mock("@/axiosClient", () => ({ default: { get: dependencies.authCheck } }));
vi.mock("@/stores/mapobjects", () => ({
  useMapObjectStore: () => ({ initList: dependencies.mapObjectsInit }),
}));
vi.mock("@/stores/layers", () => ({
  useLayersStore: () => ({ initList: dependencies.layersInit }),
}));
vi.mock("@/stores/images", () => ({
  useImageStore: () => ({ initList: dependencies.imagesInit }),
}));

// Guard tests use the real router, but do not need to load the view component trees.
vi.mock("@/views/AppTopMobile.vue", () => ({ default: { render: () => null } }));
vi.mock("@/views/MapViewMobile.vue", () => ({ default: { render: () => null } }));
vi.mock("@/views/auth/LoginViewMobile.vue", () => ({ default: { render: () => null } }));

import router from "@/router";
import { authCheckUrl } from "@/router/urls";

beforeEach(async () => {
  await router.replace("/");
});

describe("地図ルートの認証ガード", () => {
  it("認証成功後に地図画面へ遷移して各ストアを初期化する", async () => {
    dependencies.authCheck.mockResolvedValue({ data: {} });
    await router.push("/mapview");
    expect(dependencies.authCheck).toHaveBeenCalledExactlyOnceWith(authCheckUrl);
    expect(router.currentRoute.value.name).toBe("map");
    expect(dependencies.mapObjectsInit).toHaveBeenCalledOnce();
    expect(dependencies.layersInit).toHaveBeenCalledOnce();
    expect(dependencies.imagesInit).toHaveBeenCalledOnce();
  });

  it("認証失敗時はストアを初期化せずログイン画面へリダイレクトする", async () => {
    dependencies.authCheck.mockRejectedValue(new Error("unauthorized"));
    await router.push("/mapview");
    expect(dependencies.authCheck).toHaveBeenCalledExactlyOnceWith(authCheckUrl);
    expect(router.currentRoute.value.name).toBe("login");
    expect(dependencies.mapObjectsInit).not.toHaveBeenCalled();
    expect(dependencies.layersInit).not.toHaveBeenCalled();
    expect(dependencies.imagesInit).not.toHaveBeenCalled();
  });
});
