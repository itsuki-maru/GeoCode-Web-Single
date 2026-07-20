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

marked.use({
  mangle: false,
  headerIds: false,
});

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

// ローカルホスト判定
// 拡張子でPDFファイルか判定する関数
// [テキスト](URL)で定義された外部リンクを別タブで開かせるカスタムレンダラ設定
// 元のlink関数を保存
const originalLinkRenderer = renderer.link.bind(renderer);
// link関数をオーバーライド
renderer.link = (href, title, text) => {
  // 外部リンクかどうかをチェック
  const isExternal = /^https?:\/\//.test(href);
  let isLocal = false;
  let isPDFHref = false;
  if (href) {
    isLocal = isLocalhost(href);
    isPDFHref = isPDF(href);
  }
  const html = originalLinkRenderer(href, title, text);
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
const shapeVisibilityLayer = L.layerGroup().addTo(map);
let hasSharedShapes = false;
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;
// マーカーにIDを振るためのオブジェクト
let markers = {};
// レイヤー名を格納するオブジェクト
let layerNames = {};
const SHAPE_STYLE = {
  color: "#d94841",
  weight: 4,
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
function createMarkerGroupForLayer(layerId) {
  if (!layerId) {
    return null;
  }

  if (!clusterGroups[layerId]) {
    clusterGroups[layerId] = L.featureGroup();
  }
  if (!layerVisibilityGroups[layerId]) {
    layerVisibilityGroups[layerId] = L.layerGroup();
  }

  return clusterGroups[layerId];
}

// レイヤ単位の図形グループを必要に応じて生成する
function ensureShapeGroup(layerId) {
  if (!layerId) {
    return null;
  }

  if (!shapeGroups[layerId]) {
    shapeGroups[layerId] = L.featureGroup();
  }

  return shapeGroups[layerId];
}

// マーカーグループから対応するレイヤ ID を逆引きする
function findLayerIdByMarkerGroup(targetGroup) {
  return layeredMarkerDisplay.findLayerIdByVisibilityGroup(targetGroup);
}

// 指定レイヤのチェック状態に合わせて図形表示を同期する
function syncShapeGroupVisibility(layerId) {
  if (!layerId || !shapeGroups[layerId]) {
    return;
  }

  if (
    map.hasLayer(shapeVisibilityLayer) &&
    layeredMarkerDisplay.isLayerVisible(layerId)
  ) {
    if (!map.hasLayer(shapeGroups[layerId])) {
      shapeGroups[layerId].addTo(map);
    }

    shapeGroups[layerId].eachLayer((layer) => {
      if (layer?.isMeasurementLabel === true) {
        setMeasurementMarkerVisibility(layer, isMeasurementVisible);
      }
      if (typeof layer.openTooltip === "function") {
        layer.openTooltip();
      }
    });
    return;
  }

  if (map.hasLayer(shapeGroups[layerId])) {
    map.removeLayer(shapeGroups[layerId]);
  }
}

// 全レイヤ分の図形表示を現在のチェック状態へ同期する
function syncAllShapeGroupsVisibility() {
  Object.keys(shapeGroups).forEach((layerId) => {
    syncShapeGroupVisibility(layerId);
  });
}

// 図形のラベル座標を取得する関数
function flattenShapeLatLngs(latLngs) {
  if (!Array.isArray(latLngs) || latLngs.length === 0) {
    return [];
  }

  if (Array.isArray(latLngs[0])) {
    return flattenShapeLatLngs(latLngs[0]);
  }

  return latLngs;
}

// ポリラインの中心座標を取得する関数
// 図形のラベル座標を取得する関数
function getShapeLabelLatLng(layer, shapeType) {
  if (shapeType === "polyline") {
    return getPolylineCenterLatLng(layer);
  }

  if (shapeType === "circle" && typeof layer.getLatLng === "function") {
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

    const summaryLatLng = getShapeLabelLatLng(layer, layer.shapeType);
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

    const summaryLatLng = getShapeLabelLatLng(layer, layer.shapeType);
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
    const centerLatLng = getShapeLabelLatLng(layer, layer.shapeType);
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

// 計測ラベルを図形と同じレイヤグループへ登録する
function attachShapeMeasurementMarkers(layer, layerId) {
  if (!layer) {
    return;
  }

  const markers = createShapeMeasurementMarkers(layer);
  if (markers.length === 0) {
    return;
  }

  layer.measurementMarkers = markers;
  layer.measurementLayerId = layerId;
  const targetShapeGroup = ensureShapeGroup(layerId);
  if (targetShapeGroup) {
    markers.forEach((marker) => {
      targetShapeGroup.addLayer(marker);
      setMeasurementMarkerVisibility(marker, isMeasurementVisible);
    });
  }
}

// 計測ラベルを図形グループから取り除く
function removeShapeMeasurementMarkers(layer) {
  if (!layer || !Array.isArray(layer.measurementMarkers)) {
    return;
  }

  const targetShapeGroup = ensureShapeGroup(layer.measurementLayerId);
  layer.measurementMarkers.forEach((marker) => {
    if (targetShapeGroup) {
      targetShapeGroup.removeLayer(marker);
    }
  });
  layer.measurementMarkers = [];
}

// 辺結合の切り替えに合わせて図形の計測ラベルを再生成する
function refreshShapeMeasurementMarkers(layer) {
  if (!layer || !layer.shapeType || layer.isMeasurementLabel === true) {
    return;
  }

  const layerId = layer.measurementLayerId;
  removeShapeMeasurementMarkers(layer);
  attachShapeMeasurementMarkers(layer, layerId);
}

// すべての図形計測ラベルをまとめて再生成する
function refreshAllShapeMeasurementMarkers() {
  const shapeLayers = [];
  Object.keys(shapeGroups).forEach((layerId) => {
    shapeGroups[layerId].eachLayer((layer) => {
      if (layer?.shapeType && layer.isMeasurementLabel !== true) {
        shapeLayers.push(layer);
      }
    });
  });

  shapeLayers.forEach((layer) => {
    refreshShapeMeasurementMarkers(layer);
  });
}

// 計測ラベルマーカーの表示状態を反映する
// 指定レイヤ内の計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToShapeGroup(layerId) {
  if (!layerId || !shapeGroups[layerId]) {
    return;
  }

  shapeGroups[layerId].eachLayer((layer) => {
    if (layer?.isMeasurementLabel === true) {
      setMeasurementMarkerVisibility(layer, isMeasurementVisible);
    }
  });
}

// すべての計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToAllShapeGroups() {
  Object.keys(shapeGroups).forEach((layerId) => {
    applyMeasurementVisibilityToShapeGroup(layerId);
  });
}

// 図形の名前ラベルをバインドする関数
function bindShapeNameLabel(layer, shapeType, shapeName) {
  const normalizedName = normalizeShapeName(shapeName);
  if (!normalizedName || typeof layer.bindTooltip !== "function") {
    return;
  }

  const labelLatLng = getShapeLabelLatLng(layer, shapeType);
  const labelColor = normalizeShapeColor(
    layer && layer.shapeStyle ? layer.shapeStyle.color : null,
    SHAPE_STYLE.color,
  );
  layer.bindTooltip(
    `<div class="shape-name-label" style="color:${labelColor};">${escapeHtml(normalizedName)}</div>`,
    {
      permanent: true,
      direction: "center",
      className: "shape-name-tooltip",
    },
  );

  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  if (tooltip && labelLatLng && typeof tooltip.setLatLng === "function") {
    tooltip.setLatLng(labelLatLng);
  }
  if (typeof layer.openTooltip === "function") {
    layer.openTooltip();
  }
  const applyTooltipBorderColor = () => {
    const tooltipElement =
      tooltip && typeof tooltip.getElement === "function"
        ? tooltip.getElement()
        : null;
    if (!tooltipElement) {
      return;
    }
    tooltipElement.style.setProperty("border-color", labelColor, "important");
    tooltipElement.style.setProperty("color", labelColor, "important");
  };
  applyTooltipBorderColor();
  setTimeout(applyTooltipBorderColor, 0);
}

// 形状タイプと GeoJSON から Leaflet レイヤを生成する

// レイヤー名を保存するオブジェクトを作成
for (const key in layers) {
  if (!layerNames[layers[key]["id"]]) {
    layerNames[layers[key]["id"]] = layers[key]["layer_name"];
  }
}

// マーカーを作成
// データごとにクラスターグループを作成
for (const key in markersObj) {
  const markerData = markersObj[key];
  // layer_id ごとに markerClusterGroup を作成する
  createMarkerGroupForLayer(markerData["layer_id"]);

  // マーカーを作成してクラスターグループに追加する
  const marker = L.marker([
    markerData["latitude"],
    markerData["longitude"],
  ], markerOptionsForLayer(markerData["layer_id"], layers)).bindPopup(escapeHtml(markerData["marker_name"]));
  enableMarkerIconFallback(marker, markerData["layer_id"], layers);

  // ポップアップオープン時に遅延読み込みの処理を追加
  marker.on("popupopen", () => {
    setupDetailsLazyImages(document);
  });

  clusterGroups[markerData["layer_id"]].addLayer(marker);

  if (!markerData["marker_name"]) {
    marker.bindTooltip(`<div class="custom-tooltip">No Name</div>`, {
      permanent: false,
    });
  } else {
    marker.bindTooltip(
      `<div class="custom-tooltip">${escapeHtml(markerData["marker_name"])}</div>`,
      { permanent: false },
    );
  }
  if (markerData["detail"]) {
    const mdText = `# ${markerData["marker_name"]}\n\n${markerData["detail"]}`;
    const mdToHtml = marked.parse(mdText);
    const cleanHtml = filterXSS(mdToHtml, xssOptions);
    const renderHtml = renderIframe(cleanHtml);
    const bindMDToHtml = `<div class="md-detail-contents">${renderHtml}</div>`;
    marker.bindPopup(bindMDToHtml);
  }
  // マーカーのHTML要素を取得し、id属性を設定
  let markerIcon = marker.getElement();
  if (markerIcon) {
    markerIcon.id = `marker-${markerData["id"]}`;
  }
  markers[`marker-${markerData["id"]}`] = marker;
}

for (const key in shapesObj) {
  createMarkerGroupForLayer(shapesObj[key]["layer_id"]);
}

// isChecked が true の場合のみ、初期表示で共有レイヤを地図に追加する
if (isChecked) {
  Object.values(layerVisibilityGroups).forEach((group) => group.addTo(map));
}

// 共有図形の復元
for (const key in shapesObj) {
  const layerId = shapesObj[key]["layer_id"];
  const shapeStyle = getShapeStyleFromGeoJson(
    shapesObj[key]["shape_type"],
    shapesObj[key]["geojson"],
  );
  const layer = createLeafletShapeLayer(
    shapesObj[key]["shape_type"],
    shapesObj[key]["geojson"],
    shapeStyle,
  );
  if (!layer) {
    continue;
  }

  layer.shapeStyle = shapeStyle;
  layer.shapeType = shapesObj[key]["shape_type"];
  layer.shapeName = normalizeShapeName(shapesObj[key]["name"] || "");
  bindShapeNameLabel(
    layer,
    shapesObj[key]["shape_type"],
    shapesObj[key]["name"],
  );
  const targetShapeGroup = ensureShapeGroup(layerId);
  if (targetShapeGroup) {
    targetShapeGroup.addLayer(layer);
    hasSharedShapes = true;
  }
  attachShapeMeasurementMarkers(layer, layerId);
}

function initializeCollapsibleLayerControl(layersControl, overlayCount) {
  if (overlayCount < 4) {
    return;
  }

  const container = layersControl.getContainer();
  if (!container) {
    return;
  }

  const overlayContainer = container.querySelector(
    ".leaflet-control-layers-overlays",
  );
  if (!overlayContainer) {
    return;
  }

  const applyCollapsibleItems = () => {
    const overlayItems = Array.from(overlayContainer.querySelectorAll("label"));
    overlayItems.forEach((item) => {
      item.classList.remove("temporary-layer-control-collapsible-item");
    });
    overlayItems.slice(2).forEach((item) => {
      item.classList.add("temporary-layer-control-collapsible-item");
    });
    return overlayItems.length;
  };

  if (applyCollapsibleItems() < 4) {
    return;
  }

  container.classList.add("temporary-layer-control");

  const toggleButton = L.DomUtil.create(
    "button",
    "temporary-layer-control-toggle",
    container,
  );
  toggleButton.type = "button";

  const updateToggleState = () => {
    const isCollapsed = container.classList.contains("is-collapsed");
    toggleButton.textContent = isCollapsed ? "すべて表示" : "折り畳む";
    toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
  };

  L.DomEvent.on(toggleButton, "click", (event) => {
    L.DomEvent.stop(event);
    applyCollapsibleItems();
    container.classList.toggle("is-collapsed");
    updateToggleState();
  });

  map.on("overlayadd overlayremove", () => {
    setTimeout(() => {
      applyCollapsibleItems();
    }, 0);
  });

  L.DomEvent.disableClickPropagation(container);
  if (L.DomEvent.disableScrollPropagation) {
    L.DomEvent.disableScrollPropagation(container);
  }
  updateToggleState();
}

// L.control.layers にクラスターグループを追加する
const layersControl = L.control.layers(null, null, { collapsed: false });

// 表示切替用の空レイヤをレイヤーコントロールに追加する
const layerControlOverlayLayers = [];
for (const layer_id in clusterGroups) {
  const layerName = escapeHtml(layerNames[layer_id]);
  if (!layerName) {
    continue;
  }
  layersControl.addOverlay(layerVisibilityGroups[layer_id], layerName);
  layerControlOverlayLayers.push(layerVisibilityGroups[layer_id]);
}

// レイヤーコントロールをマップに追加
layersControl.addTo(map);
registerHideableMapControl(layersControl);
// チェック状態に応じて単一の表示用グループへマーカーを集約する
const layeredMarkerDisplay = createLayeredMarkerDisplayManager({
  map,
  markerRecords: markersObj,
  markers,
  visibleMarkerGroup,
  layerVisibilityGroups,
});
layeredMarkerDisplay.rebuildVisibleMarkers();
const layerBulkToggleControl = createLayerBulkToggleControl({
  map,
  overlayLayers: layerControlOverlayLayers,
});
map.addControl(layerBulkToggleControl);
registerHideableMapControl(layerBulkToggleControl);
initializeCollapsibleLayerControl(
  layersControl,
  layerControlOverlayLayers.length,
);
syncAllShapeGroupsVisibility();
map.on("overlayadd", function (event) {
  if (event.layer === shapeVisibilityLayer) {
    syncAllShapeGroupsVisibility();
    return;
  }

  const layerId = findLayerIdByMarkerGroup(event.layer);
  if (!layerId) {
    return;
  }

  // レイヤ切替時は検索状態を解除し、表示用グループを作り直す
  layeredMarkerDisplay.clearSearch();

  setTimeout(() => {
    syncShapeGroupVisibility(layerId);
  }, 0);
});
map.on("overlayremove", function (event) {
  if (event.layer === shapeVisibilityLayer) {
    syncAllShapeGroupsVisibility();
    return;
  }

  const layerId = findLayerIdByMarkerGroup(event.layer);
  if (!layerId) {
    return;
  }

  layeredMarkerDisplay.rebuildVisibleMarkers();
  syncShapeGroupVisibility(layerId);
});

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

// 測定結果ラベル表示・非表示コントロールの定義
const MeasurementVisibleControl = L.Control.extend({
  options: {
    position: "topright",
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

if (hasSharedShapes) {
  const measurementVisibleControl = new MeasurementVisibleControl();
  map.addControl(measurementVisibleControl);
  registerHideableMapControl(measurementVisibleControl);
}

// ツールチップの表示・非表示を管理する
let isTooltipVisible = false;

// ツールチップの表示非表示を切り替える関数
// 計測ラベルの表示非表示を切り替える関数
function toggleMeasurementLabels() {
  isMeasurementVisible = !isMeasurementVisible;
  applyMeasurementVisibilityToAllShapeGroups();
  updateMeasurementControlState();
}

// 計測コントロールの表示状態を反映する
// 辺を結合する表示へ切り替える

// 地図に検索コントロールを追加
const codeSearchControl = createCodeSearchControl();
map.addControl(codeSearchControl);
registerHideableMapControl(codeSearchControl);
const markerSearchControl = createMarkerSearchControl({
  markerRecords: markersObj,
  markers: markers,
  clusterGroups: clusterGroups,
  // 検索時も表示用グループの再構築へ委譲する
  onSearch: layeredMarkerDisplay.setSearchQuery,
  onClear: layeredMarkerDisplay.clearSearch,
});
map.addControl(markerSearchControl);

map.addControl(new MapUiVisibilityToggleControl());
const userLocationLayer = initializeUserLocation(map, {
  position: "bottomleft",
  controlClassName: "temporary-user-location-control",
});
const mapVisibilityOverlays = {};
if (hasSharedShapes) {
  mapVisibilityOverlays["図形"] = shapeVisibilityLayer;
}
if (userLocationLayer) {
  mapVisibilityOverlays["現在位置"] = userLocationLayer;
}
if (Object.keys(mapVisibilityOverlays).length > 0) {
  const mapVisibilityControl = L.control.layers(null, mapVisibilityOverlays, {
    collapsed: false,
    position: "topleft",
  });
  mapVisibilityControl.addTo(map);
  registerHideableMapControl(mapVisibilityControl);
}
