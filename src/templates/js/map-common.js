// Shared map helpers used by map and temporary map templates.

// This file is intentionally non-module so existing inline template scripts can use globals.



function extractYouTubeId(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const host = url.hostname.toLowerCase();
        const allowYouTubeList = [
            "www.youtube.com",
            "youtube.com",
            "m.youtube.com",
            "youtu.be",
            "www.youtube-nocookie.com"
        ]
        if (!allowYouTubeList.includes(host)) return null;

        // shorts / watch / youtu.be に対応
        if (host === "youtu.be") {
            const id = url.pathname.slice(1);
            return ID_RE.test(id) ? id : null;
        };
        if (url.pathname.startsWith("/shorts/")) {
            const id = url.pathname.split("/")[2] ?? "";
            return ID_RE.test(id) ? id : null;
        };
        if (url.pathname === "/watch") {
            const id = url.searchParams.get("v") ?? "";
            return ID_RE.test(id) ? id : null;
        };
        if (url.pathname.startsWith("/embed/")) {
            const id = url.pathname.split("/")[2] ?? "";
            return ID_RE.test(id) ? id : null;
        };
        return null;
    } catch { return null; }
}

function normalizeShapeName(name) {
    if (typeof name !== "string") {
        return "";
    }
    return name.trim();
}

function normalizeShapeColor(color, fallback = SHAPE_STYLE.color) {
    if (typeof color !== "string") {
        return fallback;
    }

    const trimmedColor = color.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmedColor)) {
        return trimmedColor.toLowerCase();
    }

    if (/^#[0-9a-fA-F]{3}$/.test(trimmedColor)) {
        const expandedColor = trimmedColor
            .slice(1)
            .split("")
            .map(value => value + value)
            .join("");
        return `#${expandedColor}`.toLowerCase();
    }

    return fallback;
}

function getDefaultShapeStyle(shapeType) {
    if (shapeType === "polyline") {
        return {
            color: SHAPE_STYLE.color,
            weight: SHAPE_STYLE.weight,
            fill: false,
        };
    }

    return {
        color: SHAPE_STYLE.color,
        weight: SHAPE_STYLE.weight,
        fillColor: SHAPE_STYLE.color,
        fillOpacity: SHAPE_STYLE.fillOpacity,
    };
}

function getShapeStyleFromGeoJson(shapeType, geojson) {
    const defaultStyle = getDefaultShapeStyle(shapeType);
    const styleRecord = geojson?.properties?.style;
    if (!styleRecord || typeof styleRecord !== "object") {
        return defaultStyle;
    }

    const nextColor = normalizeShapeColor(styleRecord.color, defaultStyle.color);
    const nextWeight = Number(styleRecord.weight);
    if (shapeType === "polyline") {
        return {
            color: nextColor,
            weight: Number.isFinite(nextWeight) ? nextWeight : defaultStyle.weight,
            fill: false,
        };
    }

    const nextFillOpacity = Number(styleRecord.fillOpacity);
    return {
        color: nextColor,
        weight: Number.isFinite(nextWeight) ? nextWeight : defaultStyle.weight,
        fillColor: nextColor,
        fillOpacity: Number.isFinite(nextFillOpacity)
            ? nextFillOpacity
            : defaultStyle.fillOpacity,
    };
}

function getCircleRadiusFromGeoJson(geojson) {
    const radius = Number(geojson?.properties?.radius);
    return Number.isFinite(radius) && radius > 0 ? radius : null;
}

function getPolylineCenterLatLng(layer) {
    const latLngs = flattenShapeLatLngs(layer.getLatLngs());
    if (latLngs.length === 0) {
        return null;
    }
    if (latLngs.length === 1) {
        return latLngs[0];
    }

    let totalDistance = 0;
    for (let i = 1; i < latLngs.length; i += 1) {
        totalDistance += map.distance(latLngs[i - 1], latLngs[i]);
    }

    if (totalDistance === 0) {
        return latLngs[Math.floor(latLngs.length / 2)];
    }

    const targetDistance = totalDistance / 2;
    let accumulatedDistance = 0;
    for (let i = 1; i < latLngs.length; i += 1) {
        const start = latLngs[i - 1];
        const end = latLngs[i];
        const segmentDistance = map.distance(start, end);
        if (accumulatedDistance + segmentDistance >= targetDistance) {
            const ratio = (targetDistance - accumulatedDistance) / segmentDistance;
            return L.latLng(
                start.lat + (end.lat - start.lat) * ratio,
                start.lng + (end.lng - start.lng) * ratio
            );
        }
        accumulatedDistance += segmentDistance;
    }

    return latLngs[Math.floor(latLngs.length / 2)];
}

