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

marked.use({
  mangle: false,
  headerIds: false,
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
const originalImageRenderer = renderer.image;
renderer.image = function (href, title, text) {
  const separator = href.includes("?") ? "&" : "?";
  const newHref = href ? `${href}${separator}thumb=true` : "";
  const titleAttr = title ? ` title="${title}"` : "";
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
renderer.link = (href, title, text) => {
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
  const html = originalLinkRenderer(href, title, text);

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
    return originalLinkRenderer(href, title, text);
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
map.addLayer(markersClusterGroup);

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
const drawnShapesGroup = L.featureGroup();
const searchableShapeLayers = new Set();
const SHAPE_STYLE = {
  color: "#d94841",
  weight: 5,
  fillColor: "#d94841",
  fillOpacity: 0.16,
};
const DELETE_SHAPE_STYLE = {
  color: "#c1121f",
  weight: 8,
  fillColor: "#f28482",
  fillOpacity: 0.28,
};
const DELETE_HIT_TOLERANCE_PX = 18;
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;
const SHAPE_VERTEX_ADD_TOLERANCE_PX = 24;
const SHAPE_VERTEX_MIN_DISTANCE_PX = 16;
const shapeGeometryEditHandles = L.featureGroup();
let currentMapMode = "view";
let geometryEditingShapeLayer = null;
let isShapeGeometrySaving = false;
let circleShapeDragState = null;
let drawStatusAutoHideTimer = null;

let activeDrawMode = null;
let isCompletingActiveDrawing = false;
let drawPoints = [];
let drawPreviewLayer = null;
let rectangleStartLatLng = null;
let circleStartLatLng = null;
let deletedShapesStack = [];
let editingShapeLayer = null;
let editingShapePopup = null;
let shapeVertexDeletePopup = null;
let shapeVertexDeleteTarget = null;
let suppressMapClickUntil = 0;
let suppressedPropagatedMapClickEvent = null;
let suppressTouchEndUntil = 0;
let activePenPointerId = null;
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;
let drawingInteractionState = null;
const deletingShapeIds = new Set();
const deletedShapeIds = new Set();

// 図形描画用のステータスメッセージを更新する
function setDrawStatus(message, isError = false, forceVisible = false) {
  const status = document.getElementById("draw-status");
  if (!status) {
    return;
  }
  if (drawStatusAutoHideTimer) {
    clearTimeout(drawStatusAutoHideTimer);
    drawStatusAutoHideTimer = null;
  }
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  if (!forceVisible) {
    const panel = document.getElementById("draw-control-panel");
    status.classList.toggle(
      "is-hidden",
      !panel || panel.classList.contains("is-collapsed"),
    );
    return;
  }

  status.classList.remove("is-hidden");
  drawStatusAutoHideTimer = setTimeout(() => {
    const panel = document.getElementById("draw-control-panel");
    if (!panel || panel.classList.contains("is-collapsed")) {
      status.classList.add("is-hidden");
    }
    drawStatusAutoHideTimer = null;
  }, 4000);
}

// ラベルやポップアップ表示用に HTML をエスケープする
// 図形名を表示・保存しやすい形に正規化する
// 図形色を #RRGGBB 形式へ正規化する
// 図形種別ごとの既定スタイルを返す
// GeoJSON から図形スタイルを取り出す
// 選択色から図形スタイルを作る
function buildShapeStyleFromColor(
  shapeType,
  color,
  lineType = "solid",
  weight = SHAPE_STYLE.weight,
) {
  const normalizedColor = normalizeShapeColor(color, SHAPE_STYLE.color);
  const defaultStyle = getDefaultShapeStyle(shapeType);
  const dashArray = getShapeDashArray(lineType);
  const normalizedWeight = normalizeShapeWeight(weight, defaultStyle.weight);
  if (shapeType === "polyline") {
    return {
      color: normalizedColor,
      weight: normalizedWeight,
      dashArray,
      fill: false,
    };
  }

  return {
    color: normalizedColor,
    weight: normalizedWeight,
    dashArray,
    fillColor: normalizedColor,
    fillOpacity: defaultStyle.fillOpacity,
  };
}

// 図形レイヤから保存用 GeoJSON を組み立てる
function buildShapeGeoJson(
  layer,
  shapeType,
  shapeStyle,
  shapeMemo = layer?.shapeMemo,
) {
  const geojson = layer.toGeoJSON();
  const normalizedStyle = {
    color: normalizeShapeColor(shapeStyle?.color, SHAPE_STYLE.color),
    weight: normalizeShapeWeight(shapeStyle?.weight, SHAPE_STYLE.weight),
    dashArray: normalizeShapeDashArray(shapeStyle?.dashArray),
  };

  if (shapeType !== "polyline") {
    normalizedStyle.fillColor = normalizeShapeColor(
      shapeStyle?.color,
      normalizedStyle.color,
    );
    normalizedStyle.fillOpacity = Number.isFinite(
      Number(shapeStyle?.fillOpacity),
    )
      ? Number(shapeStyle.fillOpacity)
      : SHAPE_STYLE.fillOpacity;
  }

  geojson.properties = {
    ...(geojson.properties && typeof geojson.properties === "object"
      ? geojson.properties
      : {}),
    style: normalizedStyle,
    memo: normalizeShapeMemo(shapeMemo),
  };
  if (shapeType === "circle") {
    const radius = Number(layer?.getRadius?.());
    if (Number.isFinite(radius) && radius > 0) {
      geojson.properties.radius = radius;
    }
  }
  return geojson;
}

// GeoJSON に保存された半径を取り出す
// 選択中の図形色を取得する
function getSelectedShapeColor() {
  const input = document.getElementById("draw-shape-color");
  return normalizeShapeColor(input?.value, SHAPE_STYLE.color);
}

// 現在の図形色入力欄へ色を反映する
function setSelectedShapeColor(color) {
  const input = document.getElementById("draw-shape-color");
  if (!input) {
    return;
  }
  input.value = normalizeShapeColor(color, SHAPE_STYLE.color);
}

// 図形名入力欄の現在値を取得する
function getShapeNameInputValue() {
  const input = document.getElementById("draw-shape-name");
  if (!input) {
    return "";
  }
  return normalizeShapeName(input.value);
}

// 図形名入力欄をクリアする
function clearShapeNameInput() {
  const input = document.getElementById("draw-shape-name");
  if (input) {
    input.value = "";
  }
}

// 開いている図形名編集ポップアップを閉じる
function closeShapeNameEditor() {
  if (editingShapePopup) {
    map.closePopup(editingShapePopup);
  }
  editingShapePopup = null;
  editingShapeLayer = null;
}

// 開いている頂点削除確認ポップアップを閉じる
function closeShapeVertexDeletePopup() {
  const popup = shapeVertexDeletePopup;
  shapeVertexDeletePopup = null;
  shapeVertexDeleteTarget = null;
  if (popup && map.hasLayer(popup)) {
    map.closePopup(popup);
  }
}

// 描画途中のプレビュー図形を地図上から取り除く
function clearDrawPreview() {
  if (drawPreviewLayer) {
    map.removeLayer(drawPreviewLayer);
    drawPreviewLayer = null;
  }
}

// タッチ描画中だけ地図操作を止め、指の移動を図形プレビューに集中させる
function setDrawingMapInteractionsDisabled(shouldDisable) {
  if (shouldDisable && !drawingInteractionState) {
    drawingInteractionState = {
      dragging: Boolean(map.dragging?.enabled?.()),
      touchZoom: Boolean(map.touchZoom?.enabled?.()),
      doubleClickZoom: Boolean(map.doubleClickZoom?.enabled?.()),
      boxZoom: Boolean(map.boxZoom?.enabled?.()),
    };
    map.dragging?.disable?.();
    map.touchZoom?.disable?.();
    map.doubleClickZoom?.disable?.();
    map.boxZoom?.disable?.();
    return;
  }

  if (!shouldDisable && drawingInteractionState) {
    if (drawingInteractionState.dragging) {
      map.dragging?.enable?.();
    }
    if (drawingInteractionState.touchZoom) {
      map.touchZoom?.enable?.();
    }
    if (drawingInteractionState.doubleClickZoom) {
      map.doubleClickZoom?.enable?.();
    }
    if (drawingInteractionState.boxZoom) {
      map.boxZoom?.enable?.();
    }
    drawingInteractionState = null;
  }
}

function updateShapeDrawingState() {
  const mapContainer = map.getContainer();
  if (mapContainer) {
    mapContainer.classList.toggle("is-shape-drawing", Boolean(activeDrawMode));
    mapContainer.classList.toggle(
      "is-shape-delete",
      activeDrawMode === "delete",
    );
  }
  setDrawingMapInteractionsDisabled(Boolean(activeDrawMode));
}

function suppressNextMapClick(durationMs = 700) {
  suppressMapClickUntil = Date.now() + durationMs;
}

function isMapClickSuppressed() {
  if (Date.now() >= suppressMapClickUntil) {
    return false;
  }
  suppressMapClickUntil = 0;
  return true;
}

// Leaflet 内部で地図へ伝播する操作済みクリックのうち、その同一イベントだけを無視する
function suppressPropagatedMapClick(event) {
  if (event?.type !== "click" || !event.originalEvent) {
    return;
  }

  const originalEvent = event.originalEvent;
  suppressedPropagatedMapClickEvent = originalEvent;
  setTimeout(() => {
    if (suppressedPropagatedMapClickEvent === originalEvent) {
      suppressedPropagatedMapClickEvent = null;
    }
  }, 0);
}

function isPropagatedMapClickSuppressed(event) {
  if (
    !suppressedPropagatedMapClickEvent ||
    event?.originalEvent !== suppressedPropagatedMapClickEvent
  ) {
    return false;
  }

  suppressedPropagatedMapClickEvent = null;
  return true;
}

function suppressNextTouchEnd(durationMs = 700) {
  suppressTouchEndUntil = Date.now() + durationMs;
}

function isTouchEndSuppressed() {
  return Date.now() < suppressTouchEndUntil;
}

function getLatLngFromTouchEvent(event) {
  if (event.latlng) {
    return event.latlng;
  }

  const originalEvent = event.originalEvent;
  const touch =
    originalEvent?.changedTouches?.[0] || originalEvent?.touches?.[0];
  if (!touch) {
    return null;
  }

  const containerPoint = map.mouseEventToContainerPoint(touch);
  return map.containerPointToLatLng(containerPoint);
}

function isPenPointerEvent(event) {
  return event?.pointerType === "pen";
}

function isPenOptimizedDrawMode() {
  return Boolean(activeDrawMode && activeDrawMode !== "delete");
}

function getLatLngFromPointerEvent(event) {
  if (!event) {
    return null;
  }
  const containerPoint = map.mouseEventToContainerPoint(event);
  return map.containerPointToLatLng(containerPoint);
}

function stopNativeDrawingEvent(event) {
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

function updateExistingPreviewLayer(mode, latLngs) {
  const previewStyle = {
    ...buildShapeStyleFromColor(mode, getSelectedShapeColor()),
    dashArray: "6,4",
  };

  if (mode === "rectangle") {
    if (!rectangleStartLatLng || !latLngs?.[0]) {
      return;
    }
    const bounds = L.latLngBounds(rectangleStartLatLng, latLngs[0]);
    if (
      drawPreviewLayer?.previewMode === "rectangle" &&
      typeof drawPreviewLayer.setBounds === "function"
    ) {
      drawPreviewLayer.setBounds(bounds);
      drawPreviewLayer.setStyle(previewStyle);
      return;
    }
    clearDrawPreview();
    drawPreviewLayer = L.rectangle(bounds, previewStyle).addTo(map);
    drawPreviewLayer.previewMode = "rectangle";
    return;
  }

  if (mode === "circle") {
    if (!circleStartLatLng || !latLngs?.[0]) {
      return;
    }
    const radius = map.distance(circleStartLatLng, latLngs[0]);
    if (!(radius > 0)) {
      return;
    }
    if (
      drawPreviewLayer?.previewMode === "circle" &&
      typeof drawPreviewLayer.setRadius === "function"
    ) {
      drawPreviewLayer.setLatLng(circleStartLatLng);
      drawPreviewLayer.setRadius(radius);
      drawPreviewLayer.setStyle(previewStyle);
      return;
    }
    clearDrawPreview();
    drawPreviewLayer = L.circle(circleStartLatLng, {
      ...previewStyle,
      radius,
    }).addTo(map);
    drawPreviewLayer.previewMode = "circle";
    return;
  }

  if (
    drawPreviewLayer?.previewMode === mode &&
    typeof drawPreviewLayer.setLatLngs === "function"
  ) {
    drawPreviewLayer.setLatLngs(latLngs);
    drawPreviewLayer.setStyle(previewStyle);
    return;
  }
  clearDrawPreview();
  drawPreviewLayer = createPreviewLayer(mode, latLngs).addTo(map);
  drawPreviewLayer.previewMode = mode;
}

// 現在の描画モードに応じてボタン状態を更新する
function updateDrawButtons(container) {
  const buttons = container.querySelectorAll("[data-draw-mode]");
  buttons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.drawMode === activeDrawMode,
    );
  });
}

// Undo ボタンの活性状態をスタックに合わせて更新する
function updateUndoButtonState() {
  const undoButton = document.getElementById("draw-undo-btn");
  if (!undoButton) {
    return;
  }
  undoButton.disabled = deletedShapesStack.length === 0;
}

// 図形ツールパネルの開閉状態を切り替える
function toggleDrawPanel(forceExpanded = null) {
  const panel = document.getElementById("draw-control-panel");
  const toggleButton = document.getElementById("draw-toggle-btn");
  const status = document.getElementById("draw-status");
  if (!panel || !toggleButton) {
    return;
  }

  const shouldExpand =
    forceExpanded === null
      ? panel.classList.contains("is-collapsed")
      : forceExpanded;

  panel.classList.toggle("is-collapsed", !shouldExpand);
  toggleButton.textContent = shouldExpand ? "図形ツールを閉じる" : "図形ツール";
  if (status) {
    status.classList.toggle("is-hidden", !shouldExpand);
  }
}

// 通常時と削除モードで図形スタイルを切り替える
function applyShapeStyle(layer, isDeleteMode = false) {
  if (!layer || typeof layer.setStyle !== "function") {
    return;
  }

  const style = isDeleteMode
    ? DELETE_SHAPE_STYLE
    : layer.shapeStyle || getDefaultShapeStyle(layer.shapeType);
  const nextStyle = { ...style };
  if (layer.shapeType === "polyline" || isDeleteMode) {
    nextStyle.fill = false;
  }
  layer.setStyle(nextStyle);
}

// すでに描画済みの図形へ現在モードの見た目を反映する
function updateShapesInteractionStyle() {
  const measurementLayers = [];

  drawnShapesGroup.eachLayer((layer) => {
    if (layer?.isMeasurementLabel === true) {
      measurementLayers.push(layer);
      return;
    }
    applyShapeStyle(layer, activeDrawMode === "delete");
    if (
      activeDrawMode === "delete" &&
      typeof layer.bringToFront === "function"
    ) {
      layer.bringToFront();
    }
  });

  measurementLayers.forEach((layer) => {
    if (typeof layer.bringToFront === "function") {
      layer.bringToFront();
    }
  });
}

// 描画中の内部状態を初期化して通常状態へ戻す
function resetDrawingState(message = "図形描画: オフ", isError = false) {
  activeDrawMode = null;
  activePenPointerId = null;
  drawPoints = [];
  rectangleStartLatLng = null;
  circleStartLatLng = null;
  clearDrawPreview();
  updateShapeDrawingState();
  updateShapesInteractionStyle();
  setDrawStatus(message, isError);
  const drawControl = document.getElementById("draw-control");
  if (drawControl) {
    updateDrawButtons(drawControl);
  }
}

// 指定モードで図形描画を開始する
function beginDrawing(mode) {
  closeShapeNameEditor();
  clearShapeGeometryEditing();
  toggleDrawPanel(true);
  activeDrawMode = mode;
  drawPoints = [];
  rectangleStartLatLng = null;
  circleStartLatLng = null;
  clearDrawPreview();
  updateShapeDrawingState();
  if (mode === "rectangle") {
    setDrawStatus("図形描画: 矩形の1点目をタップしてください。");
  } else if (mode === "circle") {
    setDrawStatus("図形描画: 円の中心をタップしてください。");
  } else if (mode === "delete") {
    setDrawStatus("図形描画: 削除したい図形をタップしてください。");
  } else if (mode === "polyline") {
    setDrawStatus("図形描画: 線の頂点をタップし、完了を押してください。");
  } else {
    setDrawStatus("図形描画: 面の頂点をタップし、完了を押してください。");
  }
  updateShapesInteractionStyle();
  const drawControl = document.getElementById("draw-control");
  if (drawControl) {
    updateDrawButtons(drawControl);
  }
}

// 描画途中のプレビュー用レイヤを生成する
function createPreviewLayer(mode, latLngs) {
  const previewStyle = {
    ...buildShapeStyleFromColor(mode, getSelectedShapeColor()),
    dashArray: "6,4",
  };
  if (mode === "polyline") {
    return L.polyline(latLngs, previewStyle);
  }
  if (mode === "circle") {
    if (!Array.isArray(latLngs) || latLngs.length < 2) {
      return null;
    }
    const radius = map.distance(latLngs[0], latLngs[latLngs.length - 1]);
    if (!(radius > 0)) {
      return null;
    }
    return L.circle(latLngs[0], {
      ...previewStyle,
      radius,
    });
  }
  return L.polygon(latLngs, previewStyle);
}

// Leaflet の座標配列をラベル計算しやすい一次元配列へ平坦化する
function flattenShapeLatLngs(latLngs) {
  if (!Array.isArray(latLngs) || latLngs.length === 0) {
    return [];
  }

  if (Array.isArray(latLngs[0])) {
    return flattenShapeLatLngs(latLngs[0]);
  }

  return latLngs;
}

// 折れ線ラベル用の代表位置を算出する
// 図形ラベルを配置する中心座標を求める
function getShapeLabelLatLng(layer) {
  if (!layer) {
    return null;
  }
  if (layer.shapeType === "polyline") {
    return getPolylineCenterLatLng(layer);
  }
  if (layer.shapeType === "circle" && typeof layer.getLatLng === "function") {
    return layer.getLatLng();
  }
  if (typeof layer.getBounds === "function") {
    return layer.getBounds().getCenter();
  }
  return null;
}

// 距離をメートル/キロメートル表記へ整形する
// 面積を平方メートル/平方キロメートル表記へ整形する
// 閉じたリングの終点重複を除去する
// ポリラインの各区間距離と総延長を計算する
// ポリゴン面積を EPSG:3857 の平面近似で求める
// ポリゴン/短形の各辺距離と面積を計算する
function measurePolygon(layer) {
  const latLngs = trimClosedLatLngs(flattenShapeLatLngs(layer?.getLatLngs?.()));
  const edges = [];

  for (let i = 0; i < latLngs.length; i += 1) {
    const start = latLngs[i];
    const end = latLngs[(i + 1) % latLngs.length];
    edges.push({
      label: `${i + 1}`,
      distance: map.distance(start, end),
    });
  }

  return {
    edges,
    area: calculateProjectedPolygonArea(latLngs),
  };
}

// 円の半径と面積を計算する
// 線分の中点を求める
// 計測表示用に図形の頂点一覧を取得する
// 図形の頂点を示す丸マーカーを置く
// 複数線分の距離上の中央位置を求める
// 隣接線分をまとめた計測ラベルを作る
// 結合表示時に各結合区間の両端だけを示す丸マーカーを作る
// 計測ラベルの HTML を組み立てる
// 指定位置に計測ラベルマーカーを置く
// 図形ごとの計測ラベル一覧を生成する
function createShapeMeasurementMarkers(layer) {
  if (!layer) {
    return [];
  }

  const markers = [];
  let measurementSegments = [];

  if (layer.shapeType === "polyline") {
    const latLngs = flattenShapeLatLngs(layer.getLatLngs());
    const measurement = measurePolyline(layer);
    const segments = measurement.segments
      .map((segment, index) => ({
        ...segment,
        start: latLngs[index],
        end: latLngs[index + 1],
      }))
      .filter((segment) => segment.start && segment.end);
    measurementSegments = segments;

    if (isMeasurementSegmentMerged) {
      markers.push(...createGroupedSegmentMeasurementMarkers(segments));
    } else {
      segments.forEach((segment) => {
        markers.push(
          createMeasurementLabelMarker(
            getSegmentMidpoint(segment.start, segment.end),
            [formatDistance(segment.distance)],
          ),
        );
      });
    }

    const summaryLatLng = getShapeLabelLatLng(layer);
    if (summaryLatLng) {
      markers.push(
        createMeasurementLabelMarker(
          summaryLatLng,
          [`総延長 ${formatDistance(measurement.totalDistance)}`],
          "summary-polyline",
        ),
      );
    }
  } else if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
    const latLngs = trimClosedLatLngs(flattenShapeLatLngs(layer.getLatLngs()));
    const measurement = measurePolygon(layer);
    const segments = measurement.edges
      .map((edge, index) => ({
        ...edge,
        start: latLngs[index],
        end: latLngs[(index + 1) % latLngs.length],
      }))
      .filter((segment) => segment.start && segment.end);
    measurementSegments = segments;

    if (isMeasurementSegmentMerged) {
      markers.push(...createGroupedSegmentMeasurementMarkers(segments));
    } else {
      segments.forEach((segment) => {
        markers.push(
          createMeasurementLabelMarker(
            getSegmentMidpoint(segment.start, segment.end),
            [formatDistance(segment.distance)],
          ),
        );
      });
    }

    const summaryLatLng = getShapeLabelLatLng(layer);
    if (summaryLatLng) {
      const summaryVariant =
        layer.shapeType === "rectangle" ? "summary-rectangle" : "summary";
      markers.push(
        createMeasurementLabelMarker(
          summaryLatLng,
          [`面積 ${formatArea(measurement.area)}`],
          summaryVariant,
        ),
      );
    }
  } else if (layer.shapeType === "circle") {
    const measurement = measureCircle(layer);
    const centerLatLng = getShapeLabelLatLng(layer);
    if (centerLatLng) {
      markers.push(
        createMeasurementLabelMarker(
          centerLatLng,
          [
            `半径 ${formatDistance(measurement.radius)}`,
            `面積 ${formatArea(measurement.area)}`,
          ],
          "summary-circle",
        ),
      );
    }
  }

  if (isMeasurementSegmentMerged) {
    markers.push(
      ...createGroupedSegmentEndpointMarkers(measurementSegments, layer),
    );
  } else {
    getMeasurementVertexLatLngs(layer).forEach((latLng) => {
      markers.push(createMeasurementVertexMarker(latLng, layer));
    });
  }

  return markers.filter(Boolean);
}

// 計測ラベルを図形グループへ登録する
function attachShapeMeasurementMarkers(layer) {
  if (!layer) {
    return;
  }

  const markers = createShapeMeasurementMarkers(layer);
  if (markers.length === 0) {
    return;
  }

  layer.measurementMarkers = markers;
  markers.forEach((marker) => {
    if (isShapeVisibleForSearch(layer)) {
      drawnShapesGroup.addLayer(marker);
    }
    setMeasurementMarkerVisibility(marker, isMeasurementVisible);
  });
}

// 計測ラベルを図形グループから取り除く
function removeShapeMeasurementMarkers(layer) {
  if (!layer || !Array.isArray(layer.measurementMarkers)) {
    return;
  }

  layer.measurementMarkers.forEach((marker) => {
    drawnShapesGroup.removeLayer(marker);
  });
  layer.measurementMarkers = [];
}

// 辺結合の切り替えに合わせて図形の計測ラベルを再生成する
function refreshShapeMeasurementMarkers(layer) {
  if (!layer || !layer.shapeType || layer.isMeasurementLabel === true) {
    return;
  }

  removeShapeMeasurementMarkers(layer);
  attachShapeMeasurementMarkers(layer);
}

// 表示中の図形計測ラベルをまとめて再生成する
function refreshAllShapeMeasurementMarkers() {
  searchableShapeLayers.forEach((layer) => {
    refreshShapeMeasurementMarkers(layer);
  });
}

// 計測ラベルマーカーの表示状態を反映する
// 描画図形グループ内の計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToDrawnShapesGroup() {
  drawnShapesGroup.eachLayer((layer) => {
    if (layer?.isMeasurementLabel === true) {
      setMeasurementMarkerVisibility(layer, isMeasurementVisible);
    }
  });
}

