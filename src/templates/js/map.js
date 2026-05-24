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
                tokens: this.lexer.inlineTokens(match[1], [])
            };
        }
    },
    renderer(token) {
        return `<video controls src="${token.href}" poster="${token.href}?thumb=true" preload="none">${token.text}</video>`;
    }
}

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
            }
        }
        return null;
    },
    renderer(token) {
        // 生iframeではなく、自前テンプレートにする（例：Web Component）
        return `<app-youtube video-id="${token.text}" data-src="${token.href}"></app-youtube>`;
    }
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
    extensions: [
        videoToken,
        detailsToken,
        noteToken,
        warningToken,
        youtubeToken,
    ]
});

marked.use(
    {
        mangle: false,
        headerIds: false
    }
);

// 画像クリック時に別ウィンドウで拡大表示できるようにカスタムレンダラを定義
const renderer = new marked.Renderer();
const originalImageRenderer = renderer.image;
renderer.image = function (href, title, text) {
    const separator = href.includes("?") ? "&" : "?";
    const newHref = href ? `${href}${separator}thumb=true` : "";
    const titleAttr = title ? ` title="${title}"` : "";
    return `<img src="${newHref}" style="cursor:pointer;" onclick="callParent('${href}')">`
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
    .then(response => response.blob())
    .then(blob => {
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
                return html.replace(/^<a /, `<a href="#" title="PDFダウンロードリンク" onclick="downloadFile('${href}')"`);
            }
            return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" title="PDFリンク" ');
        }
        // リンクを別タブで起動
        return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" title="外部リンク" ');
    } else {
        // 内部リンクかつPDFの場合
        if (isPDFHref) {
            // PWAとしての実行時はダウンロードを実行
            if (isRunningAsPWA()) {
                return html.replace(/^<a /, `<a href="#" title="PDFダウンロードリンク" onclick="downloadFile('${href}')"`);
            }
            return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" title="PDFリンク" ');
        }
        // 内部リンクの場合、元の処理を使用
        return originalLinkRenderer(href, title, text);
    }
};

marked.setOptions({ renderer });

// detailsタグ内のimgタグとvideoタグ内のネットワークコンテンツを遅延読み込みさせる処理（画像を遅延読み込みで初期化）
// XSSフィルタのカスタマイズ
let xssOptions = {
    whiteList: {
        h1: ['id', 'class'], // h1タグのid属性を許可 class属性を許可
        h2: ['id', 'class'], // h2タグのid属性を許可 class属性を許可
        h3: ['id'], // h3タグのid属性を許可
        h4: ['id'], // h4タグのid属性を許可
        h5: ['id'], // h5タグのid属性を許可
        h6: ['id'], // h6タグのid属性を許可
        pre: ['class'],
        a: ['target', 'rel', 'href', 'title', 'onclick'],
        img: ['src', 'alt', 'onclick'],
        video: ['src', 'controls', 'preload', 'poster'],
        p: [],
        div: ['class'],
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
        details: ['class'],
        summary: [],
        "app-youtube": ['video-id', 'data-src'],
    },
    // iframeの確認（念のため、iframeはここで不許可）
    onTag(tag, html) {
        if (tag === "iframe") return "Not Allow iframe ";
    },
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script"],
};


// 地図オブジェクトの初期化
var map = L.map(
    "map",
    {
        center: [latitude, longitude],
        crs: L.CRS.EPSG3857,
        zoom: zoom,
        zoomControl: true,
        preferCanvas: false,
        // Leafletの著作権表示に_blank属性を追加するために、デフォルト値を無効化
        attributionControl: false
    }
);

// 日本の最南端と最北端の座標を使用して境界を設定
const southWest = L.latLng(20.25, 122.56), // 最南端の座標
northEast = L.latLng(45.55, 153.59); // 最北端の座標
const bounds = L.latLngBounds(southWest, northEast);

// 表示範囲の制限
if (!tileServers["1"]["include_foreign_tiles"]) {
    map.setMaxBounds(bounds);
}

// leafletのライセンスリンクを別タブで開く設定を付与して追加
L.control.attribution({prefix: false}).addAttribution('&copy; <a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>').addTo(map);

