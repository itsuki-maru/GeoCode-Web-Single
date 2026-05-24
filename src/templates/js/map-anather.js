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
// app-youtubeからiframeに置換（埋め込み要素を含む HTML を表示用に整形）;

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
// 対象ファイルが PDF かどうかを判定
// ダウンロード可能ファイルであるか検証
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

// detailsタグ内の img タグと video タグ内のネットワークコンテンツを遅延読み込みさせる処理
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


var map = L.map(
    "map",
    {
        center: [37.650000, 138.000000],
        crs: L.CRS.EPSG3857,
        zoom: 6,
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
// 指定 ID のマーカーポップアップを開く
// クラスターグループを管理するオブジェクト
const clusterGroups = {};
// マーカーにIDを振るためのオブジェクト
let markers = {};
// レイヤー名を格納するオブジェクト
let layerNames = {};

// 図形描画グループ
const drawnShapesGroup = L.featureGroup();
const shapeGroups = {};
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;

// 図形のスタイル
const SHAPE_STYLE = {
    color: "#d94841",
    weight: 3,
    fillColor: "#d94841",
    fillOpacity: 0.16
};
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;

// レイヤー名のマッピング
for (const key in layersFromAxum) {
    if (!layerNames[layersFromAxum[key]["id"]]) {
        layerNames[layersFromAxum[key]["id"]] = layersFromAxum[key]["layer_name"];
    }
}

// レイヤ単位のマーカーグループを必要に応じて生成する
function createMarkerGroupForLayer(layerId) {
    if (!layerId) {
        return null;
    }

    if (!clusterGroups[layerId]) {
        if (isCluster) {
            clusterGroups[layerId] = L.markerClusterGroup();
        } else {
            clusterGroups[layerId] = L.featureGroup();
        }
    }

    return clusterGroups[layerId];
}

// データごとにクラスターグループを作成
for (const key in markersFromAxum) {
    // layer_id ごとに markerClusterGroup を作成する
    createMarkerGroupForLayer(markersFromAxum[key]["layer_id"]);

    // マーカーを作成してクラスターグループに追加する
    const marker = L.marker([markersFromAxum[key]["latitude"], markersFromAxum[key]["longitude"]]).bindPopup(markersFromAxum[key]["marker_name"]);

    // ポップアップオープン時に遅延読み込みの処理を追加
    marker.on("popupopen", () => {
        setupDetailsLazyImages(document);
    });

    clusterGroups[markersFromAxum[key]["layer_id"]].addLayer(marker);

    if (!markersFromAxum[key]["marker_name"]) {
        marker.bindTooltip(`<div class="custom-tooltip">No Name</div>`, {permanent: false});
    } else {
        marker.bindTooltip(`<div class="custom-tooltip">${markersFromAxum[key]["marker_name"]}</div>`, {permanent: false});
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
        markerIcon.id = `marker-${markersFromAxum["id"]}`;
    }
    markers[`marker-${markersFromAxum["id"]}`] = marker;
}

if (Array.isArray(shapesFromAxum)) {
    shapesFromAxum.forEach(shape => {
        createMarkerGroupForLayer(shape.layer_id);
    });
}

// すべてのクラスターグループ及びマーカーグループを地図に追加する 初期値でチェックとする場合はコメントアウトを解除
//Object.values(clusterGroups).forEach(group => group.addTo(map));

// L.control.layers にクラスターグループを追加する
const layersControl = L.control.layers(null, null, { collapsed: false });

// クラスターグループの名前を設定して、レイヤーコントロールに追加する
for (const layer_id in clusterGroups) {
    const layerName = layerNames[layer_id];
    layersControl.addOverlay(clusterGroups[layer_id], layerName);
}

layersControl.addTo(map);

// HTMLエスケープを行う関数
// ラベルやポップアップ表示用に HTML をエスケープする
// 図形名を表示しやすい形に正規化する関数
// 図形色を #RRGGBB 形式へ正規化する
// 図形種別ごとの既定スタイルを返す
// GeoJSON から図形スタイルを取り出す
// GeoJSON に保存された円の半径を取り出す
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

// 図形を全体管理グループとレイヤ別グループへ登録する
function addShapeLayerToManagedGroups(layer, layerId) {
    if (!layer) {
        return;
    }

    drawnShapesGroup.addLayer(layer);
    const targetShapeGroup = ensureShapeGroup(layerId);
    if (targetShapeGroup) {
        targetShapeGroup.addLayer(layer);
    }
}

// マーカーグループから対応するレイヤ ID を逆引きする
function findLayerIdByMarkerGroup(targetGroup) {
    for (const layerId in clusterGroups) {
        if (clusterGroups[layerId] === targetGroup) {
            return layerId;
        }
    }

    return null;
}

// 指定レイヤのチェック状態に合わせて図形表示を同期する
function syncShapeGroupVisibility(layerId) {
    if (!layerId || !shapeGroups[layerId]) {
        return;
    }

    if (map.hasLayer(clusterGroups[layerId])) {
        if (!map.hasLayer(shapeGroups[layerId])) {
            shapeGroups[layerId].addTo(map);
        }

        shapeGroups[layerId].eachLayer(layer => {
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
    Object.keys(shapeGroups).forEach(layerId => {
        syncShapeGroupVisibility(layerId);
    });
}

// 図形のスタイル適用
function applyShapeStyle(layer) {
    if (!layer || typeof layer.setStyle !== "function") {
        return;
    }

    const nextStyle = { ...(layer.shapeStyle || getDefaultShapeStyle(layer.shapeType)) };
    layer.setStyle(nextStyle);
}

// 図形の座標を平坦化
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

// ポリラインの中心座標を取得
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
// ポリゴン/短形の各辺距離・周長・面積を計算する
function measurePolygon(layer) {
    const latLngs = trimClosedLatLngs(flattenShapeLatLngs(layer?.getLatLngs?.()));
    const edges = [];
    let perimeter = 0;

    for (let i = 0; i < latLngs.length; i += 1) {
        const start = latLngs[i];
        const end = latLngs[(i + 1) % latLngs.length];
        const distance = map.distance(start, end);
        edges.push({
            label: `${i + 1}`,
            distance,
        });
        perimeter += distance;
    }

    return {
        edges,
        perimeter,
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
        markers.forEach(marker => {
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
    layer.measurementMarkers.forEach(marker => {
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
    Object.keys(shapeGroups).forEach(layerId => {
        shapeGroups[layerId].eachLayer(layer => {
            if (layer?.shapeType && layer.isMeasurementLabel !== true) {
                shapeLayers.push(layer);
            }
        });
    });

    shapeLayers.forEach(layer => {
        refreshShapeMeasurementMarkers(layer);
    });
}

// 計測ラベルマーカーの表示状態を反映する
// 指定レイヤ内の計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToShapeGroup(layerId) {
    if (!layerId || !shapeGroups[layerId]) {
        return;
    }

    shapeGroups[layerId].eachLayer(layer => {
        if (layer?.isMeasurementLabel === true) {
            setMeasurementMarkerVisibility(layer, isMeasurementVisible);
        }
    });
}

// すべての計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToAllShapeGroups() {
    Object.keys(shapeGroups).forEach(layerId => {
        applyMeasurementVisibilityToShapeGroup(layerId);
    });
}

// 図形のラベル名を更新
function updateShapeNameLabel(layer, name) {
    if (!layer) {
        return;
    }

    const normalizedName = normalizeShapeName(name);
    layer.shapeName = normalizedName;

    if (typeof layer.unbindTooltip === "function") {
        layer.unbindTooltip();
    }

    if (typeof layer.bindTooltip !== "function") {
        return;
    }

    const labelLatLng = getShapeLabelLatLng(layer);
    const labelClassName = normalizedName ? "shape-name-label" : "shape-name-label is-empty";
    const labelContent = normalizedName ? escapeHtml(normalizedName) : "&nbsp;";
    const labelColor = normalizeShapeColor(
        layer.shapeStyle ? layer.shapeStyle.color : null,
        SHAPE_STYLE.color
    );
    layer.bindTooltip(
        `<div class="${labelClassName}" style="background:rgba(255,255,255,0.92);border:1px solid ${labelColor};border-radius:999px;color:${labelColor};display:inline-block;padding:2px 8px;">${labelContent}</div>`,
        {
            interactive: false,
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
    const applyTooltipBorderColor = () => {
        const tooltipElement = tooltip && typeof tooltip.getElement === "function"
            ? tooltip.getElement()
            : null;
        if (!tooltipElement) {
            return;
        }
        tooltipElement.style.setProperty("background", "transparent", "important");
        tooltipElement.style.setProperty("border", "none", "important");
        tooltipElement.style.setProperty("box-shadow", "none", "important");
        tooltipElement.style.setProperty("padding", "0", "important");
        tooltipElement.style.setProperty("color", labelColor, "important");
    };
    applyTooltipBorderColor();
    setTimeout(applyTooltipBorderColor, 0);
}

// 形状タイプと GeoJSON から Leaflet レイヤを生成する
// GeoJSON から描画用の図形レイヤを生成する
function createShapeLayer(shapeType, geojson, shapeName = "") {
    const shapeStyle = getShapeStyleFromGeoJson(shapeType, geojson);
    const layer = createLeafletShapeLayer(shapeType, geojson, shapeStyle);
    if (!layer) {
        return null;
    }

    layer.shapeType = shapeType;
    layer.shapeStyle = shapeStyle;
    applyShapeStyle(layer);
    updateShapeNameLabel(layer, shapeName);
    return layer;
}

// サーバーから渡された図形一覧を地図へ復元する
function restoreSavedShapes() {
    if (!Array.isArray(shapesFromAxum)) {
        return;
    }

    shapesFromAxum.forEach(shape => {
        const shapeStyle = getShapeStyleFromGeoJson(shape.shape_type, shape.geojson);
        const layer = createLeafletShapeLayer(shape.shape_type, shape.geojson, shapeStyle);
        if (!layer) {
            return;
        }

        layer.shapeId = shape.id;
        layer.layerId = shape.layer_id || null;
        layer.shapeType = shape.shape_type;
        layer.shapeName = shape.name || "";
        layer.shapeStyle = shapeStyle;
        applyShapeStyle(layer);
        updateShapeNameLabel(layer, shape.name || "");
        addShapeLayerToManagedGroups(layer, shape.layer_id);
        attachShapeMeasurementMarkers(layer, shape.layer_id);
    });

    syncAllShapeGroupsVisibility();
}

restoreSavedShapes();
map.on("overlayadd", function (event) {
    const layerId = findLayerIdByMarkerGroup(event.layer);
    if (!layerId) {
        return;
    }

    setTimeout(() => {
        syncShapeGroupVisibility(layerId);
    }, 0);
});
map.on("overlayremove", function (event) {
    const layerId = findLayerIdByMarkerGroup(event.layer);
    if (!layerId) {
        return;
    }

    syncShapeGroupVisibility(layerId);
});

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

// マーカー名表示・非表示コントロールツールチップの定義
const TooltipVisibleControl = L.Control.extend({
    options: {
        position: "topleft"
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

// 地図に測定結果ラベルコントロールを追加
map.addControl(new MeasurementVisibleControl());


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
// 親ウィンドウへファイル表示要求を送る
function callParent(filename) {
    window.parent.postMessage({ type: "callParentFunction", message: filename }, "*");
}