// 図形ラベルへ現在の図形色を反映する
function applyShapeLabelStyle(layer) {
  const tooltip =
    typeof layer?.getTooltip === "function" ? layer.getTooltip() : null;
  const tooltipElement =
    tooltip && typeof tooltip.getElement === "function"
      ? tooltip.getElement()
      : null;
  if (!tooltipElement) {
    return;
  }

  const shapeColor = normalizeShapeColor(
    layer?.shapeStyle?.color,
    SHAPE_STYLE.color,
  );
  tooltipElement.style.borderColor = shapeColor;
  tooltipElement.style.color = shapeColor;
}

// 図形ラベルクリックで名前編集を開けるようイベントを付与する
function attachShapeNameTooltipClick(layer) {
  if (!layer) {
    return;
  }
  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  const tooltipElement =
    tooltip && typeof tooltip.getElement === "function"
      ? tooltip.getElement()
      : null;
  if (
    !tooltipElement ||
    tooltipElement.dataset.shapeNameClickBound === "true"
  ) {
    return;
  }

  tooltipElement.dataset.shapeNameClickBound = "true";
  const openEditorFromLabel = (event) => {
    L.DomEvent.stop(event);
    if (activeDrawMode) {
      return;
    }
    if (currentMapMode === "edit") {
      selectShapeForGeometryEdit(layer);
      return;
    }
    openShapeNameEditor(layer);
  };
  L.DomEvent.on(tooltipElement, "click", openEditorFromLabel);
  L.DomEvent.on(tooltipElement, "touchend", openEditorFromLabel);
}

