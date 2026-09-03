// @ts-nocheck -- Leaflet編集画面の共有スコープを保つ統合境界。
// markedの設定
const videoToken = {
  name: "video",
  level: "inline",
  start(src) {
    return src.match(/\?\[.*\]\(.*\)/)?.index;
  },

  tokenizer(src, tokens) {
    const rule = /^\?\[(.*?)\]\((.*?)\)/;
    const match = rule.exec(src);
    if (match) {
      return {
        type: "video",
        raw: match[0],
        text: match[1],
        href: match[2],
        tokens: this.lexer.inlineTokens(match[1], []),
      };
    }
  },
  renderer(token) {
    return `<video controls src="${token.href}" poster="${token.href}?thumb=true" preload="none">${token.text}</video>`;
  },
};

// カスタムトークン"youtube"の定義（型は緩くanyとする）
const youtubeToken = {
  name: "youtube",
  level: "inline",
  start(src) {
    return src.match(/\?\[.*\]\(.*\)/)?.index;
  },
  tokenizer(src, tokens) {
    const rule = /^\@\[(youtube)\]\((.*?)\)/;
    const match = rule.exec(src);
    if (match) {
      const id = extractYouTubeId(match[2]);
      if (!id) return null;
      return {
        type: "youtube", // カスタムトークンタイプ
        raw: match[0],
        text: id,
        href: match[2],
      };
    }
    return null;
  },
  renderer(token) {
    // 生iframeではなく、自前テンプレートにする（例：Web Component）
    return `<app-youtube video-id="${token.text}" data-src="${token.href}"></app-youtube>`;
  },
};

// 11文字のYouTube ID検証
const ID_RE = /^[\w-]{11}$/;
// YouTube URL から動画IDを安全に取り出す
// 埋め込み要素を含む HTML を表示用に整形する（app-youtubeからiframeに置換）;

// ネスト対応トークナイザの共通関数
// それぞれのトークンを生成
const detailsToken = createNestedTokenizer("details");
const noteToken = createNestedTokenizer("note");
const warningToken = createNestedTokenizer("warning");

marked.use({
  extensions: [videoToken, detailsToken, noteToken, warningToken, youtubeToken],
});

// 実行環境がPWAかブラウザか判定する機能
function isRunningAsPWA() {
  // matchMedia を使用（全般的な環境）
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }

  // iOS Safari の場合
  if (window.navigator.standalone) {
    return true;
  }

  // User-Agent を解析（WebView などの特殊ケース対応）
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  if (/WebView|wv/.test(userAgent)) {
    return true;
  }

  // その他のケースはブラウザと判定
  return false;
}

// 画像クリック時に別ウィンドウで拡大表示できるようにカスタムレンダラを定義
const renderer = new marked.Renderer();
renderer.image = function ({ href }) {
  const separator = href.includes("?") ? "&" : "?";
  const newHref = href ? `${href}${separator}thumb=true` : "";
  const match = href.match(/\/static\/images\/([^\/]+)$/); // 画像ファイル名抜き出し
  if (match) {
    const filename = match[1];
    return `<img src="${newHref}" class="marker-preview-image" data-preview-src="/images/html/${filename}">`;
  } else {
    // 例外処理相当として画像へのリンクをそのまま提供（プレビューなし）
    return `<img src="${href}">`;
  }
};

// リンク先がローカル環境かどうかを判定する
// 対象ファイルが PDF かどうかを判定する
// リンクがダウンロード扱いかどうかを判定する
function isDownload(href) {
  return /\.(pdf|zip|png|jpg|jpeg|gif|txt|csv|mp4|mp3)$/i.test(href);
}

// 指定 URL のファイルをブラウザ経由でダウンロードする
function downloadFile(href) {
  console.log(`Download Start: ${href}`);
  fetch(href)
    .then((response) => response.blob())
    .then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "document.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    })
    .catch(console.error);
}