function formatDistance(distanceInMeters) {
    if (!Number.isFinite(distanceInMeters)) {
        return "-";
    }

    if (distanceInMeters >= 1000) {
        return `${(distanceInMeters / 1000).toFixed(2)} km`;
    }

    if (distanceInMeters >= 100) {
        return `${Math.round(distanceInMeters)} m`;
    }

    return `${distanceInMeters.toFixed(1)} m`;
}

function formatArea(areaInSquareMeters) {
    if (!Number.isFinite(areaInSquareMeters)) {
        return "-";
    }

    if (areaInSquareMeters >= 1000000) {
        return `${(areaInSquareMeters / 1000000).toFixed(2)} km²`;
    }

    return `${Math.round(areaInSquareMeters)} m²`;
}

function trimClosedLatLngs(latLngs) {
    if (!Array.isArray(latLngs) || latLngs.length < 2) {
        return Array.isArray(latLngs) ? [...latLngs] : [];
    }

    const normalizedLatLngs = [...latLngs];
    const first = normalizedLatLngs[0];
    const last = normalizedLatLngs[normalizedLatLngs.length - 1];
    if (first && last && first.lat === last.lat && first.lng === last.lng) {
        normalizedLatLngs.pop();
    }

    return normalizedLatLngs;
}

function measurePolyline(layer) {
    const latLngs = flattenShapeLatLngs(layer?.getLatLngs?.());
    const segments = [];
    let totalDistance = 0;

    for (let i = 1; i < latLngs.length; i += 1) {
        const distance = map.distance(latLngs[i - 1], latLngs[i]);
        segments.push({
            label: `${i}`,
            distance,
        });
        totalDistance += distance;
    }

    return {
        segments,
        totalDistance,
    };
}

function calculateProjectedPolygonArea(latLngs) {
    const vertices = trimClosedLatLngs(latLngs);
    if (vertices.length < 3) {
        return 0;
    }

    let sum = 0;
    for (let i = 0; i < vertices.length; i += 1) {
        const current = map.options.crs.project(vertices[i]);
        const next = map.options.crs.project(vertices[(i + 1) % vertices.length]);
        sum += (current.x * next.y) - (next.x * current.y);
    }

    return Math.abs(sum) / 2;
}

function measureCircle(layer) {
    const radius = Number(layer?.getRadius?.());
    return {
        radius,
        area: Number.isFinite(radius) ? Math.PI * radius * radius : 0,
    };
}

function getSegmentMidpoint(startLatLng, endLatLng) {
    return L.latLng(
        startLatLng.lat + ((endLatLng.lat - startLatLng.lat) / 2),
        startLatLng.lng + ((endLatLng.lng - startLatLng.lng) / 2)
    );
}

function getMeasurementVertexLatLngs(layer) {
    if (!layer) {
        return [];
    }

    if (layer.shapeType === "polyline") {
        return flattenShapeLatLngs(layer.getLatLngs());
    }

    if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
        return trimClosedLatLngs(flattenShapeLatLngs(layer.getLatLngs()));
    }

    return [];
}

function createMeasurementVertexMarker(latLng, layer, emphasized = false) {
    if (!latLng) {
        return null;
    }

    const shapeColor = normalizeShapeColor(layer?.shapeStyle?.color, SHAPE_STYLE.color);
    const marker = L.circleMarker(latLng, {
        color: shapeColor,
        fillColor: emphasized ? shapeColor : "#ffffff",
        fillOpacity: 1,
        interactive: false,
        opacity: 1,
        radius: emphasized ? 5 : 4,
        weight: 2,
    });

    marker.isMeasurementLabel = true;
    marker.isMeasurementVertex = true;
    return marker;
}