// 図形名ラベルの見た目と保持データを同期する
function updateShapeNameLabel(layer, name) {
  if (!layer) {
    return;
  }

  const normalizedName = normalizeShapeName(name);
  layer.shapeName = normalizedName;
  if (!layer.options) {
    layer.options = {};
  }
  if (layer.options.shapeRecord) {
    layer.options.shapeRecord.name = normalizedName;
  }

  if (typeof layer.unbindTooltip === "function") {
    layer.unbindTooltip();
  }

  if (typeof layer.bindTooltip !== "function") {
    return;
  }

  const labelLatLng = getShapeLabelLatLng(layer);
  const labelClassName = normalizedName
    ? "shape-name-label"
    : "shape-name-label is-empty";
  const labelContent = normalizedName ? escapeHtml(normalizedName) : "&nbsp;";
  layer.bindTooltip(`<div class="${labelClassName}">${labelContent}</div>`, {
    interactive: true,
    permanent: true,
    direction: "center",
    className: "shape-name-tooltip",
  });

  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  if (tooltip && labelLatLng && typeof tooltip.setLatLng === "function") {
    tooltip.setLatLng(labelLatLng);
  }
  if (typeof layer.openTooltip === "function") {
    layer.openTooltip();
  }
  applyShapeLabelStyle(layer);

  setTimeout(() => {
    attachShapeNameTooltipClick(layer);
    applyShapeLabelStyle(layer);
  }, 0);
}

// 現在の map 表示対象レイヤ ID を取得する
function getCurrentShapeLayerId() {
  if (typeof layer !== "string") {
    return null;
  }

  const trimmedLayerId = layer.trim();
  if (
    !trimmedLayerId ||
    trimmedLayerId === "null" ||
    trimmedLayerId === "None"
  ) {
    return null;
  }

  return trimmedLayerId;
}

// 図形編集用に選択可能なレイヤ一覧を取得する
function getEditableShapeLayers() {
  return Object.values(layersFromAxum || {})
    .filter(
      (layerRecord) => layerRecord && layerRecord.id && layerRecord.layer_name,
    )
    .sort((left, right) => {
      if (left.is_master && !right.is_master) {
        return -1;
      }
      if (!left.is_master && right.is_master) {
        return 1;
      }
      return left.layer_name.localeCompare(right.layer_name, "ja");
    });
}

// 図形編集ポップアップの既定レイヤを決める
function getShapeEditorLayerId(targetLayer) {
  return (
    targetLayer?.layerId ||
    getCurrentShapeLayerId() ||
    getEditableShapeLayers()[0]?.id ||
    ""
  );
}

// レイヤ選択プルダウンの option 群を組み立てる
function buildShapeLayerOptions(selectedLayerId) {
  return getEditableShapeLayers()
    .map((layerRecord) => {
      const selected = layerRecord.id === selectedLayerId ? "selected" : "";
      const layerLabel = escapeHtml(
        layerRecord.layer_name || "名称未設定レイヤ",
      );
      return `<option value="${layerRecord.id}" ${selected}>${layerLabel}</option>`;
    })
    .join("");
}

function buildShapeLineTypeOptions(selectedLineType) {
  const normalizedLineType = normalizeShapeLineType(selectedLineType);
  return SHAPE_LINE_TYPE_OPTIONS.map((option) => {
    const selected = option.value === normalizedLineType ? "selected" : "";
    return `<option value="${option.value}" ${selected}>${option.label}</option>`;
  }).join("");
}

// 図形レイヤに保存用メタデータをまとめて関連付ける
function applyShapeRecord(layer, shapeRecord) {
  if (!layer) {
    return;
  }

  if (!layer.options) {
    layer.options = {};
  }

  layer.options.shapeRecord = {
    id: shapeRecord.id || null,
    layer_id: shapeRecord.layer_id || null,
    shape_type: shapeRecord.shape_type,
    name: normalizeShapeName(shapeRecord.name || ""),
    geojson: shapeRecord.geojson,
  };
  layer.shapeId = shapeRecord.id || null;
  layer.layerId = shapeRecord.layer_id || null;
  layer.shapeType = shapeRecord.shape_type;
  layer.shapeName = normalizeShapeName(shapeRecord.name || "");
  layer.shapeMemo = getShapeMemoFromGeoJson(shapeRecord.geojson);
  layer.shapeStyle = getShapeStyleFromGeoJson(
    shapeRecord.shape_type,
    shapeRecord.geojson,
  );
  layer.feature = shapeRecord.geojson;
  if (shapeRecord.id) {
    searchableShapeLayers.add(layer);
    renderVisibleShapes();
  }
}

function isShapeVisibleForSearch(layer) {
  return Boolean(
    layer &&
      !layer.isDeletedShape &&
      (!externalShapeFilterIdSet ||
        externalShapeFilterIdSet.has(String(layer.shapeId))) &&
      matchesShapeSearch(layer.options?.shapeRecord, localMarkerSearchQuery),
  );
}

function renderVisibleShapes() {
  searchableShapeLayers.forEach((layer) => {
    const isVisible = isShapeVisibleForSearch(layer);
    if (isVisible) {
      if (!drawnShapesGroup.hasLayer(layer)) {
        drawnShapesGroup.addLayer(layer);
      }
      if (Array.isArray(layer.measurementMarkers)) {
        layer.measurementMarkers.forEach((marker) => {
          if (!drawnShapesGroup.hasLayer(marker)) {
            drawnShapesGroup.addLayer(marker);
          }
          setMeasurementMarkerVisibility(marker, isMeasurementVisible);
        });
      }
      return;
    }

    drawnShapesGroup.removeLayer(layer);
    if (Array.isArray(layer.measurementMarkers)) {
      layer.measurementMarkers.forEach((marker) => {
        drawnShapesGroup.removeLayer(marker);
      });
    }
  });

  if (map && typeof map.closePopup === "function") {
    map.closePopup();
  }
}