// [テキスト](URL)で定義された外部リンクを別タブで開かせるカスタムレンダラ設定
const originalLinkRenderer = renderer.link.bind(renderer);
// link関数をオーバーライド
renderer.link = (token) => {
  const { href } = token;
  // 外部リンクかどうかをチェック
  const isExternal = /^https?:\/\//.test(href);
  let isLocal = false;
  let isPDFHref = false;
  let isDownloadable = false;
  if (href) {
    isLocal = isLocalhost(href);
    isPDFHref = isPDF(href);
    isDownloadable = isDownload(href);
  }
  const html = originalLinkRenderer(token);

  // 外部リンク時の処理
  if (isExternal) {
    if (isLocal && isPDFHref) {
      // PWAとしての実行時はPDFダウンロードを実行
      if (isRunningAsPWA()) {
        return html.replace(
          /^<a /,
          `<a class="markdown-download-link" data-download-href="${href}" title="PDFダウンロードリンク" `,
        );
      }
      return html.replace(
        /^<a /,
        '<a target="_blank" rel="noopener noreferrer" title="PDFリンク" ',
      );
    }
    // リンクを別タブで起動
    return html.replace(
      /^<a /,
      '<a target="_blank" rel="noopener noreferrer" title="外部リンク" ',
    );
  } else {
    // 内部リンクかつPDFの場合
    if (isPDFHref) {
      // PWAとしての実行時はダウンロードを実行
      if (isRunningAsPWA()) {
        return html.replace(
          /^<a /,
          `<a class="markdown-download-link" data-download-href="${href}" title="PDFダウンロードリンク" `,
        );
      }
      return html.replace(
        /^<a /,
        '<a target="_blank" rel="noopener noreferrer" title="PDFリンク" ',
      );
    }
    // 内部リンクの場合、元の処理を使用
    return html;
  }
};

marked.setOptions({ renderer });

// detailsタグ内のimgタグとvideoタグ内のネットワークコンテンツを遅延読み込みさせる処理
// XSSフィルタのカスタマイズ
let xssOptions = {
  whiteList: {
    h1: ["id", "class"], // h1タグのid属性を許可 class属性を許可
    h2: ["id", "class"], // h2タグのid属性を許可 class属性を許可
    h3: ["id"], // h3タグのid属性を許可
    h4: ["id"], // h4タグのid属性を許可
    h5: ["id"], // h5タグのid属性を許可
    h6: ["id"], // h6タグのid属性を許可
    pre: ["class"],
    a: ["target", "rel", "href", "title", "class", "data-download-href"],
    img: ["src", "alt", "class", "data-preview-src"],
    video: ["src", "controls", "preload", "poster"],
    p: [],
    div: ["class"],
    span: [],
    li: [],
    strong: [],
    ul: [],
    ol: [],
    li: [],
    blockquote: [],
    code: [],
    table: [],
    tbody: [],
    th: [],
    td: [],
    tr: [],
    details: ["class"],
    summary: [],
    "app-youtube": ["video-id", "data-src"],
  },
  // iframeの確認（念のため、iframeはここで不許可）
  onTag(tag, html) {
    if (tag === "iframe") return "Not Allow iframe ";
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script"],
};

// 地図オブジェクトの初期化
var map = L.map("map", {
  center: [latitude, longitude],
  crs: L.CRS.EPSG3857,
  zoom: zoom,
  zoomControl: true,
  preferCanvas: false,
  // Leafletの著作権表示に_blank属性を追加するために、デフォルト値を無効化
  attributionControl: false,
});

// 日本の最南端と最北端の座標を使用して境界を設定
const southWest = L.latLng(20.25, 122.56), // 最南端の座標
  northEast = L.latLng(49.55, 153.59); // 最北端の座標
const bounds = L.latLngBounds(southWest, northEast);
enableTileServerSelectionPersistence();
const initialTileServerId = getInitialTileServerId();
const initialTileServer = tileServers[initialTileServerId];

// 表示範囲の制限
if (!initialTileServer["include_foreign_tiles"]) {
  map.setMaxBounds(bounds);
}

// leafletのライセンスリンクを別タブで開く設定を付与して追加
L.control
  .attribution({ prefix: false })
  .addAttribution(
    '&copy; <a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>',
  )
  .addTo(map);

// 地図を見やすくするため、操作 UI の表示状態をまとめて管理する
const hideableMapUiContainers = new Set();
let isMapUiHidden = getInitialMapMobileUiHidden();
let mapUiVisibilityToggleButton = null;

// UI 表示切替ボタンの文言とアクセシビリティ属性を更新する
function updateMapUiVisibilityToggleButton() {
  if (!mapUiVisibilityToggleButton) {
    return;
  }

  const buttonText = isMapUiHidden ? "機能を表示" : "機能を非表示";
  mapUiVisibilityToggleButton.textContent = buttonText;
  mapUiVisibilityToggleButton.setAttribute("aria-label", buttonText);
  mapUiVisibilityToggleButton.setAttribute(
    "aria-pressed",
    String(isMapUiHidden),
  );
}

// 登録済みの操作 UI を一括で表示・非表示にする
function setMapUiHidden(hidden) {
  isMapUiHidden = hidden;
  hideableMapUiContainers.forEach((container) => {
    container.classList.toggle("is-hidden", isMapUiHidden);
  });
  updateMapUiVisibilityToggleButton();
  saveMapMobileUiHidden(isMapUiHidden);
}

// 非表示対象の Leaflet コントロール DOM を登録する
function registerHideableMapUiContainer(container) {
  if (!container) {
    return;
  }

  container.classList.add("map-mobile-hideable-ui");
  container.classList.toggle("is-hidden", isMapUiHidden);
  hideableMapUiContainers.add(container);
}

// Leaflet コントロールから非表示対象の DOM を取り出して登録する
function registerHideableMapControl(control) {
  if (control && typeof control.getContainer === "function") {
    registerHideableMapUiContainer(control.getContainer());
  }
  return control;
}

// 共通ヘルパー内で追加されるコントロールを検出するため、追加前の状態を控える
function getMapControlContainersSnapshot() {
  return new Set(
    Array.from(
      document.querySelectorAll(".leaflet-control-container .leaflet-control"),
    ),
  );
}

// 追加前の状態と比較し、新しく増えたコントロールだけを非表示対象にする
function registerNewHideableMapControlContainers(previousContainers) {
  document
    .querySelectorAll(".leaflet-control-container .leaflet-control")
    .forEach((container) => {
      if (!previousContainers.has(container)) {
        registerHideableMapUiContainer(container);
      }
    });
}

// 操作 UI の表示・非表示を切り替えるボタン
const MapUiVisibilityToggleControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function () {
    const container = L.DomUtil.create(
      "div",
      "leaflet-bar leaflet-control map-ui-visibility-toggle-control",
    );
    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.type = "button";
    mapUiVisibilityToggleButton = button;

    L.DomEvent.on(button, "click", function (event) {
      L.DomEvent.stop(event);
      setMapUiHidden(!isMapUiHidden);
    });

    L.DomEvent.disableClickPropagation(container);
    if (L.DomEvent.disableScrollPropagation) {
      L.DomEvent.disableScrollPropagation(container);
    }
    updateMapUiVisibilityToggleButton();
    return container;
  },
});