function getSegmentGroupCenterLatLng(segments) {
    const validSegments = Array.isArray(segments)
        ? segments.filter(segment => segment?.start && segment?.end)
        : [];
    if (validSegments.length === 0) {
        return null;
    }

    let totalDistance = 0;
    validSegments.forEach(segment => {
        totalDistance += map.distance(segment.start, segment.end);
    });

    if (totalDistance <= 0) {
        return getSegmentMidpoint(validSegments[0].start, validSegments[0].end);
    }

    const targetDistance = totalDistance / 2;
    let accumulatedDistance = 0;
    for (const segment of validSegments) {
        const segmentDistance = map.distance(segment.start, segment.end);
        if (accumulatedDistance + segmentDistance >= targetDistance) {
            const ratio = segmentDistance > 0
                ? (targetDistance - accumulatedDistance) / segmentDistance
                : 0;
            return L.latLng(
                segment.start.lat + ((segment.end.lat - segment.start.lat) * ratio),
                segment.start.lng + ((segment.end.lng - segment.start.lng) * ratio)
            );
        }
        accumulatedDistance += segmentDistance;
    }

    const lastSegment = validSegments[validSegments.length - 1];
    return getSegmentMidpoint(lastSegment.start, lastSegment.end);
}

function createGroupedSegmentMeasurementMarkers(segments) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return [];
    }

    const markers = [];
    for (let i = 0; i < segments.length; i += MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE) {
        const group = segments.slice(i, i + MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE);
        const totalDistance = group.reduce((sum, segment) => {
            return sum + (Number.isFinite(segment.distance) ? segment.distance : 0);
        }, 0);
        const marker = createMeasurementLabelMarker(
            getSegmentGroupCenterLatLng(group),
            [formatDistance(totalDistance)]
        );
        if (marker) {
            markers.push(marker);
        }
    }

    return markers;
}

function createGroupedSegmentEndpointMarkers(segments, layer) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return [];
    }

    const markers = [];
    const seenEndpointKeys = new Set();
    for (let i = 0; i < segments.length; i += MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE) {
        const group = segments.slice(i, i + MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE);
        const endpoints = [group[0]?.start, group[group.length - 1]?.end];
        endpoints.forEach(latLng => {
            if (!latLng) {
                return;
            }

            const endpointKey = `${latLng.lat}:${latLng.lng}`;
            if (seenEndpointKeys.has(endpointKey)) {
                return;
            }

            seenEndpointKeys.add(endpointKey);
            markers.push(createMeasurementVertexMarker(latLng, layer, true));
        });
    }

    return markers;
}

function buildMeasurementLabelHtml(lines, variant = "segment") {
    const classNameMap = {
        segment: "shape-measure-label",
        summary: "shape-measure-label shape-measure-label--summary",
        "summary-polyline": "shape-measure-label shape-measure-label--summary shape-measure-label--summary-polyline",
        "summary-circle": "shape-measure-label shape-measure-label--summary shape-measure-label--summary-circle",
        "summary-rectangle": "shape-measure-label shape-measure-label--summary shape-measure-label--summary-rectangle",
    };
    const className = classNameMap[variant] || classNameMap.segment;
    const lineHtml = lines
        .map(line => `<div class="shape-measure-label-line">${escapeHtml(line)}</div>`)
        .join("");
    return `<div class="${className}">${lineHtml}</div>`;
}

function createMeasurementLabelMarker(latLng, lines, variant = "segment") {
    if (!latLng || !Array.isArray(lines) || lines.length === 0) {
        return null;
    }

    const marker = L.marker(latLng, {
        interactive: false,
        keyboard: false,
        zIndexOffset: 900,
        icon: L.divIcon({
            className: "shape-measure-marker",
            html: buildMeasurementLabelHtml(lines, variant),
        }),
    });

    marker.isMeasurementLabel = true;
    return marker;
}

function setMeasurementMarkerVisibility(marker, visible) {
    if (!marker || marker.isMeasurementLabel !== true) {
        return;
    }

    if (typeof marker.setOpacity === "function") {
        marker.setOpacity(visible ? 1 : 0);
    }

    if (marker.isMeasurementVertex === true && typeof marker.setStyle === "function") {
        marker.setStyle({
            fillOpacity: visible ? 1 : 0,
            opacity: visible ? 1 : 0,
        });
    }

    const markerElement = typeof marker.getElement === "function"
        ? marker.getElement()
        : null;
    if (markerElement) {
        markerElement.style.display = visible ? "" : "none";
    }
}