// 図形名と所属レイヤの変更をバックエンドへ保存する
async function persistShapeMetadata(
  layer,
  nextName,
  nextLayerId,
  nextGeoJson,
  nextShapeType = null,
) {
  if (!layer?.shapeId) {
    throw new Error("shape update target missing");
  }

  const response = await fetchWithAuth(`/shape/${layer.shapeId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: nextName,
      layer_id: nextLayerId,
      shape_type: nextShapeType,
      geojson: nextGeoJson,
    }),
  });

  if (!response.ok) {
    throw new Error("shape update failed");
  }
}

// 指定図形のラベル位置に名前編集ポップアップを開く
function openShapeNameEditor(layer) {
  if (!layer || activeDrawMode || currentMapMode === "edit") {
    return;
  }

  const labelLatLng = getShapeLabelLatLng(layer);
  if (!labelLatLng) {
    return;
  }

  closeShapeNameEditor();
  editingShapeLayer = layer;
  const selectedLayerId = getShapeEditorLayerId(layer);
  const selectedLineType = getShapeLineTypeFromDashArray(
    layer.shapeStyle?.dashArray,
  );
  const selectedWeight = normalizeShapeWeight(layer.shapeStyle?.weight);

  // 図形の編集ポップアップ（カラーピッカーはブラウザ標準のカラーピッカーを呼び出して使用）
  const editorPopup = L.popup({
    autoClose: false,
    closeButton: false,
    closeOnClick: false,
    className: "shape-name-editor-popup",
    offset: [0, -6],
  })
    .setLatLng(labelLatLng)
    .setContent(
      `
            <div class="shape-name-editor">
                <div class="shape-name-editor-title">図形を編集</div>
                <input
                    type="text"
                    class="shape-name-editor-input"
                    id="shape-name-editor-input"
                    maxlength="80"
                    value="${escapeHtml(layer.shapeName || "")}"
                    placeholder="未入力でラベルを外す"
                />
                <select class="shape-name-editor-select" id="shape-layer-editor-select">
                    ${buildShapeLayerOptions(selectedLayerId)}
                </select>
                <div class="shape-name-editor-color-row">
                    <span class="shape-name-editor-color-label">色</span>
                    <input
                        type="color"
                        class="shape-name-editor-color-input"
                        id="shape-color-editor-input"
                        value="${escapeHtml(normalizeShapeColor(layer.shapeStyle?.color, SHAPE_STYLE.color))}"
                        aria-label="図形色"
                    />
                </div>
                <div class="shape-name-editor-line-type-row">
                    <label class="shape-name-editor-line-type-label" for="shape-line-type-editor-select">線種</label>
                    <select class="shape-name-editor-select" id="shape-line-type-editor-select" aria-label="図形の線種">
                        ${buildShapeLineTypeOptions(selectedLineType)}
                    </select>
                </div>
                <div class="shape-name-editor-weight-row">
                    <label class="shape-name-editor-weight-label" for="shape-weight-editor-input">太さ</label>
                    <input
                        type="range"
                        class="shape-name-editor-weight-input"
                        id="shape-weight-editor-input"
                        min="${SHAPE_WEIGHT_MIN}"
                        max="${SHAPE_WEIGHT_MAX}"
                        step="1"
                        value="${selectedWeight}"
                        aria-label="図形の線の太さ"
                        aria-valuetext="${selectedWeight}px"
                    />
                    <output class="shape-name-editor-weight-value" id="shape-weight-editor-value" for="shape-weight-editor-input">${selectedWeight}px</output>
                </div>
                <label class="shape-name-editor-memo-label" for="shape-memo-editor-input">メモ（Markdown）</label>
                <textarea
                    class="shape-name-editor-memo-input"
                    id="shape-memo-editor-input"
                    maxlength="${SHAPE_MEMO_MAX_LENGTH}"
                    placeholder="Markdownでメモを入力"
                    aria-label="図形のメモ"
                >${escapeHtml(layer.shapeMemo || "")}</textarea>
                <div class="shape-name-editor-actions">
                    <button type="button" class="shape-name-editor-button" id="shape-name-editor-cancel">キャンセル</button>
                    <button type="button" class="shape-name-editor-button" id="shape-name-editor-save">保存</button>
                </div>
            </div>
        `,
    )
    .addTo(map);

  editingShapePopup = editorPopup;

  setTimeout(() => {
    const input = document.getElementById("shape-name-editor-input");
    const layerSelect = document.getElementById("shape-layer-editor-select");
    const colorInput = document.getElementById("shape-color-editor-input");
    const lineTypeSelect = document.getElementById(
      "shape-line-type-editor-select",
    );
    const weightInput = document.getElementById("shape-weight-editor-input");
    const weightValue = document.getElementById("shape-weight-editor-value");
    const memoInput = document.getElementById("shape-memo-editor-input");
    const saveButton = document.getElementById("shape-name-editor-save");
    const cancelButton = document.getElementById("shape-name-editor-cancel");
    const popupElement =
      editingShapePopup && typeof editingShapePopup.getElement === "function"
        ? editingShapePopup.getElement()
        : null;
    if (
      !input ||
      !layerSelect ||
      !colorInput ||
      !lineTypeSelect ||
      !weightInput ||
      !weightValue ||
      !memoInput ||
      !saveButton ||
      !cancelButton ||
      editingShapeLayer !== layer
    ) {
      return;
    }

    if (popupElement) {
      L.DomEvent.disableClickPropagation(popupElement);
    }

    input.focus();
    input.select();

    const updateWeightValue = () => {
      const normalizedWeight = normalizeShapeWeight(weightInput.value);
      weightValue.value = `${normalizedWeight}px`;
      weightInput.setAttribute("aria-valuetext", `${normalizedWeight}px`);
    };
    weightInput.addEventListener("input", updateWeightValue);
    updateWeightValue();

    const submitEdit = async () => {
      const nextName = normalizeShapeName(input.value);
      const previousLayerId =
        layer.layerId || layer.options?.shapeRecord?.layer_id || null;
      const nextLayerId = layerSelect.value || getShapeEditorLayerId(layer);
      const nextShapeStyle = buildShapeStyleFromColor(
        layer.shapeType,
        colorInput.value,
        lineTypeSelect.value,
        weightInput.value,
      );
      const nextGeoJson = buildShapeGeoJson(
        layer,
        layer.shapeType,
        nextShapeStyle,
        memoInput.value,
      );
      try {
        await persistShapeMetadata(layer, nextName, nextLayerId, nextGeoJson);
        applyShapeRecord(layer, {
          id: layer.shapeId,
          layer_id: nextLayerId,
          shape_type: layer.shapeType,
          name: nextName,
          geojson: nextGeoJson,
        });
        updateShapeNameLabel(layer, nextName);
        setSelectedShapeColor(nextShapeStyle.color);
        applyShapeStyle(layer);
        refreshShapeMeasurementMarkers(layer);
        closeShapeNameEditor();
        if (previousLayerId !== nextLayerId) {
          callParentReload(nextLayerId);
        }
        if (!is_master && nextLayerId !== getCurrentShapeLayerId()) {
          removeShapeMeasurementMarkers(layer);
          drawnShapesGroup.removeLayer(layer);
          setDrawStatus("図形描画: 図形を別レイヤへ移動しました。");
          return;
        }

        setDrawStatus("図形描画: 図形情報を更新しました。");
      } catch (_error) {
        setDrawStatus("図形描画: 図形情報の更新に失敗しました。", true);
      }
    };

    saveButton.addEventListener("click", async () => {
      await submitEdit();
    });

    cancelButton.addEventListener("click", () => {
      closeShapeNameEditor();
      setDrawStatus("図形描画: 編集をキャンセルしました。");
    });

    input.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        await submitEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeShapeNameEditor();
        setDrawStatus("図形描画: 編集をキャンセルしました。");
      }
    });
  }, 0);
}

// 形状タイプと GeoJSON から Leaflet レイヤを生成する
// GeoJSON から描画用の図形レイヤを生成する
function createShapeLayer(shapeType, geojson, shapeName = "") {
  const shapeStyle = getShapeStyleFromGeoJson(shapeType, geojson);
  const shapeLayer = createLeafletShapeLayer(shapeType, geojson, shapeStyle);
  if (!shapeLayer) {
    return null;
  }

  applyShapeRecord(shapeLayer, {
    id: null,
    layer_id: null,
    shape_type: shapeType,
    name: shapeName,
    geojson,
  });
  shapeLayer.shapeStyle = shapeStyle;
  applyShapeStyle(shapeLayer, activeDrawMode === "delete");
  updateShapeNameLabel(shapeLayer, shapeName);
  return shapeLayer;
}

// テンプレートから受け取った図形一覧を配列として返す
function getSavedShapes() {
  if (Array.isArray(shapesFromAxum)) {
    return shapesFromAxum;
  }
  if (shapesFromAxum && typeof shapesFromAxum === "object") {
    return Object.values(shapesFromAxum);
  }
  return [];
}

// サーバーから渡された図形一覧を地図へ復元する
function restoreSavedShapes() {
  getSavedShapes().forEach((shape) => {
    const shapeStyle = getShapeStyleFromGeoJson(
      shape.shape_type,
      shape.geojson,
    );
    const shapeLayer = createLeafletShapeLayer(
      shape.shape_type,
      shape.geojson,
      shapeStyle,
    );
    if (!shapeLayer) {
      return;
    }

    applyShapeRecord(shapeLayer, {
      id: shape.id,
      layer_id: shape.layer_id,
      shape_type: shape.shape_type,
      name: shape.name || "",
      geojson: shape.geojson,
    });
    applyShapeStyle(shapeLayer);
    updateShapeNameLabel(shapeLayer, shape.name || "");
    attachShapeEvents(shapeLayer);
    drawnShapesGroup.addLayer(shapeLayer);
    attachShapeMeasurementMarkers(shapeLayer);
  });
}

// 現在表示中の図形ラベルへクリックイベントを再設定する
function bindVisibleShapeLabelEvents() {
  if (!map.hasLayer(drawnShapesGroup)) {
    return;
  }

  drawnShapesGroup.eachLayer((layer) => {
    if (typeof layer.openTooltip === "function") {
      layer.openTooltip();
    }
    attachShapeNameTooltipClick(layer);
  });
}

// 指定図形を削除し、Undo 用スタックへ退避する
async function deleteShape(layer) {
  if (!layer?.shapeId) {
    setDrawStatus("図形描画: 削除対象のIDがありません。", true);
    return false;
  }
  const shapeId = String(layer.shapeId);
  if (deletingShapeIds.has(shapeId) || deletedShapeIds.has(shapeId)) {
    return false;
  }
  deletingShapeIds.add(shapeId);
  if (layer.isDeletingShape || layer.isDeletedShape) {
    deletingShapeIds.delete(shapeId);
    return false;
  }
  layer.isDeletingShape = true;

  const deletedShape = {
    layerId: layer.layerId || layer.options?.shapeRecord?.layer_id || null,
    shapeType: layer.shapeType,
    name: layer.shapeName || "",
    geojson:
      layer.options?.shapeRecord?.geojson ||
      buildShapeGeoJson(
        layer,
        layer.shapeType,
        layer.shapeStyle || getDefaultShapeStyle(layer.shapeType),
      ),
  };

  let response;
  try {
    response = await fetchWithAuth(`/shape/${layer.shapeId}`, {
      method: "DELETE",
    });
  } catch (error) {
    layer.isDeletingShape = false;
    deletingShapeIds.delete(shapeId);
    throw error;
  }

  if (!response.ok) {
    layer.isDeletingShape = false;
    deletingShapeIds.delete(shapeId);
    throw new Error("shape delete failed");
  }

  layer.isDeletedShape = true;
  deletedShapeIds.add(shapeId);
  try {
    removeShapeMeasurementMarkers(layer);
    drawnShapesGroup.removeLayer(layer);
    searchableShapeLayers.delete(layer);
    refreshAllShapeMeasurementMarkers();
    applyMeasurementVisibilityToDrawnShapesGroup();
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
  } catch (error) {
    console.error("Shape deleted on server, but local cleanup failed:", error);
  } finally {
    layer.isDeletingShape = false;
    deletingShapeIds.delete(shapeId);
  }
  callParentReload();
  setDrawStatus("図形描画: 削除しました。");
  return true;
}

function getPointToSegmentDistance(point, segmentStart, segmentEnd) {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  if (dx === 0 && dy === 0) {
    return point.distanceTo(segmentStart);
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );

  return point.distanceTo(
    L.point(segmentStart.x + ratio * dx, segmentStart.y + ratio * dy),
  );
}

function isPointInProjectedPolygon(point, polygonPoints) {
  let isInside = false;
  for (
    let i = 0, j = polygonPoints.length - 1;
    i < polygonPoints.length;
    j = i++
  ) {
    const current = polygonPoints[i];
    const previous = polygonPoints[j];
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;
    if (intersects) {
      isInside = !isInside;
    }
  }
  return isInside;
}

function getProjectedSegmentDistance(point, latLngs, isClosed = false) {
  const projectedPoints = latLngs.map((latlng) =>
    map.latLngToLayerPoint(latlng),
  );
  if (projectedPoints.length === 0) {
    return Infinity;
  }
  if (projectedPoints.length === 1) {
    return point.distanceTo(projectedPoints[0]);
  }

  let minDistance = Infinity;
  for (let i = 1; i < projectedPoints.length; i += 1) {
    minDistance = Math.min(
      minDistance,
      getPointToSegmentDistance(
        point,
        projectedPoints[i - 1],
        projectedPoints[i],
      ),
    );
  }
  if (isClosed) {
    minDistance = Math.min(
      minDistance,
      getPointToSegmentDistance(
        point,
        projectedPoints[projectedPoints.length - 1],
        projectedPoints[0],
      ),
    );
  }
  return minDistance;
}

function getDeleteHitDistance(layer, latlng) {
  if (!layer || !latlng) {
    return Infinity;
  }

  const point = map.latLngToLayerPoint(latlng);
  if (layer.shapeType === "circle" && typeof layer.getLatLng === "function") {
    const centerPoint = map.latLngToLayerPoint(layer.getLatLng());
    const radius = Number(layer._radius);
    return Number.isFinite(radius) &&
      point.distanceTo(centerPoint) <= radius + DELETE_HIT_TOLERANCE_PX
      ? 0
      : Infinity;
  }

  const latLngs = flattenShapeLatLngs(layer.getLatLngs?.());
  if (latLngs.length === 0) {
    return Infinity;
  }

  if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
    const polygonLatLngs = trimClosedLatLngs(latLngs);
    const polygonPoints = polygonLatLngs.map((polygonLatLng) =>
      map.latLngToLayerPoint(polygonLatLng),
    );
    if (
      polygonPoints.length >= 3 &&
      isPointInProjectedPolygon(point, polygonPoints)
    ) {
      return 0;
    }
    return getProjectedSegmentDistance(point, polygonLatLngs, true);
  }

  return getProjectedSegmentDistance(point, latLngs, false);
}

function findDeleteHitShape(latlng) {
  let hitLayer = null;
  let hitDistance = DELETE_HIT_TOLERANCE_PX;

  drawnShapesGroup.eachLayer((layer) => {
    const distance = getDeleteHitDistance(layer, latlng);
    if (distance <= hitDistance) {
      hitLayer = layer;
      hitDistance = distance;
    }
  });

  return hitLayer;
}

function isShapeIdDeleted(layer) {
  return Boolean(layer?.shapeId && deletedShapeIds.has(String(layer.shapeId)));
}

async function deleteShapeAtLatLng(latlng) {
  const hitLayer = findDeleteHitShape(latlng);
  if (!hitLayer) {
    setDrawStatus("図形描画: 削除対象の図形をクリックしてください。", true);
    return;
  }

  try {
    const didDelete = await deleteShape(hitLayer);
    if (didDelete) {
      resetDrawingState("図形描画: 削除しました。");
    }
  } catch (_error) {
    if (isShapeIdDeleted(hitLayer)) {
      resetDrawingState("図形描画: 削除しました。");
      return;
    }
    setDrawStatus("図形描画: 削除に失敗しました。", true);
  }
}

// 図形座標の編集中に復元できるよう、Leaflet の座標配列を複製する
function cloneShapeLatLngs(latLngs) {
  if (Array.isArray(latLngs)) {
    return latLngs.map((value) => cloneShapeLatLngs(value));
  }
  if (latLngs && Number.isFinite(latLngs.lat) && Number.isFinite(latLngs.lng)) {
    return L.latLng(latLngs.lat, latLngs.lng, latLngs.alt);
  }
  return latLngs;
}

// 図形編集開始時の形状を保存用スナップショットとして取得する
function captureShapeGeometry(layer) {
  if (layer?.shapeType === "circle" && typeof layer.getLatLng === "function") {
    return {
      center: cloneShapeLatLngs(layer.getLatLng()),
      radius: layer.getRadius(),
    };
  }
  return {
    latLngs: cloneShapeLatLngs(layer?.getLatLngs?.() || []),
  };
}

// 保存失敗や編集キャンセル時に図形を元の位置へ戻す
function restoreShapeGeometry(layer, snapshot) {
  if (!layer || !snapshot) {
    return;
  }
  if (layer.shapeType === "circle" && snapshot.center) {
    layer.setLatLng(snapshot.center);
    if (Number.isFinite(snapshot.radius) && snapshot.radius > 0) {
      layer.setRadius(snapshot.radius);
    }
    return;
  }
  if (snapshot.latLngs && typeof layer.setLatLngs === "function") {
    layer.setLatLngs(cloneShapeLatLngs(snapshot.latLngs));
  }
}

// 図形の移動に合わせて名前ラベルと計測ラベルを更新する
function refreshShapeGeometryPresentation(layer) {
  const tooltip = layer?.getTooltip?.();
  const labelLatLng = getShapeLabelLatLng(layer);
  if (tooltip && labelLatLng && typeof tooltip.setLatLng === "function") {
    tooltip.setLatLng(labelLatLng);
  }
  refreshShapeMeasurementMarkers(layer);
}

// 選択図形の強調クラスを SVG パスへ付け外しする
function setShapeGeometrySelectedStyle(layer, isSelected) {
  const element = layer?.getElement?.();
  if (element) {
    element.classList.toggle("is-shape-geometry-selected", isSelected);
  }
}

// 編集ハンドルを保存中だけ操作不可にする
function setShapeGeometryHandlesEnabled(isEnabled) {
  shapeGeometryEditHandles.eachLayer((handle) => {
    if (!handle?.dragging) {
      return;
    }
    if (isEnabled) {
      handle.dragging.enable();
    } else {
      handle.dragging.disable();
    }
  });
}

// 円ドラッグ用の document イベントを解除し、地図操作を復元する
function releaseCircleShapeDragInteractions() {
  document.removeEventListener("mousemove", handleCircleShapeDragMove, true);
  document.removeEventListener("mouseup", handleCircleShapeDragEnd, true);
  document.removeEventListener("touchmove", handleCircleShapeDragMove, true);
  document.removeEventListener("touchend", handleCircleShapeDragEnd, true);
  document.removeEventListener("touchcancel", handleCircleShapeDragEnd, true);
  map.getContainer()?.classList.remove("is-shape-geometry-dragging");
  if (circleShapeDragState?.mapDraggingWasEnabled) {
    map.dragging.enable();
  }
}

// モード変更などで円ドラッグが中断された場合は開始位置へ戻す
function cancelActiveCircleShapeDrag() {
  if (!circleShapeDragState) {
    return;
  }
  const { layer, snapshot } = circleShapeDragState;
  restoreShapeGeometry(layer, snapshot);
  refreshShapeGeometryPresentation(layer);
  releaseCircleShapeDragInteractions();
  circleShapeDragState = null;
}

// 図形編集の選択状態と頂点ハンドルをすべて解除する
function clearShapeGeometryEditing() {
  cancelActiveCircleShapeDrag();
  closeShapeVertexDeletePopup();
  setShapeGeometrySelectedStyle(geometryEditingShapeLayer, false);
  geometryEditingShapeLayer = null;
  shapeGeometryEditHandles.clearLayers();
  if (map.hasLayer(shapeGeometryEditHandles)) {
    map.removeLayer(shapeGeometryEditHandles);
  }
}

// 編集後の GeoJSON を既存の図形更新 API へ保存する
async function persistShapeGeometryEdit(layer, snapshot, options = {}) {
  if (!layer?.shapeId || isShapeGeometrySaving) {
    return;
  }
  const nextShapeType = options.shapeType || layer.shapeType;
  const targetLayerId =
    layer.layerId ||
    layer.options?.shapeRecord?.layer_id ||
    getCurrentShapeLayerId();
  if (!targetLayerId) {
    restoreShapeGeometry(layer, snapshot);
    refreshShapeGeometryPresentation(layer);
    setDrawStatus("図形編集: 所属レイヤを取得できませんでした。", true);
    return;
  }

  isShapeGeometrySaving = true;
  closeShapeVertexDeletePopup();
  setShapeGeometryHandlesEnabled(false);
  try {
    const nextGeoJson = buildShapeGeoJson(
      layer,
      nextShapeType,
      layer.shapeStyle || getDefaultShapeStyle(nextShapeType),
    );
    await persistShapeMetadata(
      layer,
      normalizeShapeName(layer.shapeName || ""),
      targetLayerId,
      nextGeoJson,
      options.shapeType || null,
    );
    applyShapeRecord(layer, {
      id: layer.shapeId,
      layer_id: targetLayerId,
      shape_type: nextShapeType,
      name: layer.shapeName || "",
      geojson: nextGeoJson,
    });
    updateShapeNameLabel(layer, layer.shapeName || "");
    refreshShapeMeasurementMarkers(layer);
    setDrawStatus(options.successMessage || "図形編集: 位置を保存しました。");
  } catch (_error) {
    restoreShapeGeometry(layer, snapshot);
    updateShapeNameLabel(layer, layer.shapeName || "");
    refreshShapeMeasurementMarkers(layer);
    setDrawStatus("図形編集: 保存に失敗したため元の形状へ戻しました。", true);
  } finally {
    isShapeGeometrySaving = false;
    if (
      geometryEditingShapeLayer === layer &&
      (currentMapMode === "edit" || currentMapMode === "input") &&
      !activeDrawMode
    ) {
      rebuildShapeGeometryHandles(layer);
    }
  }
}

// 頂点ハンドルの現在位置を図形の頂点へ同期する
function syncShapeGeometryHandlePositions(layer, activeHandle = null) {
  const vertices = flattenShapeLatLngs(layer?.getLatLngs?.());
  shapeGeometryEditHandles.eachLayer((handle) => {
    if (handle === activeHandle) {
      return;
    }
    const vertex = vertices[handle.shapeVertexIndex];
    if (vertex) {
      handle.setLatLng(vertex);
    }
  });
}

// 頂点ハンドルのドラッグ位置を対象図形へ反映する
function applyShapeVertexDrag(layer, vertexIndex, nextLatLng, activeHandle) {
  const vertices = flattenShapeLatLngs(layer?.getLatLngs?.()).map((latLng) =>
    cloneShapeLatLngs(latLng),
  );
  if (!vertices[vertexIndex]) {
    return;
  }

  if (layer.shapeType === "rectangle" && vertices.length === 4) {
    const oppositeVertex =
      activeHandle?.shapeRectangleOppositeLatLng ||
      vertices[(vertexIndex + 2) % 4];
    const nextBounds = L.latLngBounds(oppositeVertex, nextLatLng);
    layer.setLatLngs([
      nextBounds.getSouthWest(),
      nextBounds.getNorthWest(),
      nextBounds.getNorthEast(),
      nextBounds.getSouthEast(),
    ]);
    syncShapeGeometryHandlePositions(layer, activeHandle);
  } else {
    vertices[vertexIndex] = nextLatLng;
    layer.setLatLngs(vertices);
  }
  refreshShapeGeometryPresentation(layer);
}

// 入力モードで指定された頂点を削除し、既存の図形更新 API へ保存する
async function deleteShapeVertex(layer, vertexIndex) {
  if (
    currentMapMode !== "input" ||
    geometryEditingShapeLayer !== layer ||
    activeDrawMode ||
    isShapeGeometrySaving
  ) {
    return false;
  }

  const rawVertices = flattenShapeLatLngs(layer?.getLatLngs?.());
  const vertices = (
    layer.shapeType === "polygon" || layer.shapeType === "rectangle"
      ? trimClosedLatLngs(rawVertices)
      : rawVertices
  ).map((latLng) => cloneShapeLatLngs(latLng));
  const minimumVertexCount = layer.shapeType === "polyline" ? 2 : 3;
  if (vertices.length <= minimumVertexCount) {
    setDrawStatus(
      layer.shapeType === "polyline"
        ? "図形編集: 折れ線は2頂点未満にできません。"
        : "図形編集: ポリゴンは3頂点未満にできません。",
      true,
      true,
    );
    return false;
  }

  if (!vertices[vertexIndex]) {
    return false;
  }

  const snapshot = captureShapeGeometry(layer);
  const shouldConvertRectangle = layer.shapeType === "rectangle";
  vertices.splice(vertexIndex, 1);
  layer.setLatLngs(vertices);
  rebuildShapeGeometryHandles(layer);
  refreshShapeGeometryPresentation(layer);
  setDrawStatus("図形編集: 頂点を保存しています。");

  await persistShapeGeometryEdit(layer, snapshot, {
    shapeType: shouldConvertRectangle ? "polygon" : layer.shapeType,
    successMessage: shouldConvertRectangle
      ? "図形編集: 頂点を削除し、矩形をポリゴンへ変換しました。"
      : "図形編集: 頂点を削除しました。",
  });
  return true;
}

// 入力モードの頂点位置に削除確認ポップアップを開く
function openShapeVertexDeletePopup(layer, handle, event) {
  if (
    currentMapMode !== "input" ||
    geometryEditingShapeLayer !== layer ||
    activeDrawMode ||
    isShapeGeometrySaving
  ) {
    return;
  }

  if (event?.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
  closeShapeNameEditor();
  closeShapeVertexDeletePopup();

  const vertexIndex = handle.shapeVertexIndex;
  const content = document.createElement("div");
  content.className = "shape-vertex-delete-confirm";

  const message = document.createElement("div");
  message.className = "shape-vertex-delete-confirm-message";
  message.textContent = "頂点を削除しますか？";

  const actions = document.createElement("div");
  actions.className = "shape-vertex-delete-confirm-actions";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "shape-vertex-delete-confirm-button";
  closeButton.textContent = "閉じる";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className =
    "shape-vertex-delete-confirm-button shape-vertex-delete-confirm-button--delete";
  deleteButton.textContent = "削除";

  actions.append(closeButton, deleteButton);
  content.append(message, actions);

  const popup = L.popup({
    className: "shape-vertex-delete-popup",
    closeButton: false,
    maxWidth: 220,
  })
    .setLatLng(handle.getLatLng())
    .setContent(content)
    .addTo(map);

  shapeVertexDeletePopup = popup;
  shapeVertexDeleteTarget = { layer, vertexIndex };
  popup.on("remove", () => {
    if (shapeVertexDeletePopup === popup) {
      shapeVertexDeletePopup = null;
      shapeVertexDeleteTarget = null;
    }
  });

  L.DomEvent.on(closeButton, "click", (buttonEvent) => {
    L.DomEvent.stop(buttonEvent);
    closeShapeVertexDeletePopup();
  });
  L.DomEvent.on(deleteButton, "click", (buttonEvent) => {
    suppressPropagatedMapClick({
      type: "click",
      originalEvent: buttonEvent,
    });
    L.DomEvent.stop(buttonEvent);
    if (
      shapeVertexDeleteTarget?.layer !== layer ||
      shapeVertexDeleteTarget?.vertexIndex !== vertexIndex
    ) {
      return;
    }
    closeShapeVertexDeletePopup();
    void deleteShapeVertex(layer, vertexIndex);
  });
}

// 選択図形の頂点へ表示用またはドラッグ可能なハンドルを配置する
function rebuildShapeGeometryHandles(layer) {
  closeShapeVertexDeletePopup();
  shapeGeometryEditHandles.clearLayers();
  const isVertexMoveMode = currentMapMode === "edit";
  const isVertexDisplayMode = currentMapMode === "input";
  if (
    !layer ||
    layer.shapeType === "circle" ||
    (!isVertexMoveMode && !isVertexDisplayMode) ||
    activeDrawMode ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return;
  }

  const rawVertices = flattenShapeLatLngs(layer.getLatLngs?.());
  const vertices =
    layer.shapeType === "polygon" || layer.shapeType === "rectangle"
      ? trimClosedLatLngs(rawVertices)
      : rawVertices;
  vertices.forEach((latLng, vertexIndex) => {
    const handle = L.marker(latLng, {
      draggable: isVertexMoveMode && !isShapeGeometrySaving,
      interactive: isVertexMoveMode || isVertexDisplayMode,
      keyboard: false,
      autoPan: isVertexMoveMode,
      icon: L.divIcon({
        className: isVertexMoveMode
          ? "shape-edit-vertex-icon"
          : "shape-edit-vertex-icon shape-vertex-display-icon",
        html: '<span class="shape-edit-vertex-handle" aria-hidden="true"></span>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    });
    handle.shapeVertexIndex = vertexIndex;
    if (isVertexDisplayMode) {
      handle.on("click", (event) => {
        if (event?.originalEvent) {
          L.DomEvent.stop(event.originalEvent);
        }
      });
      handle.on("contextmenu", (event) => {
        openShapeVertexDeletePopup(layer, handle, event);
      });
    }
    if (isVertexMoveMode) {
      handle.on("dragstart", () => {
        handle.shapeGeometrySnapshot = captureShapeGeometry(layer);
        if (layer.shapeType === "rectangle" && vertices.length === 4) {
          handle.shapeRectangleOppositeLatLng = cloneShapeLatLngs(
            vertices[(vertexIndex + 2) % 4],
          );
        }
        closeShapeNameEditor();
      });
      handle.on("drag", () => {
        applyShapeVertexDrag(layer, vertexIndex, handle.getLatLng(), handle);
      });
      handle.on("dragend", async () => {
        await persistShapeGeometryEdit(layer, handle.shapeGeometrySnapshot);
        handle.shapeGeometrySnapshot = null;
        handle.shapeRectangleOppositeLatLng = null;
      });
    }
    shapeGeometryEditHandles.addLayer(handle);
  });

  if (!map.hasLayer(shapeGeometryEditHandles)) {
    shapeGeometryEditHandles.addTo(map);
  }
}

// 移動モードでクリックされた図形を編集対象として選択する
function selectShapeForGeometryEdit(layer) {
  if (
    currentMapMode !== "edit" ||
    activeDrawMode ||
    isShapeGeometrySaving ||
    !layer?.shapeId ||
    layer.isMeasurementLabel === true ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return false;
  }

  closeShapeNameEditor();
  if (geometryEditingShapeLayer !== layer) {
    setShapeGeometrySelectedStyle(geometryEditingShapeLayer, false);
    geometryEditingShapeLayer = layer;
  }
  setShapeGeometrySelectedStyle(layer, true);
  if (typeof layer.bringToFront === "function") {
    layer.bringToFront();
  }
  rebuildShapeGeometryHandles(layer);
  setDrawStatus(
    layer.shapeType === "circle"
      ? "図形編集: 円をドラッグして移動できます。"
      : "図形編集: 頂点をドラッグして移動できます。",
  );
  return true;
}

// 入力モードで頂点追加対象の図形を選択し、現在の頂点を表示する
function activateShapeForVertexAdd(layer) {
  if (
    currentMapMode !== "input" ||
    activeDrawMode ||
    !canAddVertexToShape(layer) ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return false;
  }

  closeShapeNameEditor();
  if (geometryEditingShapeLayer !== layer) {
    setShapeGeometrySelectedStyle(geometryEditingShapeLayer, false);
    geometryEditingShapeLayer = layer;
  }
  setShapeGeometrySelectedStyle(layer, true);
  if (typeof layer.bringToFront === "function") {
    layer.bringToFront();
  }
  rebuildShapeGeometryHandles(layer);
  return true;
}

// DOM のマウス・タッチイベントから地図上の緯度経度を取得する
function getShapeDragEventLatLng(event) {
  const sourceEvent =
    event?.touches?.[0] || event?.changedTouches?.[0] || event;
  if (
    !Number.isFinite(sourceEvent?.clientX) ||
    !Number.isFinite(sourceEvent?.clientY)
  ) {
    return null;
  }
  const mapRect = map.getContainer().getBoundingClientRect();
  return map.containerPointToLatLng(
    L.point(
      sourceEvent.clientX - mapRect.left,
      sourceEvent.clientY - mapRect.top,
    ),
  );
}

// 円本体のドラッグを開始する
function startCircleShapeDrag(layer, leafletEvent) {
  if (
    layer?.shapeType !== "circle" ||
    currentMapMode !== "edit" ||
    activeDrawMode ||
    isShapeGeometrySaving ||
    circleShapeDragState
  ) {
    return;
  }
  if (!selectShapeForGeometryEdit(layer)) {
    return;
  }

  const originalEvent = leafletEvent?.originalEvent;
  const startPointerLatLng = getShapeDragEventLatLng(originalEvent);
  if (!startPointerLatLng) {
    return;
  }
  if (originalEvent) {
    L.DomEvent.stop(originalEvent);
    originalEvent.preventDefault?.();
  }

  const zoom = map.getZoom();
  circleShapeDragState = {
    layer,
    snapshot: captureShapeGeometry(layer),
    zoom,
    startCenterPoint: map.project(layer.getLatLng(), zoom),
    startPointerPoint: map.project(startPointerLatLng, zoom),
    mapDraggingWasEnabled: Boolean(map.dragging?.enabled?.()),
  };
  if (circleShapeDragState.mapDraggingWasEnabled) {
    map.dragging.disable();
  }
  map.getContainer()?.classList.add("is-shape-geometry-dragging");
  document.addEventListener("mousemove", handleCircleShapeDragMove, true);
  document.addEventListener("mouseup", handleCircleShapeDragEnd, true);
  document.addEventListener("touchmove", handleCircleShapeDragMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener("touchend", handleCircleShapeDragEnd, true);
  document.addEventListener("touchcancel", handleCircleShapeDragEnd, true);
}

// 円ドラッグ中のポインター移動量を中心座標へ反映する
function handleCircleShapeDragMove(event) {
  if (!circleShapeDragState) {
    return;
  }
  const pointerLatLng = getShapeDragEventLatLng(event);
  if (!pointerLatLng) {
    return;
  }
  event.preventDefault?.();
  const currentPointerPoint = map.project(
    pointerLatLng,
    circleShapeDragState.zoom,
  );
  const pointerOffset = currentPointerPoint.subtract(
    circleShapeDragState.startPointerPoint,
  );
  const nextCenter = map.unproject(
    circleShapeDragState.startCenterPoint.add(pointerOffset),
    circleShapeDragState.zoom,
  );
  circleShapeDragState.layer.setLatLng(nextCenter);
  refreshShapeGeometryPresentation(circleShapeDragState.layer);
}

// 円ドラッグ終了時に操作を解除して変更後の位置を保存する
async function handleCircleShapeDragEnd(event) {
  if (!circleShapeDragState) {
    return;
  }
  event?.preventDefault?.();
  const completedDrag = circleShapeDragState;
  releaseCircleShapeDragInteractions();
  circleShapeDragState = null;
  await persistShapeGeometryEdit(completedDrag.layer, completedDrag.snapshot);
}

// 入力モードで頂点追加できる図形種別か判定する
function canAddVertexToShape(layer) {
  return Boolean(
    layer?.shapeId &&
      layer.isMeasurementLabel !== true &&
      ["polygon", "polyline", "rectangle"].includes(layer.shapeType),
  );
}

// クリック位置から線分上の最近傍点を画面座標で求める
function getClosestPointOnShapeSegment(targetPoint, startPoint, endPoint) {
  const segmentX = endPoint.x - startPoint.x;
  const segmentY = endPoint.y - startPoint.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared === 0) {
    return startPoint;
  }

  const targetX = targetPoint.x - startPoint.x;
  const targetY = targetPoint.y - startPoint.y;
  const ratio = Math.max(
    0,
    Math.min(
      1,
      (targetX * segmentX + targetY * segmentY) / segmentLengthSquared,
    ),
  );
  return L.point(
    startPoint.x + segmentX * ratio,
    startPoint.y + segmentY * ratio,
  );
}

// 図形の全辺からクリック位置に最も近い辺と挿入座標を取得する
function findShapeVertexInsertion(layer, targetLatLng) {
  if (!canAddVertexToShape(layer) || !targetLatLng) {
    return null;
  }

  const vertices = flattenShapeLatLngs(layer.getLatLngs?.());
  if (vertices.length < 2) {
    return null;
  }

  const isClosedShape =
    layer.shapeType === "polygon" || layer.shapeType === "rectangle";
  const segmentCount = isClosedShape ? vertices.length : vertices.length - 1;
  const targetPoint = map.latLngToLayerPoint(targetLatLng);
  let closestMatch = null;

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const nextVertexIndex = (segmentIndex + 1) % vertices.length;
    const startPoint = map.latLngToLayerPoint(vertices[segmentIndex]);
    const endPoint = map.latLngToLayerPoint(vertices[nextVertexIndex]);
    const closestPoint = getClosestPointOnShapeSegment(
      targetPoint,
      startPoint,
      endPoint,
    );
    const distancePx = targetPoint.distanceTo(closestPoint);
    if (!closestMatch || distancePx < closestMatch.distancePx) {
      closestMatch = {
        distancePx,
        insertionIndex: segmentIndex + 1,
        latLng: map.layerPointToLatLng(closestPoint),
      };
    }
  }

  if (
    !closestMatch ||
    closestMatch.distancePx > SHAPE_VERTEX_ADD_TOLERANCE_PX
  ) {
    return null;
  }

  const closestPoint = map.latLngToLayerPoint(closestMatch.latLng);
  closestMatch.existingVertexDistancePx = vertices.reduce(
    (minimumDistance, vertex) =>
      Math.min(
        minimumDistance,
        closestPoint.distanceTo(map.latLngToLayerPoint(vertex)),
      ),
    Number.POSITIVE_INFINITY,
  );
  return closestMatch;
}

// 頂点追加・図形選択に使用したイベントをマーカー追加へ伝播させない
function consumeShapeVertexAddEvent(event) {
  if (event?.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
  if (event?.type === "touchend") {
    suppressNextMapClick();
  } else {
    suppressMapClickUntil = 0;
  }
  closeShapeNameEditor();
}

// 入力モードの最初の操作では図形の選択と頂点表示だけを行う
function activateShapeForVertexAddFromEvent(
  layer,
  event,
  shouldSuppressPropagatedMapClick = false,
) {
  if (shouldSuppressPropagatedMapClick) {
    suppressPropagatedMapClick(event);
  }
  consumeShapeVertexAddEvent(event);
  if (isShapeGeometrySaving) {
    setDrawStatus(
      "図形編集: 保存中です。少し待ってから図形を選択してください。",
      true,
    );
    return true;
  }
  if (!activateShapeForVertexAdd(layer)) {
    return false;
  }
  setDrawStatus(
    "図形編集: 図形を選択しました。頂点を追加する辺をクリックしてください。",
  );
  return true;
}

// 入力モードで図形の辺をクリックした位置へ新しい頂点を追加する
function tryAddShapeVertex(layer, event, knownInsertion = null) {
  if (
    currentMapMode !== "input" ||
    activeDrawMode ||
    !canAddVertexToShape(layer)
  ) {
    return false;
  }

  const insertion =
    knownInsertion || findShapeVertexInsertion(layer, event?.latlng);
  if (!insertion) {
    return false;
  }

  consumeShapeVertexAddEvent(event);

  if (isShapeGeometrySaving) {
    setDrawStatus(
      "図形編集: 保存中です。少し待ってから追加してください。",
      true,
    );
    return true;
  }

  activateShapeForVertexAdd(layer);
  if (insertion.existingVertexDistancePx < SHAPE_VERTEX_MIN_DISTANCE_PX) {
    setDrawStatus("図形編集: 既存の頂点に近すぎるため追加できません。", true);
    return true;
  }

  const snapshot = captureShapeGeometry(layer);
  const vertices = flattenShapeLatLngs(layer.getLatLngs?.()).map((latLng) =>
    cloneShapeLatLngs(latLng),
  );
  vertices.splice(insertion.insertionIndex, 0, insertion.latLng);
  layer.setLatLngs(vertices);
  rebuildShapeGeometryHandles(layer);
  refreshShapeGeometryPresentation(layer);
  setDrawStatus("図形編集: 頂点を保存しています。");

  void persistShapeGeometryEdit(layer, snapshot, {
    shapeType: layer.shapeType === "rectangle" ? "polygon" : layer.shapeType,
    successMessage:
      layer.shapeType === "rectangle"
        ? "図形編集: 頂点を追加し、矩形をポリゴンへ変換しました。"
        : "図形編集: 頂点を追加しました。",
  });
  return true;
}

// 入力モードのクリック位置に最も近い図形の辺へ頂点を追加する
function tryAddShapeVertexAtLatLng(event) {
  if (
    currentMapMode !== "input" ||
    activeDrawMode ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return false;
  }

  let closestTarget = null;
  drawnShapesGroup.eachLayer((layer) => {
    const insertion = findShapeVertexInsertion(layer, event?.latlng);
    if (
      insertion &&
      (!closestTarget ||
        insertion.distancePx < closestTarget.insertion.distancePx)
    ) {
      closestTarget = { layer, insertion };
    }
  });

  if (!closestTarget) {
    return false;
  }
  if (geometryEditingShapeLayer !== closestTarget.layer) {
    return activateShapeForVertexAddFromEvent(closestTarget.layer, event);
  }
  return tryAddShapeVertex(closestTarget.layer, event, closestTarget.insertion);
}

// 入力モードで頂点追加できる図形へカーソル用クラスを反映する
function updateShapeVertexAddTargetStyles() {
  drawnShapesGroup.eachLayer((layer) => {
    const element = layer?.getElement?.();
    if (!element) {
      return;
    }
    element.classList.toggle(
      "is-shape-vertex-add-target",
      currentMapMode === "input" && canAddVertexToShape(layer),
    );
  });
}

// 閲覧・入力・移動モードに合わせて図形編集状態を切り替える
function setShapeGeometryEditingMode(mode) {
  currentMapMode = mode;
  map.getContainer()?.classList.toggle("is-shape-edit-mode", mode === "edit");
  clearShapeGeometryEditing();
  updateShapeVertexAddTargetStyles();
}

// 図形クリック時の削除や編集開始に必要なイベントを付与する
function attachShapeEvents(layer) {
  const handleDeleteEvent = async function (
    event,
    shouldSuppressClick = false,
  ) {
    if (activeDrawMode === "delete") {
      if (event.originalEvent) {
        L.DomEvent.stop(event.originalEvent);
      }
      if (shouldSuppressClick) {
        suppressNextMapClick();
      }

      try {
        const didDelete = await deleteShape(layer);
        if (didDelete) {
          resetDrawingState("図形描画: 削除しました。");
        }
      } catch (_error) {
        if (isShapeIdDeleted(layer)) {
          resetDrawingState("図形描画: 削除しました。");
          return;
        }
        setDrawStatus("図形描画: 削除に失敗しました。", true);
      }
      return;
    }

    if (activeDrawMode) {
      return;
    }

    if (currentMapMode === "input" && canAddVertexToShape(layer)) {
      if (geometryEditingShapeLayer !== layer) {
        activateShapeForVertexAddFromEvent(layer, event, true);
        return;
      }
      if (
        event.type === "click" &&
        !findShapeVertexInsertion(layer, event?.latlng)
      ) {
        consumeShapeVertexAddEvent(event);
        setDrawStatus(
          "図形編集: 頂点を追加する場合は選択中の図形の辺をクリックしてください。",
          true,
        );
        return;
      }
    }

    if (currentMapMode === "edit") {
      if (event.originalEvent) {
        L.DomEvent.stop(event.originalEvent);
      }
      if (shouldSuppressClick) {
        suppressNextMapClick();
      }
      selectShapeForGeometryEdit(layer);
      return;
    }

    if (currentMapMode === "view") {
      openShapeMemoPopup(layer, event?.latlng);
    }
  };

  layer.on("click", async function (event) {
    await handleDeleteEvent(event);
  });

  layer.on("touchend", async function (event) {
    await handleDeleteEvent(event, true);
  });
  layer.on("add", updateShapeVertexAddTargetStyles);

  if (layer.shapeType === "circle") {
    layer.on("mousedown", function (event) {
      startCircleShapeDrag(layer, event);
    });
    layer.on("touchstart", function (event) {
      startCircleShapeDrag(layer, event);
    });
  }
}

// 図形を現在レイヤへ保存し、保存後の情報をレイヤへ反映する
async function saveShape(
  shapeType,
  layer,
  shapeName = "",
  forcedLayerId = null,
) {
  const targetLayerId = forcedLayerId || getCurrentShapeLayerId();
  if (!targetLayerId) {
    throw new Error("shape layer missing");
  }
  const nextShapeStyle =
    layer.shapeStyle ||
    buildShapeStyleFromColor(shapeType, getSelectedShapeColor());
  const nextGeoJson = buildShapeGeoJson(layer, shapeType, nextShapeStyle);

  const response = await fetchWithAuth("/shape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      layer_id: targetLayerId,
      shape_type: shapeType,
      name: shapeName,
      geojson: nextGeoJson,
    }),
  });

  if (!response.ok) {
    throw new Error("shape save failed");
  }

  const data = await response.json();
  applyShapeRecord(layer, {
    id: data.id,
    layer_id: targetLayerId,
    shape_type: shapeType,
    name: shapeName,
    geojson: nextGeoJson,
  });
  applyShapeStyle(layer, activeDrawMode === "delete");
  updateShapeNameLabel(layer, shapeName);
  attachShapeEvents(layer);
  drawnShapesGroup.addLayer(layer);
  attachShapeMeasurementMarkers(layer);
  renderVisibleShapes();
  if (!map.hasLayer(drawnShapesGroup)) {
    drawnShapesGroup.addTo(map);
  }
  applyMeasurementVisibilityToDrawnShapesGroup();
  setDrawStatus("図形描画: 保存しました。");
}

// 直前に削除した図形を同じレイヤへ再作成する
async function undoDeletedShape() {
  if (deletedShapesStack.length === 0) {
    setDrawStatus("図形描画: 元に戻せる図形はありません。", true);
    return;
  }

  const deletedShape = deletedShapesStack.pop();
  updateUndoButtonState();

  const restoredLayer = createShapeLayer(
    deletedShape.shapeType,
    deletedShape.geojson,
    deletedShape.name || "",
  );
  if (!restoredLayer) {
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
    setDrawStatus("図形描画: 図形の復元に失敗しました。", true);
    return;
  }

  try {
    await saveShape(
      deletedShape.shapeType,
      restoredLayer,
      deletedShape.name || "",
      deletedShape.layerId,
    );
    setDrawStatus("図形描画: 削除した図形を復元しました。");
  } catch (_error) {
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
    setDrawStatus("図形描画: 復元に失敗しました。", true);
  }
}

// 折れ線またはポリゴンの描画を確定して保存する
async function completeLineOrPolygon() {
  const shapeName = getShapeNameInputValue();
  if (activeDrawMode === "polyline") {
    if (drawPoints.length < 2) {
      setDrawStatus("図形描画: 線は2点以上必要です。", true);
      return;
    }
    const shapeLayer = L.polyline(drawPoints, SHAPE_STYLE);
    shapeLayer.shapeStyle = buildShapeStyleFromColor(
      "polyline",
      getSelectedShapeColor(),
    );
    try {
      await saveShape("polyline", shapeLayer, shapeName);
      clearShapeNameInput();
      resetDrawingState("図形描画: オフ");
    } catch (_error) {
      resetDrawingState("図形描画: 保存に失敗しました。", true);
    }
    return;
  }

  if (activeDrawMode === "polygon") {
    if (drawPoints.length < 3) {
      setDrawStatus("図形描画: 面は3点以上必要です。", true);
      return;
    }
    const shapeLayer = L.polygon(drawPoints, SHAPE_STYLE);
    shapeLayer.shapeStyle = buildShapeStyleFromColor(
      "polygon",
      getSelectedShapeColor(),
    );
    try {
      await saveShape("polygon", shapeLayer, shapeName);
      clearShapeNameInput();
      resetDrawingState("図形描画: オフ");
    } catch (_error) {
      resetDrawingState("図形描画: 保存に失敗しました。", true);
    }
  }
}

// 現在の描画モードに応じて「完了」と同じ処理を実行する
async function completeActiveDrawing() {
  if (isCompletingActiveDrawing) {
    return;
  }
  if (activeDrawMode === "rectangle" || activeDrawMode === "circle") {
    const shapeLabel = activeDrawMode === "circle" ? "円" : "矩形";
    setDrawStatus(
      `図形描画: ${shapeLabel}は2点目をタップすると保存されます。`,
      true,
    );
    return;
  }
  if (activeDrawMode === "delete") {
    setDrawStatus("図形描画: 削除モードでは図形をタップしてください。", true);
    return;
  }
  if (!activeDrawMode) {
    setDrawStatus("図形描画: モードを選択してください。", true);
    return;
  }
  isCompletingActiveDrawing = true;
  try {
    await completeLineOrPolygon();
  } finally {
    isCompletingActiveDrawing = false;
  }
}

// 円の描画を確定して保存する
function completeCircleDrawing(targetLatLng) {
  if (!circleStartLatLng) {
    setDrawStatus("図形描画: 円の中心をタップしてください。", true);
    return;
  }

  const radius = map.distance(circleStartLatLng, targetLatLng);
  if (!(radius > 0)) {
    setDrawStatus(
      "図形描画: 半径が0より大きくなる位置をタップしてください。",
      true,
    );
    return;
  }

  closeShapeNameEditor();
  clearDrawPreview();
  const circle = L.circle(circleStartLatLng, {
    ...SHAPE_STYLE,
    radius,
  });
  circle.shapeStyle = buildShapeStyleFromColor(
    "circle",
    getSelectedShapeColor(),
  );

  saveShape("circle", circle, getShapeNameInputValue())
    .then(() => {
      clearShapeNameInput();
      resetDrawingState("図形描画: オフ");
    })
    .catch(() => {
      resetDrawingState("図形描画: 保存に失敗しました。", true);
    });
}

// ポップアップを開く関数
// 指定 ID のマーカーポップアップを開く

// サーバーに新しい座標とIDを送信してデータを更新する関数
// マーカー移動後の座標をサーバーへ反映する
function updateServer(id, lat, lng) {
  let url = `/marker/update-marker-latlng?marker_id=${id}&latitude=${lat}&longitude=${lng}`;
  // ラジオボタンの状態を確認
  let isEditMode = document.getElementById("editMode").checked;
  // 編集モードでなければは何もしない
  if (!isEditMode) {
    return;
  }

  fetchWithAuth(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json();
    })
    .then((data) => {
      // 必要に応じて、サーバーからのレスポンスを処理する
    })
    .catch((error) => {
      console.log(
        "There was a problem with the fetch operation:",
        error.message,
      );
    });
}

function handleShapeDrawLatLng(latlng) {
  if (activeDrawMode === "rectangle") {
    if (!rectangleStartLatLng) {
      rectangleStartLatLng = latlng;
      setDrawStatus("図形描画: 矩形の2点目をタップしてください。");
      return true;
    }

    closeShapeNameEditor();
    clearDrawPreview();
    const rectangle = L.rectangle(
      L.latLngBounds(rectangleStartLatLng, latlng),
      SHAPE_STYLE,
    );
    rectangle.shapeStyle = buildShapeStyleFromColor(
      "rectangle",
      getSelectedShapeColor(),
    );

    saveShape("rectangle", rectangle, getShapeNameInputValue())
      .then(() => {
        clearShapeNameInput();
        resetDrawingState("図形描画: オフ");
      })
      .catch(() => {
        resetDrawingState("図形描画: 保存に失敗しました。", true);
      });
    return true;
  }

  if (activeDrawMode === "circle") {
    if (!circleStartLatLng) {
      circleStartLatLng = latlng;
      setDrawStatus("図形描画: 円周上の点をタップしてください。");
      return true;
    }

    completeCircleDrawing(latlng);
    return true;
  }

  if (activeDrawMode === "polyline" || activeDrawMode === "polygon") {
    closeShapeNameEditor();
    drawPoints.push(latlng);
    setDrawStatus(`図形描画: ${drawPoints.length} 点を追加しました。`);
    return true;
  }

  if (activeDrawMode === "delete") {
    return true;
  }

  return false;
}

// 地図クリック時にサーバーに情報を送信しマーカー描画
map.on("click", async function (e) {
  if (isPropagatedMapClickSuppressed(e)) {
    return;
  }

  if (isMapClickSuppressed()) {
    return;
  }

  if (activeDrawMode === "delete") {
    await deleteShapeAtLatLng(e.latlng);
    return;
  }

  if (handleShapeDrawLatLng(e.latlng)) {
    return;
  }

  if (tryAddShapeVertexAtLatLng(e)) {
    return;
  }

  // ラジオボタンの状態を確認
  let isInputMode = document.getElementById("inputMode").checked;
  // 閲覧モードの場合は何もしない
  if (!isInputMode) {
    return;
  }

  // fetchを使用してサーバーにPOSTリクエストを送る
  let url = `/marker?layer_id=${layer}&latitude=${e.latlng.lat}&longitude=${e.latlng.lng}`;
  // fetchを使用してサーバーにPOSTリクエストを送る
  fetchWithAuth(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json(); // 必要に応じて JSON 形式でレスポンスを受け取る
    })
    .then((data) => {
      // サーバーからid, 緯度, 経度を受け取りマーカーとして描画
      var marker = L.marker(
        e.latlng,
        markerOptionsForLayer(layer, layersFromAxum, { draggable: false }),
      )
        .addTo(markersClusterGroup)
        .on("dragend", function (event) {
          var movedMarker = event.target;
          var position = movedMarker.getLatLng();
          updateServer(movedMarker.id, position.lat, position.lng);
        });
      const markerKey = `marker-${data["id"]}`;
      marker.id = data["id"];
      const markerElement = marker.getElement();
      if (markerElement) {
        markerElement.id = markerKey;
      }
      markers[markerKey] = marker;
      markersFromAxum[data["id"]] = {
        id: data["id"],
        layer_id: layer,
        marker_name: "",
        latitude: e.latlng.lat,
        longitude: e.latlng.lng,
        detail: "",
      };

      // 再描画用の管理データへ登録してから、親画面の一覧を更新する
      callParentReload();
    })
    .catch((error) => {
      console.log(
        "There was a problem with the fetch operation:",
        error.message,
      );
    });
});

// モバイル操作に合わせて描画プレビューを更新する
function updateDrawPreviewForLatLng(latlng) {
  if (!activeDrawMode || !latlng) {
    return;
  }

  if (activeDrawMode === "rectangle") {
    if (!rectangleStartLatLng) {
      return;
    }
    updateExistingPreviewLayer("rectangle", [latlng]);
    return;
  }

  if (activeDrawMode === "circle") {
    if (!circleStartLatLng) {
      return;
    }
    updateExistingPreviewLayer("circle", [latlng]);
    return;
  }

  if (activeDrawMode === "delete" || drawPoints.length === 0) {
    return;
  }

  const previewLatLngs = [...drawPoints, latlng];
  updateExistingPreviewLayer(activeDrawMode, previewLatLngs);
}

map.on("mousemove", function (e) {
  updateDrawPreviewForLatLng(e.latlng);
});

map.on("touchmove", function (e) {
  if (!activeDrawMode) {
    return;
  }
  if (e.originalEvent) {
    L.DomEvent.preventDefault(e.originalEvent);
  }
  updateDrawPreviewForLatLng(getLatLngFromTouchEvent(e));
});

map.on("touchend", async function (e) {
  if (!activeDrawMode || isTouchEndSuppressed()) {
    return;
  }
  const latlng = getLatLngFromTouchEvent(e);
  if (!latlng) {
    return;
  }
  if (e.originalEvent) {
    L.DomEvent.stop(e.originalEvent);
  }
  suppressNextMapClick();
  if (activeDrawMode === "delete") {
    await deleteShapeAtLatLng(latlng);
    return;
  }
  handleShapeDrawLatLng(latlng);
});

document.addEventListener("keydown", async (event) => {
  if (event.key !== "Escape" || event.isComposing || !activeDrawMode) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  await completeActiveDrawing();
});

function installPenPointerDrawingHandlers() {
  if (!window.PointerEvent) {
    return;
  }

  const mapContainer = map.getContainer();
  if (!mapContainer) {
    return;
  }

  mapContainer.addEventListener(
    "pointerdown",
    (event) => {
      if (!isPenPointerEvent(event) || !isPenOptimizedDrawMode()) {
        return;
      }
      activePenPointerId = event.pointerId;
      mapContainer.setPointerCapture?.(event.pointerId);
      suppressNextMapClick();
      suppressNextTouchEnd();
      stopNativeDrawingEvent(event);
    },
    true,
  );

  mapContainer.addEventListener(
    "pointermove",
    (event) => {
      if (!isPenPointerEvent(event) || !isPenOptimizedDrawMode()) {
        return;
      }
      if (
        activePenPointerId !== null &&
        event.pointerId !== activePenPointerId
      ) {
        return;
      }
      const latlng = getLatLngFromPointerEvent(event);
      if (!latlng) {
        return;
      }
      suppressNextMapClick();
      suppressNextTouchEnd();
      stopNativeDrawingEvent(event);
      updateDrawPreviewForLatLng(latlng);
    },
    true,
  );

  mapContainer.addEventListener(
    "pointerup",
    (event) => {
      if (!isPenPointerEvent(event) || !isPenOptimizedDrawMode()) {
        activePenPointerId = null;
        return;
      }
      if (
        activePenPointerId !== null &&
        event.pointerId !== activePenPointerId
      ) {
        return;
      }
      const latlng = getLatLngFromPointerEvent(event);
      activePenPointerId = null;
      mapContainer.releasePointerCapture?.(event.pointerId);
      if (!latlng) {
        return;
      }
      suppressNextMapClick();
      suppressNextTouchEnd();
      stopNativeDrawingEvent(event);
      handleShapeDrawLatLng(latlng);
    },
    true,
  );

  mapContainer.addEventListener(
    "pointercancel",
    (event) => {
      if (isPenPointerEvent(event) && event.pointerId === activePenPointerId) {
        activePenPointerId = null;
        mapContainer.releasePointerCapture?.(event.pointerId);
      }
    },
    true,
  );
}

installPenPointerDrawingHandlers();

// モードの説明を切り替える関数
// 閲覧・入力・移動モードに応じて UI とドラッグ可否を切り替える
function handleRadioChange(event) {
  const mode = event.target.value;
  setShapeGeometryEditingMode(mode);
  // 左下のコンテナを取得または作成
  let modeDescriptionContainer = document.getElementById("mode-description");
  if (!modeDescriptionContainer) {
    modeDescriptionContainer = document.createElement("div");
    modeDescriptionContainer.id = "mode-description";
    modeDescriptionContainer.style.position = "absolute";
    modeDescriptionContainer.style.left = "10px";
    modeDescriptionContainer.style.padding = "10px";
    modeDescriptionContainer.style.backgroundColor = "rgba(255, 255, 255, 0.7)";
    document.body.appendChild(modeDescriptionContainer);
  }

  // モードに応じた説明の設定とマーカードラッグの有効化・無効化切り替え
  if (mode === "view") {
    console.log("View Mode Changed.");
    modeDescriptionContainer.innerHTML =
      "閲覧モード: 現在のモードは閲覧のみ可能です。";
    // クラスタ内の全てのマーカーに対してドラッグを無効にする
    markersClusterGroup.eachLayer(function (marker) {
      if (marker.dragging) {
        // marker.dragging が存在するか確認
        marker.dragging.disable();
      }
    });
  } else if (mode === "input") {
    console.log("Input Mode Changed.");
    modeDescriptionContainer.innerHTML =
      "入力モード: マーカーの追加と図形への頂点追加が可能です。";
    markersClusterGroup.eachLayer(function (marker) {
      if (marker.dragging) {
        // marker.dragging が存在するか確認
        marker.dragging.disable();
      }
    });
  } else if (mode === "edit") {
    console.log("Edit Mode Changed.");
    modeDescriptionContainer.innerHTML =
      "移動モード: マーカーの移動と図形の頂点・円の移動が可能です。";
    // クラスタ内の全てのマーカーに対してドラッグを有効にする
    markersClusterGroup.eachLayer(function (marker) {
      if (marker.dragging) {
        // marker.dragging が存在するか確認
        marker.dragging.enable();
      }
    });
  }
}

// ツールチップの制御
const TooltipVisibleControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");

    // ラジオボタンのHTMLを動的に生成
    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.innerHTML = "マーカー名表示";

    // ボタンのクリックイベント
    L.DomEvent.on(button, "click", function (e) {
      L.DomEvent.stop(e);
      // ここにカスタム機能を実装
      toggleTooltips();
    });

    // Leafletのクリックイベントとの干渉を避ける
    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

// 地図にタイルコントロールを追加
const tooltipVisibleControl = new TooltipVisibleControl();
map.addControl(tooltipVisibleControl);

// ツールチップの表示・非表示を管理する
let isTooltipVisible = false;

// ツールチップの表示非表示を切り替える関数
// マーカー名ツールチップの一括表示を切り替える
// 計測ラベルの表示非表示を切り替える関数
function toggleMeasurementLabels() {
  isMeasurementVisible = !isMeasurementVisible;
  applyMeasurementVisibilityToDrawnShapesGroup();
  updateMeasurementControlState();
}

// 計測コントロールの表示状態を反映する
// 辺を結合する表示へ切り替える
// 緯度経度入力から対象地点へフォーカスする
// 座標の入力値検査（緯度経度が妥当な数値範囲かを判定する）
// 地図に検索コントロールを追加
const codeSearchControl = createCodeSearchControl();
map.addControl(codeSearchControl);
registerHideableMapControl(codeSearchControl);
const markerSearchControl = createFlatMarkerSearchControl({
  onSearch: applyLocalMarkerSearch,
});
map.addControl(markerSearchControl);

// 現在位置コントロールは共通処理内で追加されるため、追加前後の差分から登録する
const controlsBeforeUserLocation = getMapControlContainersSnapshot();
const userLocationLayer = initializeUserLocation(map);
registerNewHideableMapControlContainers(controlsBeforeUserLocation);
if (userLocationLayer && !getInitialUserLocationVisibility()) {
  map.removeLayer(userLocationLayer);
}

// 図形描画コントロールを定義
const DrawShapeControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
    container.id = "draw-control";
    container.innerHTML = `
            <div class="draw-control-wrapper">
                <button type="button" class="draw-control-button" id="draw-toggle-btn">図形ツール</button>
                <div class="draw-control-zone is-collapsed" id="draw-control-panel">
                <input
                    type="text"
                    id="draw-shape-name"
                    class="draw-control-input"
                    maxlength="80"
                    aria-label="図形名"
                    placeholder="図形名を設定（任意）"
                />
                <div class="draw-control-color-row">
                    <span class="draw-control-color-label">色</span>
                    <input
                        type="color"
                        id="draw-shape-color"
                        class="draw-control-color-input"
                        aria-label="図形色"
                        value="#d94841"
                    />
                </div>
                <button type="button" class="draw-control-button" data-draw-mode="polygon">ポリゴン</button>
                    <button type="button" class="draw-control-button" data-draw-mode="polyline">折れ線</button>
                    <button type="button" class="draw-control-button" data-draw-mode="rectangle">矩形</button>
                    <button type="button" class="draw-control-button" data-draw-mode="circle">円</button>
                    <button type="button" class="draw-control-button" data-draw-mode="delete">削除</button>
                    <button type="button" class="draw-control-button" id="draw-undo-btn">削除した図形を戻す</button>
                    <button type="button" class="draw-control-button" id="draw-complete-btn">完了</button>
                    <button type="button" class="draw-control-button" id="draw-cancel-btn">キャンセル</button>
                </div>
            </div>
        `;

    container
      .querySelector("#draw-toggle-btn")
      .addEventListener("click", () => {
        toggleDrawPanel();
      });

    container.querySelectorAll("[data-draw-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        beginDrawing(button.dataset.drawMode);
      });
    });

    container
      .querySelector("#draw-complete-btn")
      .addEventListener("click", async () => {
        await completeActiveDrawing();
      });

    container
      .querySelector("#draw-cancel-btn")
      .addEventListener("click", () => {
        closeShapeNameEditor();
        resetDrawingState("図形描画: キャンセルしました。");
      });

    container
      .querySelector("#draw-undo-btn")
      .addEventListener("click", async () => {
        await undoDeletedShape();
      });

    updateUndoButtonState();
    toggleDrawPanel(false);

    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

const drawShapeControl = new DrawShapeControl();
map.addControl(drawShapeControl);
registerHideableMapControl(drawShapeControl);
restoreSavedShapes();
drawnShapesGroup.addTo(map);
if (!getInitialShapeLayerVisibility()) {
  map.removeLayer(drawnShapesGroup);
}
applyMeasurementVisibilityToDrawnShapesGroup();
const shapeLayerOverlays = { 図形: drawnShapesGroup };
if (userLocationLayer) {
  shapeLayerOverlays["現在位置"] = userLocationLayer;
}
const shapeLayersControl = L.control.layers(null, shapeLayerOverlays, {
  collapsed: false,
});
shapeLayersControl.addTo(map);
registerHideableMapControl(shapeLayersControl);
map.on("overlayadd", function (event) {
  if (event.layer === userLocationLayer) {
    saveUserLocationVisibility(true);
    return;
  }

  if (event.layer !== drawnShapesGroup) {
    return;
  }

  saveShapeLayerVisibility(true);
  setTimeout(() => {
    renderVisibleShapes();
    bindVisibleShapeLabelEvents();
    applyMeasurementVisibilityToDrawnShapesGroup();
    updateShapeVertexAddTargetStyles();
  }, 0);
});
map.on("overlayremove", function (event) {
  if (event.layer === userLocationLayer) {
    saveUserLocationVisibility(false);
    return;
  }

  if (event.layer === drawnShapesGroup) {
    clearShapeGeometryEditing();
    saveShapeLayerVisibility(false);
  }
});

// 測定結果ラベル表示・非表示コントロールの定義
const MeasurementVisibleControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create(
      "div",
      "leaflet-bar leaflet-control measurement-control",
    );
    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.innerHTML = "図形の計測";
    const mergeButton = L.DomUtil.create(
      "button",
      "custom-control-button is-hidden",
      container,
    );
    mergeButton.id = "measurement-merge-toggle-btn";
    mergeButton.type = "button";
    mergeButton.innerHTML = "辺を結合";
    mergeButton.setAttribute("aria-pressed", "false");

    L.DomEvent.on(button, "click", function (e) {
      L.DomEvent.stop(e);
      toggleMeasurementLabels();
    });

    L.DomEvent.on(mergeButton, "click", function (e) {
      L.DomEvent.stop(e);
      toggleMeasurementSegmentMerge();
    });

    L.DomEvent.disableClickPropagation(container);
    updateMeasurementControlState();
    return container;
  },
});

const measurementVisibleControl = new MeasurementVisibleControl();
map.addControl(measurementVisibleControl);
registerHideableMapControl(measurementVisibleControl);

// 指定地点へ地図を移動し、必要ならマーカーを強調表示する
function onFocusMarker(markerId, lat, lng) {
  if (lat === "" || lng == "") {
    console.log("Not value.");
    return;
  }
  if (isValidCoordinate(lat, lng)) {
    let latLng = new L.LatLng(lat, lng);
    map.setView(latLng, 16);
    if (!markerId) {
      return;
    }

    const marker = markers[`marker-${markerId}`];
    if (!marker) {
      return;
    }
    if (!markersClusterGroup.hasLayer(marker)) {
      markersClusterGroup.addLayer(marker);
    }

    if (typeof markersClusterGroup.zoomToShowLayer === "function") {
      markersClusterGroup.zoomToShowLayer(marker, () => {
        openMarkerPopup(markerId);
      });
    } else {
      openMarkerPopup(markerId);
    }
  }
}

// Vue 側で更新されたマーカー情報を、既存の Leaflet マーカーへ反映する
function applyMarkerUpdateFromParent(payload) {
  const markerId = String(payload?.id || "");
  const markerKey = `marker-${markerId}`;
  const marker = markers[markerKey];
  const current = markersFromAxum[markerId];
  if (
    !marker ||
    !current ||
    !Number.isFinite(Number(payload.latitude)) ||
    !Number.isFinite(Number(payload.longitude))
  ) {
    return false;
  }

  const nextRecord = {
    ...current,
    id: markerId,
    layer_id: String(payload.layerId || ""),
    marker_name: String(payload.name || ""),
    detail: String(payload.detail || ""),
    latitude: Number(payload.latitude),
    longitude: Number(payload.longitude),
  };
  markersFromAxum[markerId] = nextRecord;
  marker.setLatLng([nextRecord.latitude, nextRecord.longitude]);

  const wasPopupOpen =
    typeof marker.isPopupOpen === "function" && marker.isPopupOpen();
  marker.unbindTooltip();
  marker.unbindPopup();
  marker.bindTooltip(
    nextRecord.marker_name
      ? `<div class="custom-tooltip">${escapeHtml(nextRecord.marker_name)}</div>`
      : `<div class="custom-tooltip">No Name</div>`,
  );
  if (nextRecord.detail) {
    const mdText = `# ${nextRecord.marker_name}\n\n${nextRecord.detail}`;
    const cleanHtml = filterXSS(marked.parse(mdText), xssOptions);
    marker.bindPopup(
      `<div class="md-detail-contents">${renderIframe(cleanHtml)}</div>`,
    );
  }

  const markerOptions = markerOptionsForLayer(
    nextRecord.layer_id,
    layersFromAxum,
  );
  marker.setIcon(markerOptions.icon || new L.Icon.Default());
  const markerElement = marker.getElement();
  if (markerElement) {
    markerElement.id = markerKey;
  }
  if (wasPopupOpen && nextRecord.detail) {
    marker.openPopup();
  }
  return true;
}