// 入力モードと閲覧モードの制御
var ModeControl = L.Control.extend({
    options: {
        position: 'topright'
    },

    onAdd: function(map) {
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
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
        radios.forEach(radio => {
            radio.addEventListener("change", handleRadioChange);
        });

        // Leafletのクリックイベントとの干渉を避ける
        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});


// 地図にカスタムコントロールを追加
map.addControl(new ModeControl());

// タイルレイヤーの制御
var TileControl = L.Control.extend({
    options: {
        position: 'topright'
    },
    onAdd: function(map) {
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');

        // ラジオボタンのHTMLを動的に生成
        let radioHTML = '<div class="radio-zone"><form>';
            for (const key in tileServers) {
                let checkedAttribute = "";
                if (key === "1") {
                    checkedAttribute = "checked"
                }
                radioHTML += `
                <input class="tile-radio" type="radio" id="${tileServers[key]["layer_name"]}" name="tile" value="${key}" ${checkedAttribute}>
                <label for="${tileServers[key]["layer_name"]}" class="tile-radio-label">${tileServers[key]["label"]}</label><br>
                `
            }
            radioHTML += '</form></div>';
            container.innerHTML = radioHTML;

        // タイルのイベントリスナーを追加
        const tileRadios = container.querySelectorAll(".tile-radio");
        tileRadios.forEach(radio => {
            radio.addEventListener("change", handleTileChange);
        });

        // Leafletのクリックイベントとの干渉を避ける
        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});

// 地図にタイルコントロールを追加
map.addControl(new TileControl());

// 初期タイルの設定
var tileLayer = L.tileLayer(tileServers["1"]["url"], {
    minZoom: tileServers["1"]["min_zoom"] ?? 5,
    maxZoom: tileServers["1"]["max_zoom"] ?? 18,
    attribution: tileServers["1"]["attribution"]
}).addTo(map);

// 選択されたタイルサーバーに地図表示を切り替える関数
// マーカーにIDを振るためのオブジェクト
let markers = {};
// Leaflet.markerclusterの使用
let markersClusterGroup = L.markerClusterGroup();

// HTMLと同時に取得したマーカーデータをプロット配備
for (const key in markersFromAxum) {
    let marker = L.marker([markersFromAxum[key]["latitude"], markersFromAxum[key]["longitude"]], {draggable: false})
        .addTo(markersClusterGroup)
        .on("dragend", function(event) {
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
        marker.bindTooltip(`<div class="custom-tooltip">${markersFromAxum[key]["marker_name"]}</div>`);
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

const drawnShapesGroup = L.featureGroup();
const SHAPE_STYLE = {
    color: "#d94841",
    weight: 3,
    fillColor: "#d94841",
    fillOpacity: 0.16
};
const DELETE_SHAPE_STYLE = {
    color: "#c1121f",
    weight: 8,
    fillColor: "#f28482",
    fillOpacity: 0.28
};
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;
let activeDrawMode = null;
let drawPoints = [];
let drawPreviewLayer = null;
let rectangleStartLatLng = null;
let circleStartLatLng = null;
let deletedShapesStack = [];
let editingShapeLayer = null;
let editingShapePopup = null;
let suppressShapeLabelClickUntil = 0;
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;

// 図形描画用のステータスメッセージを更新する
function setDrawStatus(message, isError = false) {
    const status = document.getElementById("draw-status");
    if (!status) {
        return;
    }
    status.textContent = message;
    status.classList.toggle("is-error", isError);
}

// ラベルやポップアップ表示用に HTML をエスケープする
// 図形名を表示・保存しやすい形に正規化する
// 図形色を #RRGGBB 形式へ正規化する
// 図形種別ごとの既定スタイルを返す
// GeoJSON から図形スタイルを取り出す
// 選択色から図形スタイルを作る
function buildShapeStyleFromColor(shapeType, color) {
    const normalizedColor = normalizeShapeColor(color, SHAPE_STYLE.color);
    const defaultStyle = getDefaultShapeStyle(shapeType);
    if (shapeType === "polyline") {
        return {
            color: normalizedColor,
            weight: defaultStyle.weight,
            fill: false,
        };
    }

    return {
        color: normalizedColor,
        weight: defaultStyle.weight,
        fillColor: normalizedColor,
        fillOpacity: defaultStyle.fillOpacity,
    };
}

// 図形レイヤから保存用 GeoJSON を組み立てる
function buildShapeGeoJson(layer, shapeType, shapeStyle) {
    const geojson = layer.toGeoJSON();
    const normalizedStyle = {
        color: normalizeShapeColor(shapeStyle?.color, SHAPE_STYLE.color),
        weight: Number(shapeStyle?.weight) || SHAPE_STYLE.weight,
    };

    if (shapeType !== "polyline") {
        normalizedStyle.fillColor = normalizeShapeColor(
            shapeStyle?.color,
            normalizedStyle.color
        );
        normalizedStyle.fillOpacity = Number.isFinite(Number(shapeStyle?.fillOpacity))
            ? Number(shapeStyle.fillOpacity)
            : SHAPE_STYLE.fillOpacity;
    }

    geojson.properties = {
        ...(geojson.properties && typeof geojson.properties === "object" ? geojson.properties : {}),
        style: normalizedStyle,
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

// ポップアップ直後のラベル再クリックを一時的に抑止する
function suppressShapeLabelClick(durationMs = 300) {
    suppressShapeLabelClickUntil = Date.now() + durationMs;
}

// 図形ラベルのクリック抑止中かどうかを返す
function isShapeLabelClickSuppressed() {
    return Date.now() < suppressShapeLabelClickUntil;
}

// 開いている図形名編集ポップアップを閉じる
function closeShapeNameEditor() {
    if (editingShapePopup) {
        map.closePopup(editingShapePopup);
    }
    editingShapePopup = null;
    editingShapeLayer = null;
}

// 描画途中のプレビュー図形を地図上から取り除く
function clearDrawPreview() {
    if (drawPreviewLayer) {
        map.removeLayer(drawPreviewLayer);
        drawPreviewLayer = null;
    }
}

// 現在の描画モードに応じてボタン状態を更新する
function updateDrawButtons(container) {
    const buttons = container.querySelectorAll("[data-draw-mode]");
    buttons.forEach(button => {
        button.classList.toggle("is-active", button.dataset.drawMode === activeDrawMode);
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

    const shouldExpand = forceExpanded === null
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
        : (layer.shapeStyle || getDefaultShapeStyle(layer.shapeType));
    const nextStyle = { ...style };
    if (layer.shapeType === "polyline" || isDeleteMode) {
        nextStyle.fill = false;
    }
    layer.setStyle(nextStyle);
}

// すでに描画済みの図形へ現在モードの見た目を反映する
function updateShapesInteractionStyle() {
    drawnShapesGroup.eachLayer(layer => {
        applyShapeStyle(layer, activeDrawMode === "delete");
        if (activeDrawMode === "delete" && typeof layer.bringToFront === "function") {
            layer.bringToFront();
        }
    });
}

// 図形描画中は地図上のカーソルをペン表示へ切り替える
function updateShapeDrawingCursor() {
    const mapContainer = map.getContainer();
    if (!mapContainer) {
        return;
    }
    mapContainer.classList.toggle("is-shape-drawing", Boolean(activeDrawMode));
}

// 描画中の内部状態を初期化して通常状態へ戻す
function resetDrawingState(message = "図形描画: オフ", isError = false) {
    activeDrawMode = null;
    drawPoints = [];
    rectangleStartLatLng = null;
    circleStartLatLng = null;
    clearDrawPreview();
    updateShapeDrawingCursor();
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
    toggleDrawPanel(true);
    activeDrawMode = mode;
    drawPoints = [];
    rectangleStartLatLng = null;
    circleStartLatLng = null;
    clearDrawPreview();
    updateShapeDrawingCursor();
    if (mode === "rectangle") {
        setDrawStatus("図形描画: 矩形の1点目をクリックしてください。");
    } else if (mode === "circle") {
        setDrawStatus("図形描画: 円の中心をクリックしてください。");
    } else if (mode === "delete") {
        setDrawStatus("図形描画: 削除したい図形をクリックしてください。");
    } else if (mode === "polyline") {
        setDrawStatus("図形描画: 線の頂点をクリックし、完了を押してください。");
    } else {
        setDrawStatus("図形描画: 面の頂点をクリックし、完了を押してください。");
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
        dashArray: "6,4"
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
    if (!Array.isArray(latLngs)) {
        return [];
    }
    if (latLngs.length === 0) {
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
// 混雑時に隣接線分をまとめた計測ラベルを作る
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
            .filter(segment => segment.start && segment.end);
        measurementSegments = segments;

        if (isMeasurementSegmentMerged) {
            markers.push(...createGroupedSegmentMeasurementMarkers(segments));
        } else {
            segments.forEach(segment => {
                markers.push(
                    createMeasurementLabelMarker(
                        getSegmentMidpoint(segment.start, segment.end),
                        [formatDistance(segment.distance)]
                    )
                );
            });
        }

        const summaryLatLng = getShapeLabelLatLng(layer);
        if (summaryLatLng) {
            markers.push(
                createMeasurementLabelMarker(
                    summaryLatLng,
                    [`総延長 ${formatDistance(measurement.totalDistance)}`],
                    "summary-polyline"
                )
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
            .filter(segment => segment.start && segment.end);
        measurementSegments = segments;

        if (isMeasurementSegmentMerged) {
            markers.push(...createGroupedSegmentMeasurementMarkers(segments));
        } else {
            segments.forEach(segment => {
                markers.push(
                    createMeasurementLabelMarker(
                        getSegmentMidpoint(segment.start, segment.end),
                        [formatDistance(segment.distance)]
                    )
                );
            });
        }

        const summaryLatLng = getShapeLabelLatLng(layer);
        if (summaryLatLng) {
            const summaryVariant = layer.shapeType === "rectangle"
                ? "summary-rectangle"
                : "summary";
            markers.push(
                createMeasurementLabelMarker(
                    summaryLatLng,
                    [`面積 ${formatArea(measurement.area)}`],
                    summaryVariant
                )
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
                        `面積 ${formatArea(measurement.area)}`
                    ],
                    "summary-circle"
                )
            );
        }
    }

    if (isMeasurementSegmentMerged) {
        markers.push(...createGroupedSegmentEndpointMarkers(measurementSegments, layer));
    } else {
        getMeasurementVertexLatLngs(layer).forEach(latLng => {
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
    markers.forEach(marker => {
        drawnShapesGroup.addLayer(marker);
        setMeasurementMarkerVisibility(marker, isMeasurementVisible);
    });
}

// 計測ラベルを図形グループから取り除く
function removeShapeMeasurementMarkers(layer) {
    if (!layer || !Array.isArray(layer.measurementMarkers)) {
        return;
    }

    layer.measurementMarkers.forEach(marker => {
        drawnShapesGroup.removeLayer(marker);
    });
    layer.measurementMarkers = [];
}

// 画面上の辺長に応じて図形の計測ラベルを再生成する
function refreshShapeMeasurementMarkers(layer) {
    if (!layer || !layer.shapeType || layer.isMeasurementLabel === true) {
        return;
    }

    removeShapeMeasurementMarkers(layer);
    attachShapeMeasurementMarkers(layer);
}

// 表示中の図形計測ラベルをまとめて再生成する
function refreshAllShapeMeasurementMarkers() {
    const shapeLayers = [];
    drawnShapesGroup.eachLayer(layer => {
        if (layer?.shapeType && layer.isMeasurementLabel !== true) {
            shapeLayers.push(layer);
        }
    });

    shapeLayers.forEach(layer => {
        refreshShapeMeasurementMarkers(layer);
    });
}

// 計測ラベルマーカーの表示状態を反映する
// 描画図形グループ内の計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToDrawnShapesGroup() {
    drawnShapesGroup.eachLayer(layer => {
        if (layer?.isMeasurementLabel === true) {
            setMeasurementMarkerVisibility(layer, isMeasurementVisible);
        }
    });
}

// 図形ラベルへ現在の図形色を反映する
function applyShapeLabelStyle(layer) {
    const tooltip = typeof layer?.getTooltip === "function" ? layer.getTooltip() : null;
    const tooltipElement = tooltip && typeof tooltip.getElement === "function"
        ? tooltip.getElement()
        : null;
    if (!tooltipElement) {
        return;
    }

    const shapeColor = normalizeShapeColor(layer?.shapeStyle?.color, SHAPE_STYLE.color);
    tooltipElement.style.borderColor = shapeColor;
    tooltipElement.style.color = shapeColor;
}

// 図形ラベルクリックで名前編集を開けるようイベントを付与する
function attachShapeNameTooltipClick(layer) {
    if (!layer) {
        return;
    }
    const tooltip = typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
    const tooltipElement = tooltip && typeof tooltip.getElement === "function"
        ? tooltip.getElement()
        : null;
    if (!tooltipElement || tooltipElement.dataset.shapeNameClickBound === "true") {
        return;
    }

    tooltipElement.dataset.shapeNameClickBound = "true";
    const openEditorFromLabel = (event) => {
        L.DomEvent.stop(event);
        if (activeDrawMode || isShapeLabelClickSuppressed()) {
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
    const labelClassName = normalizedName ? "shape-name-label" : "shape-name-label is-empty";
    const labelContent = normalizedName ? escapeHtml(normalizedName) : "&nbsp;";
    layer.bindTooltip(
        `<div class="${labelClassName}">${labelContent}</div>`,
        {
            interactive: true,
            permanent: true,
            direction: "center",
            className: "shape-name-tooltip",
        }
    );

    const tooltip = typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
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
    if (!trimmedLayerId || trimmedLayerId === "null" || trimmedLayerId === "None") {
        return null;
    }

    return trimmedLayerId;
}

// 図形編集用に選択可能なレイヤ一覧を取得する
function getEditableShapeLayers() {
    return Object.values(layersFromAxum || {})
        .filter(layerRecord => layerRecord && layerRecord.id && layerRecord.layer_name)
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
    return targetLayer?.layerId || getCurrentShapeLayerId() || getEditableShapeLayers()[0]?.id || "";
}

// レイヤ選択プルダウンの option 群を組み立てる
function buildShapeLayerOptions(selectedLayerId) {
    return getEditableShapeLayers()
        .map(layerRecord => {
            const selected = layerRecord.id === selectedLayerId ? "selected" : "";
            const layerLabel = escapeHtml(layerRecord.layer_name || "名称未設定レイヤ");
            return `<option value="${layerRecord.id}" ${selected}>${layerLabel}</option>`;
        })
        .join("");
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
    layer.shapeStyle = getShapeStyleFromGeoJson(shapeRecord.shape_type, shapeRecord.geojson);
    layer.feature = shapeRecord.geojson;
}

// 図形名と所属レイヤの変更をバックエンドへ保存する
async function persistShapeMetadata(layer, nextName, nextLayerId, nextGeoJson) {
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
            geojson: nextGeoJson,
        }),
    });

    if (!response.ok) {
        throw new Error("shape update failed");
    }
}

// 指定図形のラベル位置に名前編集ポップアップを開く
function openShapeNameEditor(layer) {
    if (!layer || activeDrawMode) {
        return;
    }

    const labelLatLng = getShapeLabelLatLng(layer);
    if (!labelLatLng) {
        return;
    }

    closeShapeNameEditor();
    editingShapeLayer = layer;
    const selectedLayerId = getShapeEditorLayerId(layer);

    // 図形の編集ポップアップ（カラーピッカーはブラウザ標準のカラーピッカーを呼び出して使用）
    const editorPopup = L.popup({
        autoClose: false,
        closeButton: false,
        closeOnClick: false,
        className: "shape-name-editor-popup",
        offset: [0, -6],
    })
        .setLatLng(labelLatLng)
        .setContent(`
            <div class="shape-name-editor">
                <div class="shape-name-editor-title">図形名を編集</div>
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
                <div class="shape-name-editor-help">所属レイヤを変更すると、現在表示中のレイヤ外へ移動した図形はこの画面から消えます。</div>
                <div class="shape-name-editor-actions">
                    <button type="button" class="shape-name-editor-button" id="shape-name-editor-cancel">キャンセル</button>
                    <button type="button" class="shape-name-editor-button" id="shape-name-editor-save">保存</button>
                </div>
            </div>
        `)
        .addTo(map);

    editingShapePopup = editorPopup;

    setTimeout(() => {
        const input = document.getElementById("shape-name-editor-input");
        const layerSelect = document.getElementById("shape-layer-editor-select");
        const colorInput = document.getElementById("shape-color-editor-input");
        const saveButton = document.getElementById("shape-name-editor-save");
        const cancelButton = document.getElementById("shape-name-editor-cancel");
        const popupElement = editingShapePopup && typeof editingShapePopup.getElement === "function"
            ? editingShapePopup.getElement()
            : null;
        if (!input || !layerSelect || !colorInput || !saveButton || !cancelButton || editingShapeLayer !== layer) {
            return;
        }

        if (popupElement) {
            L.DomEvent.disableClickPropagation(popupElement);
            L.DomEvent.disableScrollPropagation(popupElement);
        }

        input.focus();
        input.select();

        const submitEdit = async () => {
            const nextName = normalizeShapeName(input.value);
            const previousLayerId = layer.layerId || layer.options?.shapeRecord?.layer_id || null;
            const nextLayerId = layerSelect.value || getShapeEditorLayerId(layer);
            const nextShapeStyle = buildShapeStyleFromColor(layer.shapeType, colorInput.value);
            const nextGeoJson = buildShapeGeoJson(layer, layer.shapeType, nextShapeStyle);
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

                setDrawStatus("図形描画: 図形名と所属レイヤを更新しました。");
            } catch (_error) {
                setDrawStatus("図形描画: 図形情報の更新に失敗しました。", true);
            }
        };

        saveButton.addEventListener("click", async () => {
            await submitEdit();
        });

        cancelButton.addEventListener("click", () => {
            suppressShapeLabelClick();
            closeShapeNameEditor();
            setDrawStatus("図形描画: 編集をキャンセルしました。");
        });

        input.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                await submitEdit();
            } else if (event.key === "Escape") {
                event.preventDefault();
                suppressShapeLabelClick();
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

// サーバーから渡された図形一覧を地図へ復元する
function restoreSavedShapes() {
    if (!Array.isArray(shapesFromAxum)) {
        return;
    }

    shapesFromAxum.forEach(shape => {
        const shapeStyle = getShapeStyleFromGeoJson(shape.shape_type, shape.geojson);
        const shapeLayer = createLeafletShapeLayer(shape.shape_type, shape.geojson, shapeStyle);
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

    drawnShapesGroup.eachLayer(layer => {
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
        return;
    }

    const deletedShape = {
        layerId: layer.layerId || layer.options?.shapeRecord?.layer_id || null,
        shapeType: layer.shapeType,
        name: layer.shapeName || "",
        geojson: layer.options?.shapeRecord?.geojson
            || buildShapeGeoJson(layer, layer.shapeType, layer.shapeStyle || getDefaultShapeStyle(layer.shapeType)),
    };

    const response = await fetchWithAuth(`/shape/${layer.shapeId}`, {
        method: "DELETE",
    });

    if (!response.ok) {
        throw new Error("shape delete failed");
    }

    removeShapeMeasurementMarkers(layer);
    drawnShapesGroup.removeLayer(layer);
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
    setDrawStatus("図形描画: 削除しました。");
}

// 図形クリック時の削除や編集開始に必要なイベントを付与する
function attachShapeEvents(layer) {
    layer.on("click", async function (event) {
        if (activeDrawMode === "delete") {
            if (event.originalEvent) {
                L.DomEvent.stop(event.originalEvent);
            }

            try {
                await deleteShape(layer);
                resetDrawingState("図形描画: オフ");
            } catch (_error) {
                setDrawStatus("図形描画: 削除に失敗しました。", true);
            }
            return;
        }

        if (activeDrawMode) {
            return;
        }

        return;
    });
}

// 図形を現在レイヤへ保存し、保存後の情報をレイヤへ反映する
async function saveShape(shapeType, layer, shapeName = "", forcedLayerId = null) {
    const targetLayerId = forcedLayerId || getCurrentShapeLayerId();
    if (!targetLayerId) {
        throw new Error("shape layer missing");
    }
    const nextShapeStyle = layer.shapeStyle || buildShapeStyleFromColor(shapeType, getSelectedShapeColor());
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
        deletedShape.name || ""
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
            deletedShape.layerId
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
        shapeLayer.shapeStyle = buildShapeStyleFromColor("polyline", getSelectedShapeColor());
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
        shapeLayer.shapeStyle = buildShapeStyleFromColor("polygon", getSelectedShapeColor());
        try {
            await saveShape("polygon", shapeLayer, shapeName);
            clearShapeNameInput();
            resetDrawingState("図形描画: オフ");
        } catch (_error) {
            resetDrawingState("図形描画: 保存に失敗しました。", true);
        }
    }
}

// 円の描画を確定して保存する
function completeCircleDrawing(targetLatLng) {
    if (!circleStartLatLng) {
        setDrawStatus("図形描画: 円の中心をクリックしてください。", true);
        return;
    }

    const radius = map.distance(circleStartLatLng, targetLatLng);
    if (!(radius > 0)) {
        setDrawStatus("図形描画: 半径が0より大きくなる位置をクリックしてください。", true);
        return;
    }

    closeShapeNameEditor();
    clearDrawPreview();
    const circle = L.circle(circleStartLatLng, {
        ...SHAPE_STYLE,
        radius,
    });
    circle.shapeStyle = buildShapeStyleFromColor("circle", getSelectedShapeColor());

    saveShape("circle", circle, getShapeNameInputValue())
        .then(() => {
            clearShapeNameInput();
            resetDrawingState("図形描画: オフ");
        })
        .catch(() => {
            resetDrawingState("図形描画: 保存に失敗しました。", true);
        });
}

// ツールチップの制御
const TooltipVisibleControl = L.Control.extend({
    options: {
        position: "topright"
    },
    onAdd: function(map) {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");

        // ラジオボタンのHTMLを動的に生成
        const button = L.DomUtil.create("button", "custom-control-button", container);
        button.innerHTML = "マーカー名表示";

        // ボタンのクリックイベント
        L.DomEvent.on(button, "click", function(e) {
            L.DomEvent.stop(e);
            // ここにカスタム機能を実装
            toggleTooltips();
        });

        // Leafletのクリックイベントとの干渉を避ける
        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});

// 地図にタイルコントロールを追加
map.addControl(new TooltipVisibleControl());

// ツールチップの表示・非表示を管理する
let isTooltipVisible = false;

// ツールチップの表示非表示を切り替える関数
// 計測ラベルの表示非表示を切り替える関数
function toggleMeasurementLabels() {
    isMeasurementVisible = !isMeasurementVisible;
    applyMeasurementVisibilityToDrawnShapesGroup();
    updateMeasurementControlState();
}

// 計測コントロールの表示状態を反映する
// 辺を結合する表示へ切り替える
// 指定 ID のマーカーポップアップを開く関数

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
    .then(response => {
        if (!response.ok) {
            throw new Error("Network response was not ok");
        }
        return response.json();
    })
    .then(data => {
        // 必要に応じて、サーバーからのレスポンスを処理する
    })
    .catch(error => {
        console.log('There was a problem with the fetch operation:', error.message);
    });
}

// 地図クリック時にサーバーに情報を送信しマーカー描画
map.on("click", function (e) {
    if (activeDrawMode === "rectangle") {
        if (!rectangleStartLatLng) {
            rectangleStartLatLng = e.latlng;
            setDrawStatus("図形描画: 矩形の2点目をクリックしてください。");
            return;
        }

        closeShapeNameEditor();
        clearDrawPreview();
        const rectangle = L.rectangle(
            L.latLngBounds(rectangleStartLatLng, e.latlng),
            SHAPE_STYLE
        );
        rectangle.shapeStyle = buildShapeStyleFromColor("rectangle", getSelectedShapeColor());

        saveShape("rectangle", rectangle, getShapeNameInputValue())
            .then(() => {
                clearShapeNameInput();
                resetDrawingState("図形描画: オフ");
            })
            .catch(() => {
                resetDrawingState("図形描画: 保存に失敗しました。", true);
            });
        return;
    }

    if (activeDrawMode === "circle") {
        if (!circleStartLatLng) {
            circleStartLatLng = e.latlng;
            setDrawStatus("図形描画: 円周上の点をクリックしてください。");
            return;
        }

        completeCircleDrawing(e.latlng);
        return;
    }

    if (activeDrawMode === "polyline" || activeDrawMode === "polygon") {
        closeShapeNameEditor();
        drawPoints.push(e.latlng);
        setDrawStatus(`図形描画: ${drawPoints.length} 点を追加しました。`);
        return;
    }

    if (activeDrawMode === "delete") {
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
    .then(response => {
        if (!response.ok) {
            throw new Error("Network response was not ok");
        }
        callParentReload();
        return response.json();  // 必要に応じて JSON 形式でレスポンスを受け取る
    })
    .then(data => {
        // サーバーからid, 緯度, 経度を受け取りマーカーとして描画
        var marker = L.marker(e.latlng, {draggable: false})
        .addTo(markersClusterGroup)
        .on("dragend", function(event) {
            var movedMarker = event.target;
            var position = movedMarker.getLatLng();
            updateServer(movedMarker.id, position.lat, position.lng);
        });
        marker.bindPopup("ID: " + data["id"] + "<br>" + "緯度: " + e.latlng.lat + "<br>" + "経度: " + e.latlng.lng).openPopup();
        marker.id = data["id"]
    })
    .catch(error => {
        console.error("There was a problem with the fetch operation:", error.message);
    });
});

map.on("mousemove", function (e) {
    if (!activeDrawMode) {
        return;
    }

    clearDrawPreview();

    if (activeDrawMode === "rectangle") {
        if (!rectangleStartLatLng) {
            return;
        }
        drawPreviewLayer = L.rectangle(
            L.latLngBounds(rectangleStartLatLng, e.latlng),
            {
                ...buildShapeStyleFromColor("rectangle", getSelectedShapeColor()),
                dashArray: "6,4"
            }
        ).addTo(map);
        return;
    }

    if (activeDrawMode === "circle") {
        if (!circleStartLatLng) {
            return;
        }
        const circlePreviewLayer = createPreviewLayer("circle", [circleStartLatLng, e.latlng]);
        if (!circlePreviewLayer) {
            return;
        }
        drawPreviewLayer = circlePreviewLayer.addTo(map);
        return;
    }

    if (activeDrawMode === "delete" || drawPoints.length === 0) {
        return;
    }

    const previewLatLngs = [...drawPoints, e.latlng];
    drawPreviewLayer = createPreviewLayer(activeDrawMode, previewLatLngs).addTo(map);
});


// モードの説明を切り替える関数
// 閲覧・入力・移動モードに応じて UI とドラッグ可否を切り替える
function handleRadioChange(event) {
    const mode = event.target.value;
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
        console.log("View Mode Changed.")
        modeDescriptionContainer.innerHTML = "閲覧モード: 現在のモードは閲覧のみ可能です。";
        // クラスタ内の全てのマーカーに対してドラッグを無効にする
        markersClusterGroup.eachLayer(function(marker) {
            if (marker.dragging) { // marker.dragging が存在するか確認
                marker.dragging.disable();
            }
        });
    } else if (mode === "input") {
        console.log("Input Mode Changed.")
        modeDescriptionContainer.innerHTML = "入力モード: 現在のモードはマーカーの追加が可能です。";
        markersClusterGroup.eachLayer(function(marker) {
            if (marker.dragging) { // marker.dragging が存在するか確認
                marker.dragging.disable();
            }
        });
    } else if (mode === "edit") {
        console.log("Edit Mode Changed.")
        modeDescriptionContainer.innerHTML = "移動モード: 現在のモードはマーカーの移動が可能です。";
        // クラスタ内の全てのマーカーに対してドラッグを有効にする
        markersClusterGroup.eachLayer(function(marker) {
            if (marker.dragging) { // marker.dragging が存在するか確認
                marker.dragging.enable();
            }
        });
    }
}

// 座標検索
var CodeSearchControl = L.Control.extend({
    options: {
        position: 'topleft'
    },

    onAdd: function(map) {
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        // ラジオボタンのHTMLを作成
        container.innerHTML = `
        <div class="search-zone">
            <input type="text" class="search-input" id="code-input" placeholder="緯度,経度" title="緯度経度を,区切りで入力してください。"><br>
            <button id="code-search-btn" class="custom-search">座標検索</button>
        </div>`;

        const searchBtn = container.querySelector(".custom-search");
        // ボタンのクリックイベント
        L.DomEvent.on(searchBtn, "click", function(e) {
            L.DomEvent.stop(e);
            onSearchCode();
        });

        // Leafletのクリックイベントとの干渉を避ける
        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});

// 緯度経度入力から対象地点へフォーカスする
// 緯度経度が妥当な数値範囲かを判定する
// 地図にカスタムコントロールを追加
map.addControl(new CodeSearchControl());


// 図形描画コントロールの定義
const DrawShapeControl = L.Control.extend({
    options: {
        position: "topleft"
    },
    onAdd: function(map) {
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

        container.querySelector("#draw-toggle-btn").addEventListener("click", () => {
            toggleDrawPanel();
        });

        container.querySelectorAll("[data-draw-mode]").forEach(button => {
            button.addEventListener("click", () => {
                beginDrawing(button.dataset.drawMode);
            });
        });

        container.querySelector("#draw-complete-btn").addEventListener("click", async () => {
            if (activeDrawMode === "rectangle" || activeDrawMode === "circle") {
                const shapeLabel = activeDrawMode === "circle" ? "円" : "矩形";
                setDrawStatus(`図形描画: ${shapeLabel}は2点目をクリックすると保存されます。`, true);
                return;
            }
            if (activeDrawMode === "delete") {
                setDrawStatus("図形描画: 削除モードでは図形をクリックしてください。", true);
                return;
            }
            if (!activeDrawMode) {
                setDrawStatus("図形描画: モードを選択してください。", true);
                return;
            }
            await completeLineOrPolygon();
        });

        container.querySelector("#draw-cancel-btn").addEventListener("click", () => {
            closeShapeNameEditor();
            resetDrawingState("図形描画: キャンセルしました。");
        });

        container.querySelector("#draw-undo-btn").addEventListener("click", async () => {
            await undoDeletedShape();
        });

        updateUndoButtonState();
        toggleDrawPanel(false);

        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});

map.addControl(new DrawShapeControl());
restoreSavedShapes();
drawnShapesGroup.addTo(map);
applyMeasurementVisibilityToDrawnShapesGroup();
const shapeLayersControl = L.control.layers(null, { "図形": drawnShapesGroup }, { collapsed: false });
shapeLayersControl.addTo(map);
map.on("overlayadd", function (event) {
    if (event.layer !== drawnShapesGroup) {
        return;
    }

    setTimeout(() => {
        bindVisibleShapeLabelEvents();
        applyMeasurementVisibilityToDrawnShapesGroup();
    }, 0);
});
// 測定結果ラベル表示・非表示コントロールの定義
const MeasurementVisibleControl = L.Control.extend({
    options: {
        position: "topleft"
    },
    onAdd: function(map) {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control measurement-control");
        const button = L.DomUtil.create("button", "custom-control-button", container);
        button.innerHTML = "図形の計測";
        const mergeButton = L.DomUtil.create("button", "custom-control-button is-hidden", container);
        mergeButton.id = "measurement-merge-toggle-btn";
        mergeButton.type = "button";
        mergeButton.innerHTML = "辺を結合";
        mergeButton.setAttribute("aria-pressed", "false");

        L.DomEvent.on(button, "click", function(e) {
            L.DomEvent.stop(e);
            toggleMeasurementLabels();
        });

        L.DomEvent.on(mergeButton, "click", function(e) {
            L.DomEvent.stop(e);
            toggleMeasurementSegmentMerge();
        });

        L.DomEvent.disableClickPropagation(container);
        updateMeasurementControlState();
        return container;
    }
});

map.addControl(new MeasurementVisibleControl());

// 指定地点へ地図を移動し、必要ならマーカーを強調表示する
function onFocusMarker(markerId, lat, lng) {
    if (lat === "" || lng == "") {
        console.log("Not value.");
        return;
    }
    if (isValidCoordinate(lat, lng)) {
        let latLng = new L.LatLng(lat, lng);
        map.setView(latLng, 18);
        openMarkerPopup(markerId);
    }
}
// iframe内でマーカーIDと座標を受け取る
window.addEventListener("message", function(event) {
    const allowOrigins = [
        "http://localhost:5173",
        "http://localhost:3000",
    ];

    const isSameOrigin = event.origin === window.location.origin;

    if (allowOrigins.includes(event.origin) || isSameOrigin) {
        const messageData = event.data;
        if (messageData["type"] === "focus") {
            onFocusMarker(messageData["id"], messageData["lat"], messageData["lng"]);
        }
    }
});

// 親ウィンドウへ画像プレビュー表示要求を送る
function callParent(filename) {
    window.parent.postMessage({ type: "callParentFunction", message: filename }, "*");
}

// 親ウィンドウへ再読み込み要求を送る
function callParentReload(layerId = null) {
    window.parent.postMessage({
        type: "callParentReload",
        message: "Reload",
        layerId: layerId,
    }, "*");
}

// 親ウィンドウへログイン画面遷移要求を送る
function callParentLogin() {
    window.parent.postMessage({ type: "callParentLoginRedirect", message: "Token expired" }, "*");
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
            body: JSON.stringify({  }),
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