map.addControl(new MapUiVisibilityToggleControl());

// 入力モードと閲覧モードの制御
var ModeControl = L.Control.extend({
  options: {
    position: "topright",
  },

  onAdd: function (map) {
    var container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
    // ラジオボタンのHTMLを作成
    container.innerHTML = `
        <div class="radio-zone">
            <form>
                <input class="custom-radio" type="radio" id="viewMode" name="mode" value="view" checked>
                <label for="viewMode" class="custom-radio-label">閲覧モード</label><br>
                <input class="custom-radio" type="radio" id="inputMode" name="mode" value="input">
                <label for="inputMode" class="custom-radio-label">入力モード</label><br>
                <input class="custom-radio" type="radio" id="editMode" name="mode" value="edit">
                <label for="editMode" class="custom-radio-label">移動モード</label>
            </form>
        </div>`;

    // ラジオボタンのイベントリスナーを追加
    const radios = container.querySelectorAll(".custom-radio");
    radios.forEach((radio) => {
      radio.addEventListener("change", handleRadioChange);
    });

    // Leafletのクリックイベントとの干渉を避ける
    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

// 地図にカスタムコントロールを追加
const modeControl = new ModeControl();
map.addControl(modeControl);
registerHideableMapControl(modeControl);

// タイルレイヤーの制御
var TileControl = L.Control.extend({
  options: {
    position: "topright",
  },
  onAdd: function (map) {
    var container = L.DomUtil.create("div", "leaflet-bar leaflet-control");

    // ラジオボタンのHTMLを動的に生成
    let radioHTML = '<div class="radio-zone"><form>';
    for (const key in tileServers) {
      let checkedAttribute = "";
      if (key === initialTileServerId) {
        checkedAttribute = "checked";
      }
      radioHTML += `
                <input class="tile-radio" type="radio" id="${escapeHtml(tileServers[key]["layer_name"])}" name="tile" value="${key}" ${checkedAttribute}>
                <label for="${escapeHtml(tileServers[key]["layer_name"])}" class="tile-radio-label">${escapeHtml(tileServers[key]["label"])}</label><br>
                `;
    }
    radioHTML += "</form></div>";
    container.innerHTML = radioHTML;

    // タイルのイベントリスナーを追加
    const tileRadios = container.querySelectorAll(".tile-radio");
    tileRadios.forEach((radio) => {
      radio.addEventListener("change", handleTileChange);
    });

    // Leafletのクリックイベントとの干渉を避ける
    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

// 地図にタイルコントロールを追加
const tileControl = new TileControl();
map.addControl(tileControl);
registerHideableMapControl(tileControl);

// 初期タイルの設定
var tileLayer = L.tileLayer(initialTileServer["url"], {
  minZoom: initialTileServer["min_zoom"] ?? 5,
  maxZoom: initialTileServer["max_zoom"] ?? 18,
  attribution: initialTileServer["attribution"],
}).addTo(map);

// 選択されたタイルサーバーに地図表示を切り替える関数
// マーカーにIDを振るためのオブジェクト
let markers = {};
// Leaflet.markerclusterの使用
let markersClusterGroup = L.markerClusterGroup();
let externalMarkerFilterIds = null;
let externalShapeFilterIdSet = null;
let localMarkerSearchQuery = "";

// HTMLと同時に取得したマーカーデータをプロット配備
for (const key in markersFromAxum) {
  let marker = L.marker(
    [markersFromAxum[key]["latitude"], markersFromAxum[key]["longitude"]],
    markerOptionsForLayer(markersFromAxum[key]["layer_id"], layersFromAxum, {
      draggable: false,
    }),
  )
    .addTo(markersClusterGroup)
    .on("dragend", function (event) {
      var movedMarker = event.target;
      var position = movedMarker.getLatLng();
      updateServer(markersFromAxum[key]["id"], position.lat, position.lng);
    });

  // ポップアップオープン時に遅延読み込みの処理を追加
  marker.on("popupopen", () => {
    setupDetailsLazyImages(document);
  });

  // マークダウンをパース
  if (!markersFromAxum[key]["marker_name"]) {
    marker.bindTooltip(`<div class="custom-tooltip">No Name</div>`);
  } else {
    marker.bindTooltip(
      `<div class="custom-tooltip">${escapeHtml(markersFromAxum[key]["marker_name"])}</div>`,
    );
  }
  if (markersFromAxum[key]["detail"]) {
    const mdText = `# ${markersFromAxum[key]["marker_name"]}\n\n${markersFromAxum[key]["detail"]}`;
    const mdToHtml = marked.parse(mdText);
    const cleanHtml = filterXSS(mdToHtml, xssOptions);
    const renderHtml = renderIframe(cleanHtml);
    const bindMDToHtml = `<div class="md-detail-contents">${renderHtml}</div>`;
    marker.bindPopup(bindMDToHtml);
  }

  // マーカーのHTML要素を取得し、id属性を設定
  let markerIcon = marker.getElement();
  if (markerIcon) {
    markerIcon.id = `marker-${markersFromAxum[key]["id"]}`;
  }
  markers[`marker-${markersFromAxum[key]["id"]}`] = marker;
  if (markerId !== "0") {
    openMarkerPopup(markerId);
  }
}

// クラスターをレイヤーに追加
if (getInitialMarkerVisibility()) {
  map.addLayer(markersClusterGroup);
}

function renderVisibleMarkers() {
  markersClusterGroup.clearLayers();

  const externalMarkerIdSet = Array.isArray(externalMarkerFilterIds)
    ? new Set(externalMarkerFilterIds.map((id) => `marker-${id}`))
    : null;

  Object.keys(markersFromAxum).forEach((key) => {
    const record = markersFromAxum[key];
    const markerKey = `marker-${record?.id}`;
    const marker = markers[markerKey];

    if (!marker) {
      return;
    }

    if (externalMarkerIdSet && !externalMarkerIdSet.has(markerKey)) {
      return;
    }

    if (!matchesMarkerSearch(record, localMarkerSearchQuery)) {
      return;
    }

    markersClusterGroup.addLayer(marker);
  });

  if (map && typeof map.closePopup === "function") {
    map.closePopup();
  }
}

function applyMarkerFilter(markerIds) {
  externalMarkerFilterIds = Array.isArray(markerIds) ? markerIds : null;
  renderVisibleMarkers();
}

function applyMapObjectFilter(markerIds, shapeIds) {
  externalMarkerFilterIds = Array.isArray(markerIds) ? markerIds : null;
  externalShapeFilterIdSet = Array.isArray(shapeIds)
    ? new Set(shapeIds.map(String))
    : null;
  renderVisibleMarkers();
  renderVisibleShapes();
}

function applyLocalMarkerSearch(query) {
  localMarkerSearchQuery = query;
  renderVisibleMarkers();
  renderVisibleShapes();
}

// 描画した形状を管理するレイヤーを作成