// Vue 側で更新された図形情報を、既存の Leaflet レイヤへ反映する
function applyShapeUpdateFromParent(payload) {
  const shapeId = String(payload?.id || "");
  const targetLayer = Array.from(searchableShapeLayers).find(
    (shapeLayer) => String(shapeLayer?.shapeId || "") === shapeId,
  );
  if (
    !targetLayer ||
    !payload?.geojson ||
    targetLayer.shapeType !== payload.shapeType
  ) {
    return false;
  }

  const currentGeometry = targetLayer.options?.shapeRecord?.geojson?.geometry;
  if (
    JSON.stringify(currentGeometry) !==
    JSON.stringify(payload.geojson.geometry)
  ) {
    return false;
  }

  applyShapeRecord(targetLayer, {
    id: shapeId,
    layer_id: String(payload.layerId || ""),
    shape_type: payload.shapeType,
    name: String(payload.name || ""),
    geojson: payload.geojson,
  });
  updateShapeNameLabel(targetLayer, payload.name || "");
  applyShapeStyle(targetLayer, activeDrawMode === "delete");
  refreshShapeMeasurementMarkers(targetLayer);
  renderVisibleShapes();
  applyMeasurementVisibilityToDrawnShapesGroup();
  return true;
}

function applyMapObjectUpdateFromParent(payload) {
  if (payload?.objectType === "marker") {
    return applyMarkerUpdateFromParent(payload);
  }
  if (payload?.objectType === "shape") {
    return applyShapeUpdateFromParent(payload);
  }
  return false;
}

