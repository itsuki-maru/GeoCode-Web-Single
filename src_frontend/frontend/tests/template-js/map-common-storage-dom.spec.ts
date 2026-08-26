import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMapCommon, type LoadedClassicScript } from "./helpers/load-classic-script";

type BrowserApi = {
  enableTileServerSelectionPersistence: () => void;
  getInitialMapMobileUiHidden: () => boolean;
  getInitialMarkerVisibility: () => boolean;
  getInitialShapeLayerVisibility: () => boolean;
  getInitialShapeNameVisibility: () => boolean;
  getInitialTileServerId: () => string;
  getInitialUserLocationVisibility: () => boolean;
  saveMapMobileUiHidden: (hidden: boolean) => void;
  saveMarkerVisibility: (visible: boolean) => void;
  saveSelectedTileServerId: (id: string) => void;
  saveShapeLayerVisibility: (visible: boolean) => void;
  saveShapeNameVisibility: (visible: boolean) => void;
  saveUserLocationVisibility: (visible: boolean) => void;
};

const exportedNames = [
  "enableTileServerSelectionPersistence",
  "getInitialMapMobileUiHidden",
  "getInitialMarkerVisibility",
  "getInitialShapeLayerVisibility",
  "getInitialShapeNameVisibility",
  "getInitialTileServerId",
  "getInitialUserLocationVisibility",
  "saveMapMobileUiHidden",
  "saveMarkerVisibility",
  "saveSelectedTileServerId",
  "saveShapeLayerVisibility",
  "saveShapeNameVisibility",
  "saveUserLocationVisibility",
] as const;

let loaded: LoadedClassicScript<BrowserApi> | undefined;

afterEach(() => {
  loaded?.dom.window.close();
  loaded = undefined;
});

describe("map-commonのUI状態保存と復元", () => {
  it("編集地図が有効化するまでタイル選択を保存・復元しない", () => {
    loaded = loadMapCommon<BrowserApi>(exportedNames);
    const { api, dom } = loaded;

    dom.window.localStorage.setItem("geocode-web:selected-tile-server-id", "2");
    expect(api.getInitialTileServerId()).toBe("1");

    api.enableTileServerSelectionPersistence();
    expect(api.getInitialTileServerId()).toBe("2");

    api.saveSelectedTileServerId("1");
    expect(dom.window.localStorage.getItem("geocode-web:selected-tile-server-id")).toBe("1");
    api.saveSelectedTileServerId("missing");
    expect(dom.window.localStorage.getItem("geocode-web:selected-tile-server-id")).toBe("1");
  });

  it("保存済みタイルサーバーが存在しない場合は既定値へ戻す", () => {
    loaded = loadMapCommon<BrowserApi>(exportedNames, {
      tileServers: {
        custom: { url: "https://tiles.example.test/custom/{z}/{x}/{y}.png" },
      },
    });
    const { api, dom } = loaded;

    dom.window.localStorage.setItem("geocode-web:selected-tile-server-id", "removed");
    api.enableTileServerSelectionPersistence();

    expect(api.getInitialTileServerId()).toBe("custom");
  });

  it("マーカー・現在位置・図形・図形名・モバイルUIの表示状態を保存して復元する", () => {
    loaded = loadMapCommon<BrowserApi>(exportedNames);
    const { api } = loaded;

    expect(api.getInitialMarkerVisibility()).toBe(true);
    expect(api.getInitialUserLocationVisibility()).toBe(true);
    expect(api.getInitialShapeLayerVisibility()).toBe(true);
    expect(api.getInitialShapeNameVisibility()).toBe(true);
    expect(api.getInitialMapMobileUiHidden()).toBe(false);

    api.saveMarkerVisibility(false);
    api.saveUserLocationVisibility(false);
    api.saveShapeLayerVisibility(false);
    api.saveShapeNameVisibility(false);
    api.saveMapMobileUiHidden(true);

    expect(api.getInitialMarkerVisibility()).toBe(false);
    expect(api.getInitialUserLocationVisibility()).toBe(false);
    expect(api.getInitialShapeLayerVisibility()).toBe(false);
    expect(api.getInitialShapeNameVisibility()).toBe(false);
    expect(api.getInitialMapMobileUiHidden()).toBe(true);
  });
});

describe("map-commonの委譲クリックによるコンテンツ操作", () => {
  it("許可された同一オリジンの画像パスだけをプレビューする", () => {
    const preview = vi.fn();
    loaded = loadMapCommon<BrowserApi>(exportedNames, {
      body: `
        <img id="allowed" class="marker-preview-image" data-preview-src="/static/images/photo.png">
        <img id="blocked-path" class="marker-preview-image" data-preview-src="/private/photo.png">
        <img id="blocked-origin" class="marker-preview-image" data-preview-src="https://attacker.example/static/images/photo.png">
      `,
      globals: { callParentImagePreview: preview },
    });
    const { document, MouseEvent } = loaded.dom.window;

    document.getElementById("allowed")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .getElementById("blocked-path")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .getElementById("blocked-origin")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith("/static/images/photo.png");
  });

  it("許可された同一オリジンのリンクだけをダウンロードする", () => {
    const download = vi.fn();
    loaded = loadMapCommon<BrowserApi>(exportedNames, {
      body: `
        <a id="allowed" class="markdown-download-link" data-download-href="/static/images/document.pdf?download=1">Download</a>
        <a id="blocked" class="markdown-download-link" data-download-href="https://attacker.example/static/images/document.pdf">Blocked</a>
      `,
      globals: { downloadFile: download },
    });
    const { document, MouseEvent } = loaded.dom.window;

    const allowedEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    document.getElementById("allowed")?.dispatchEvent(allowedEvent);
    document.getElementById("blocked")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(allowedEvent.defaultPrevented).toBe(true);
    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith("/static/images/document.pdf?download=1");
  });
});