function createLeafletShapeLayer(shapeType, geojson, shapeStyle) {
    if (shapeType === "circle") {
        const coordinates = geojson?.geometry?.coordinates;
        const radius = getCircleRadiusFromGeoJson(geojson);
        if (!Array.isArray(coordinates) || coordinates.length < 2 || !radius) {
            return null;
        }
        return L.circle(
            L.latLng(coordinates[1], coordinates[0]),
            {
                ...shapeStyle,
                radius,
            }
        );
    }

    const geoJsonLayer = L.geoJSON(geojson, {
        style: () => shapeStyle
    });
    const layers = geoJsonLayer.getLayers();
    return layers.length === 0 ? null : layers[0];
}

function toggleTooltips () {
    if (isTooltipVisible) {
        map.eachLayer(function (layer) {
            if (layer.getTooltip) {
                var tooltip = layer.getTooltip();
                if (tooltip) {
                    map.closeTooltip(tooltip);
                }
            }
        });
        isTooltipVisible = false;
    } else {
        map.eachLayer(function (layer) {
            if (layer.getTooltip) {
                layer.openTooltip();
            }
        });
        isTooltipVisible = true;
    }
}

function updateMeasurementControlState() {
    const mergeButton = document.getElementById("measurement-merge-toggle-btn");
    if (mergeButton) {
        mergeButton.classList.toggle("is-hidden", !isMeasurementVisible);
        mergeButton.classList.toggle("is-active", isMeasurementSegmentMerged);
        mergeButton.setAttribute("aria-pressed", isMeasurementSegmentMerged ? "true" : "false");
    }
}

function toggleMeasurementSegmentMerge() {
    isMeasurementSegmentMerged = !isMeasurementSegmentMerged;
    refreshAllShapeMeasurementMarkers();
    updateMeasurementControlState();
}

function onSearchCode () {
    const latLng = document.getElementById("code-input").value;
    const cleandLatLng = latLng.replace(/[()\s]/g, "");
    const parts = cleandLatLng.split(",");
    if (parts.length === 2) {
        const lat = parts[0];
        const lng = parts[1];
        if (lat === "" || lng == "") {
            console.log("Not value.");
            return;
        }
        if (isValidCoordinate(lat, lng)) {
            let latLng = new L.LatLng(lat, lng);
            map.setView(latLng, 14);

            // カスタムアイコン
            let newIcon = L.icon({
                iconUrl: "/assets/marker.png",
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowUrl: null
            });

            L.marker([lat, lng], { icon: newIcon }).addTo(map)
                .bindPopup(`緯度：${lat}<br>経度：${lng}`)
                .openPopup();
            return;

        } else {
            console.log("Not value.");
            return;
        }
    } else {
        console.log("Value error.");
        return;
    }
}

function isValidCoordinate(lat, lng) {
    return !isNaN(lat) && lat >= -90 && lat <= 90 && !isNaN(lng) && lng >= -180 && lng <= 180;
}