// iframe内でマーカーIDと座標を受け取る
window.addEventListener("message", function (event) {
  const allowOrigins = ["http://localhost:5173", "http://localhost:3000"];

  const isSameOrigin = event.origin === window.location.origin;

  if (
    event.source === window.parent &&
    (allowOrigins.includes(event.origin) || isSameOrigin)
  ) {
    const messageData = event.data;
    if (!messageData || typeof messageData !== "object") return;
    if (messageData["type"] === "focus") {
      onFocusMarker(messageData["id"], messageData["lat"], messageData["lng"]);
    } else if (messageData["type"] === "mapObjectFilter") {
      applyMapObjectFilter(messageData["markerIds"], messageData["shapeIds"]);
    } else if (messageData["type"] === "markerFilter") {
      applyMarkerFilter(messageData["ids"]);
    } else if (messageData["type"] === "mapObjectUpdate") {
      let success = false;
      try {
        success = applyMapObjectUpdateFromParent(messageData["payload"]);
        if (success && messageData["payload"]?.objectType === "marker") {
          renderVisibleMarkers();
        }
      } catch (error) {
        console.error("Map object update from parent failed:", error);
      }
      event.source.postMessage(
        {
          type: "mapObjectUpdateResult",
          requestId: messageData["requestId"],
          success,
        },
        event.origin,
      );
    }
  }
});

