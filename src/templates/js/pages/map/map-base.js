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
// 埋め込み要素を含む HTML を表示用に整形する（ app-youtube から iframe に置換）;

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
// 拡張子で PDF ファイルか判定する関数
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

// detailsタグ内のimgタグとvideoタグ内のネットワークコンテンツを遅延読み込みさせる処理（画像を遅延読み込みで初期化）
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
  northEast = L.latLng(45.55, 153.59); // 最北端の座標
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
map.addControl(new ModeControl());

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
map.addControl(new TileControl());

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

function applyMarkerFilter(markerIds) {
  markersClusterGroup.clearLayers();

  if (!Array.isArray(markerIds)) {
    Object.values(markers).forEach((marker) => {
      markersClusterGroup.addLayer(marker);
    });
    return;
  }

  const markerIdSet = new Set(markerIds.map((id) => `marker-${id}`));
  Object.entries(markers).forEach(([key, marker]) => {
    if (markerIdSet.has(key)) {
      markersClusterGroup.addLayer(marker);
    }
  });
}

