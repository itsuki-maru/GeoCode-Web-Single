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
// app-youtubeからiframeに置換;

// ネスト対応トークナイザの共通関数
// それぞれのトークンを生成
const detailsToken = createNestedTokenizer("details");
const noteToken = createNestedTokenizer("note");
const warningToken = createNestedTokenizer("warning");

marked.use({
  extensions: [videoToken, detailsToken, noteToken, warningToken, youtubeToken],
});

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

// ローカルホスト判定
// 拡張子でPDFファイルか判定する関数
// [テキスト](URL)で定義された外部リンクを別タブで開かせるカスタムレンダラ設定
// 元のlink関数を保存
const originalLinkRenderer = renderer.link.bind(renderer);
// link関数をオーバーライド
renderer.link = (token) => {
  const { href } = token;
  // 外部リンクかどうかをチェック
  const isExternal = /^https?:\/\//.test(href);
  let isLocal = false;
  let isPDFHref = false;
  if (href) {
    isLocal = isLocalhost(href);
    isPDFHref = isPDF(href);
  }
  const html = originalLinkRenderer(token);
  if (isExternal) {
    if (isLocal && isPDFHref) {
      return html.replace(
        /^<a /,
        '<a target="_blank" rel="noopener noreferrer" title="PDFリンク" ',
      );
    }
    return html.replace(
      /^<a /,
      '<a target="_blank" rel="noopener noreferrer" title="外部リンク" ',
    );
  } else {
    // 内部リンクかつPDFの場合
    if (isPDFHref) {
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
  northEast = L.latLng(45.55, 153.59); // 最北端の座標
const bounds = L.latLngBounds(southWest, northEast);

// 表示範囲の制限
if (!tileServers["1"]["include_foreign_tiles"]) {
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
let isMapUiHidden = initialIsMapUiHidden;
let mapUiVisibilityToggleButton = null;

// UI 表示切替ボタンの文言とアクセシビリティ属性を更新する
function updateMapUiVisibilityToggleButton() {
  if (!mapUiVisibilityToggleButton) {
    return;
  }

  const buttonText = isMapUiHidden ? "機能を表示" : "地図だけを表示";
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
}

// 非表示対象の Leaflet コントロール DOM を登録する
function registerHideableMapUiContainer(container) {
  if (!container) {
    return;
  }

  container.classList.add("temporary-map-hideable-ui");
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
    position: "bottomleft",
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
      if (key === "1") {
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
var tileLayer = L.tileLayer(tileServers["1"]["url"], {
  minZoom: tileServers["1"]["min_zoom"] ?? 5,
  maxZoom: tileServers["1"]["max_zoom"] ?? 18,
  attribution: tileServers["1"]["attribution"],
}).addTo(map);

// タイルの切り替え関数
// ポップアップを開く関数
// クラスターグループを管理するオブジェクト
const clusterGroups = {};
// layersControl のチェック状態を管理するための空レイヤ
const layerVisibilityGroups = {};
// チェック済みレイヤのマーカーを集約して、レイヤ横断でクラスタ化する表示用グループ
const visibleMarkerGroup = L.markerClusterGroup();
visibleMarkerGroup.addTo(map);
const shapeGroups = {};
const shapeLayers = {};
let shapeNameLabelManager = null;
let shapeMeasurementManager = null;
const shapeVisibilityLayer = L.layerGroup().addTo(map);
const shapeNameVisibilityLayer = L.layerGroup();
let hasSharedShapes = false;
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;
// マーカーにIDを振るためのオブジェクト
let markers = {};
// レイヤー名を格納するオブジェクト
let layerNames = {};
const SHAPE_STYLE = {
  color: "#d94841",
  weight: 5,
  fillColor: "#d94841",
  fillOpacity: 0.16,
};
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;

// HTMLエスケープを行う関数
// 図形の名前を正規化する関数
// 図形色を #RRGGBB 形式へ正規化する
// 図形種別ごとの既定スタイルを返す
// GeoJSON から図形スタイルを取り出す
// GeoJSON に保存された円の半径を取り出す
// レイヤ単位のマーカーグループを必要に応じて生成する