// 親ウィンドウへログイン画面遷移要求を送る
function callParentLogin() {
  window.parent.postMessage(
    { type: "callParentLoginRedirect", message: "Token expired" },
    "*",
  );
}

// 親ウィンドウへ再読み込み要求を送る
function callParentReload(layerId = null) {
  window.parent.postMessage(
    {
      type: "callParentReload",
      message: "Reload",
      layerId: layerId,
    },
    "*",
  );
}

// 親ウィンドウへ画像プレビュー表示要求を送る
function callParentImagePreview(url) {
  window.parent.postMessage(
    { type: "callParentImagePreview", message: url },
    "*",
  );
}

// トークンの認可管理と新規発行（認証切れ時の再試行を含めた fetch ラッパー）
async function fetchWithAuth(url, options = {}) {
  let response = await fetch(url, {
    ...options,
    credentials: "include", // `httpOnly` クッキーを送信
  });
  if (response.status === 401) {
    try {
      await refreshToken(); // リフレッシュトークンを取得
      response = await fetch(url, {
        ...options,
        credentials: "include", // 新しいアクセストークンを送信
      });
    } catch (error) {
      callParentLogin();
      throw new Error("Session expired, please log in again");
    }
  }
  return response;
}

// リフレッシュトークンでアクセストークンを更新する
async function refreshToken() {
  try {
    const response = await fetch("/account/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error("Refresh token expired");
    }
  } catch (error) {
    throw new Error("Token refresh failed");
  }
}

// セッションを破棄してログイン画面へ戻す
function logout() {
  callParentLogin();
}