function renderIframe(html) {
    return html.replace(
        /<app-youtube\s+[^>]*video-id=["']([\w-]{11})["'][^>]*>(?:<\/app-youtube>)?/g,
        (_, videoId) => {
            const src = `https://www.youtube-nocookie.com/embed/${videoId}`;
            return `
                <iframe
                    src="${src}"
                    title="YouTube video player"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin"
                    allowfullscreen
                    width="100%" height="315"
                    style="border:0;"
                ></iframe>
            `.trim();
        }
    );
}

function createNestedTokenizer(typeName) {
    const self = this.lexer;
    return {
        name: typeName,
        level: "block",
        start(src) {
            const re = new RegExp(`^:::${typeName}\\s`, "m");
            return src.match(re)?.index;
        },
        tokenizer(src, tokens) {
            if (!src.startsWith(`:::${typeName}`)) return null;

            const lines = src.split(/\r?\n/);
            let nestLevel = 0;
            let endIndex = -1;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (/^:::(\w+)/.test(line)) {
                    nestLevel++;
                } else if (/^:::\s*$/.test(line)) {
                    nestLevel--;
                    if (nestLevel === 0) {
                        endIndex = i;
                        break;
                    }
                }
            }

            if (endIndex === -1) return null;

            const rawLines = lines.slice(0, endIndex + 1);
            const raw = rawLines.join("\n");

            const titleMatch = lines[0].match(new RegExp(`^:::${typeName}\\s+(.+)`));
            const title = titleMatch ? titleMatch[1].trim() : typeName.toUpperCase();

            const content = lines.slice(1, endIndex).join("\n");

            return {
                type: typeName,
                raw,
                title,
                tokens: this.lexer.blockTokens(content),
            };
        },
        renderer(token) {
            const body = marked.parser(token.tokens);
            if (token.type === "details") {
                return `<details class="details">\n<summary>${token.title}</summary>\n${body}\n</details>\n`;
            } else {
                return `<div class="box ${token.type}">\n<summary>${token.title}</summary>\n${body}\n</div>\n`;
            }
        },
    };
}

function isLocalhost(url) {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "[::1]";
    } catch (e) {
        return false;
    }
}

function isPDF(filename) {
    return /\.pdf$/i.test(filename);
}

function setupDetailsLazyImages(root=document) {
    const detailsList = root.querySelectorAll(".details");

    detailsList.forEach(details => {
        if (details.hasAttribute("data-lazy-img-initialized")) return;

        details.setAttribute("data-lazy-img-initialized", "true");

        // 初期化処理: src -> data-srcへ退避
        const resources = details.querySelectorAll("img[src], video[src]");
        resources.forEach(element => {
            const src = element.getAttribute("src");
            if (src) {
                element.setAttribute("data-src", src);
                element.removeAttribute("src");
            }
        });

        // toggleイベントで開かれたとき、自分の直下（= ネストしたdetails内は含めない）だけを処理
        details.addEventListener("toggle", () => {
            if (!details.open) return;

            // 自分の中のすべてのimg/videoを取得するが、閉じたこのdetailsの中にあるものは除外
            const childDetails = details.querySelectorAll(".details");

            // 画像と動画の処理を共通化
            const loadVisibleMedia = (selector) => {
                const elements = details.querySelectorAll(selector);
                elements.forEach(el => {
                    // elが閉じた子detailsの中に含まれるならスキップ
                    for (const child of childDetails) {
                        if (!child.open && child.contains(el)) return;
                    }
                    if (!el.getAttribute("src") && el.getAttribute("data-src")) {
                        el.setAttribute("src", el.getAttribute("data-src"));
                    }
                });
            };

            loadVisibleMedia("img[data-src]");
            loadVisibleMedia("video[data-src]");
        });
    });
}

function handleTileChange(event) {
    // 現在のレイヤーを削除
    map.removeLayer(tileLayer);

    // 選択されたタイル情報を取得
    const selectedTile = tileServers[event.target.value]

    // タイルサーバーのフラグに基づいてsetMaxBoundsを設定または解除
    if (selectedTile && selectedTile.include_foreign_tiles) {
        map.setMaxBounds(null); // 制限を解除
    } else {
        map.setMaxBounds(bounds); // 制限を設定
    }

    // 新しいタイルレイヤーを設定
    tileLayer = L.tileLayer(selectedTile.url, {
        minZoom: selectedTile.min_zoom ?? 5,
        maxZoom: selectedTile.max_zoom ?? 18,
        attribution: selectedTile.attribution
    }).addTo(map);
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function openMarkerPopup(markerId) {
    if (markers[`marker-${markerId}`]) {
        // 新しいdivIconの定義
        let newIcon = L.icon({
            iconUrl: "/assets/marker.png", // 新しいアイコンの画像のパス
            iconSize: [25, 41],    // アイコンのサイズ
            iconAnchor: [12, 41],  // アイコンのアンカーポイント
            popupAnchor: [1, -34], // ポップアップのアンカーポイント
            shadowUrl: null
        });
        // アイコンの変更
        markers[`marker-${markerId}`].setIcon(newIcon);
        markers[`marker-${markerId}`].openPopup();
    }
}
