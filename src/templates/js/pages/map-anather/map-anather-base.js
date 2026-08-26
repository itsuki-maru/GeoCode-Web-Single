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
// app-youtubeからiframeに置換（埋め込み要素を含む HTML を表示用に整形）;

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
  return `<img src="${newHref}" class="marker-preview-image" data-preview-src="${href}">`;
};

// 実行環境が PWA かブラウザか判定する機能
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

// リンク先がローカル環境かどうかを判定する
// 対象ファイルが PDF かどうかを判定
// ダウンロード可能ファイルであるか検証
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

// detailsタグ内の img タグと video タグ内のネットワークコンテンツを遅延読み込みさせる処理
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
  center: [37.65, 138.0],
  crs: L.CRS.EPSG3857,
  zoom: 6,
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
map.addControl(new TileControl());

// 初期タイルの設定
var tileLayer = L.tileLayer(tileServers["1"]["url"], {
  minZoom: tileServers["1"]["min_zoom"] ?? 5,
  maxZoom: tileServers["1"]["max_zoom"] ?? 18,
  attribution: tileServers["1"]["attribution"],
}).addTo(map);

// 選択されたタイルサーバーに地図表示を切り替える関数
// 指定 ID のマーカーポップアップを開く
// クラスターグループを管理するオブジェクト
const clusterGroups = {};
// layersControl のチェック状態を管理するための空レイヤ
const layerVisibilityGroups = {};
// チェック済みレイヤのマーカーを集約して、レイヤ横断でクラスタ化する表示用グループ
const visibleMarkerGroup = isCluster
  ? L.markerClusterGroup()
  : L.featureGroup();
if (getInitialMarkerVisibility()) {
  visibleMarkerGroup.addTo(map);
}
// マーカーにIDを振るためのオブジェクト
let markers = {};
// レイヤー名を格納するオブジェクト
let layerNames = {};

// 図形描画グループ
const drawnShapesGroup = L.featureGroup();
const shapeGroups = {};
const shapeLayers = {};
let shapeNameLabelManager = null;
let shapeMeasurementManager = null;
const suppressInitialShapeRendering =
  shouldSuppressInitialShapeRendering(shapesFromAxum);
const shapeVisibilityLayer = L.layerGroup();
if (!suppressInitialShapeRendering && getInitialShapeLayerVisibility()) {
  shapeVisibilityLayer.addTo(map);
}
const shapeNameVisibilityLayer = L.layerGroup();
if (!suppressInitialShapeRendering && getInitialShapeNameVisibility()) {
  shapeNameVisibilityLayer.addTo(map);
}
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;

// 図形のスタイル
const SHAPE_STYLE = {
  color: "#d94841",
  weight: 5,
  fillColor: "#d94841",
  fillOpacity: 0.16,
};
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;

// レイヤー名のマッピング
for (const key in layersFromAxum) {
  if (!layerNames[layersFromAxum[key]["id"]]) {
    layerNames[layersFromAxum[key]["id"]] = layersFromAxum[key]["layer_name"];
  }
}

// レイヤ単位のマーカーグループを必要に応じて生成する
