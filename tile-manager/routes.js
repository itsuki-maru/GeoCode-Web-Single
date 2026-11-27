(() => {
  'use strict';

  const { displayText } = globalThis.GeoCodeTilePaths;

  const places = ['start', 'end'];
  const colors = { start: '#147557', end: '#9e3448' };
  const count = number => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(number);
  const coordinate = point => point.lat.toFixed(6) + ', ' + point.lon.toFixed(6);
  const valid = point => Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
  const latLng = point => [point.lat, point.lon];
  const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

  function bindRouteHttpForm($, fillSelect, nativeInvoke) {
    const form = $('route-http-form'), enabled = $('route-http-enabled'), dataset = $('route-http-dataset');
    const allow = $('route-http-allow'), origin = $('route-http-origin'), originError = $('route-http-origin-error');
    const status = $('route-http-status'), save = $('route-http-save');
    let saved = null, names = [], origins = [], saving = false;

    function updateControls() {
      enabled.disabled = saving || (!names.length && !enabled.checked && !saved?.enabled);
      dataset.disabled = allow.disabled = saving || !enabled.checked;
      origin.disabled = allow.disabled || !allow.checked;
      const addingOrigin = enabled.checked && allow.checked && !origins.includes(origin.value.trim());
      const changed = saved && (enabled.checked !== saved.enabled || (enabled.checked && dataset.value !== saved.dataset.trim()));
      save.disabled = saving || !saved || (!changed && !addingOrigin) || (enabled.checked && !names.includes(dataset.value));
    }
    function message(value, error = false) {
      status.textContent = value;
      status.hidden = !value;
      status.classList.toggle('error', error);
    }
    function edited() {
      originError.hidden = true;
      origin.removeAttribute('aria-invalid');
      message('');
      updateControls();
    }
    form.addEventListener('input', edited);
    form.addEventListener('change', edited);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled) return;
      const allowOrigin = enabled.checked && allow.checked ? origin.value.trim() : null;
      if (allowOrigin !== null) {
        let url;
        try { url = new URL(allowOrigin); } catch { /* 入力欄にエラーを表示する */ }
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.port === '0'
            || url.origin !== allowOrigin || allowOrigin.includes(',')) {
          originError.textContent = 'パス・認証情報・既定ポートを含まないHTTP(S)のオリジンを小文字で1件指定してください。';
          originError.hidden = false;
          origin.setAttribute('aria-invalid', 'true');
          origin.focus();
          return;
        }
      }
      saving = true;
      updateControls();
      try {
        await nativeInvoke('tile_manager_save_route_http', {
          expected: saved, dataset: enabled.checked ? dataset.value : null, allowOrigin,
        });
        message('配信設定を保存しました。起動中のSingle本体を再起動すると反映されます。');
      } catch (error) {
        message(displayText(typeof error === 'string' ? error : error.message), true);
      } finally {
        saving = false;
        updateControls();
      }
    });

    return function update(routing) {
      const current = routing?.http || { enabled: false, dataset: '' };
      const changed = !saved || saved.enabled !== current.enabled || saved.dataset !== current.dataset;
      const preferred = changed ? current.dataset.trim() : dataset.value;
      if (changed) {
        if (saved && (enabled.checked !== current.enabled || (current.enabled && dataset.value !== current.dataset.trim()))) {
          message('配信設定が更新されました。現在の設定を表示しています。');
        }
        enabled.checked = current.enabled;
        saved = current;
      }
      names = (routing?.datasets || []).map(item => item.name);
      const options = names.map(value => ({ value, label: value }));
      if (preferred && !names.includes(preferred)) options.push({ value: preferred, label: preferred + '（道路網が見つかりません）' });
      fillSelect(dataset, options, preferred, '先に道路網を作成してください');
      origins = (routing?.allowed_origins || '').split(',').map(s => s.trim()).filter(Boolean);
      $('route-http-origins').textContent = origins.length ? '登録済みの許可先　' + origins.join('、') : '許可先は未登録です。';
      $('route-http-current').textContent = current.enabled ? '配信設定は有効です（' + current.dataset + '）' : '配信設定は無効です';
      updateControls();
    };
  }

  globalThis.createOfflineRouteView = function ({ $, fillSelect, profileLabel, element, nativeInvoke, submit, duration, precompute, pathInputValue }) {
    const updateRouteHttp = bindRouteHttpForm($, fillSelect, nativeInvoke);
    let datasets = [], backgrounds = [], graph = null, map, markers, line, tileLayer;
    let selectedBackground = '', target = 'start', revision = 0, activeSearchId = null, hasGraphs;
    const missing = new Set();
    const selected = () => backgrounds.find(item => item.key === selectedBackground);

    function readPoint(place) {
      const point = {};
      for (const axis of ['lat', 'lon']) {
        const raw = $('route-' + place + '-' + axis).value.trim();
        point[axis] = raw.length ? Number(raw) : NaN;
      }
      return valid(point) ? point : null;
    }

    function drawMarkers(result) {
      if (!map) return;
      markers.clearLayers();
      if (line) { line.remove(); line = null; }
      if (result) {
        line = L.polyline(result.geometry.map(latLng), { color: '#2859b1', weight: 5 }).addTo(map);
      }
      for (const place of places) {
        const point = readPoint(place);
        if (!point) continue;
        const label = place === 'start' ? '出発地' : '目的地';
        const color = colors[place];
        const snapped = result?.['snapped_' + place];
        if (snapped) {
          L.polyline([latLng(point), latLng(snapped)], { color, weight: 2, dashArray: '4 4', interactive: false }).addTo(markers);
        }
        L.circleMarker(latLng(point), { radius: 8, color, weight: 2, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(label).addTo(markers);
        if (snapped) {
          L.circleMarker(latLng(snapped), { radius: 4, color, fillOpacity: 1 }).bindTooltip(label + '（道路上）').addTo(markers);
        }
      }
    }

    function invalidate() {
      revision++;
      if (activeSearchId) {
        const search_id = activeSearchId;
        activeSearchId = null;
        // ネイティブ側で検索が完了した直後でも、画面側ではすでにその結果を無効にしている。
        nativeInvoke('tile_manager_query', { action: 'route_search_cancel', payload: { search_id } }).catch(() => {});
      }
      $('route-search').disabled = !graph;
      $('route-result').hidden = true;
      $('route-search-status').textContent = '';
      $('route-search-status').classList.remove('error');
      drawMarkers();
    }

    function chooseTarget(place) {
      target = place;
      for (const key of places) $('route-pick-' + key).setAttribute('aria-pressed', String(key === place));
    }

    function fitGraph() {
      const b = graph?.info?.bounds;
      if (!map || !b || !valid({ lat: b.south, lon: b.west }) || !valid({ lat: b.north, lon: b.east })) return;
      map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [20, 20], maxZoom: 16, animate: false });
    }

    function backgroundStatus() {
      const bg = selected();
      const info = bg?.info?.attribution;
      const extra = (info?.additional || []).map(pair => pair[0]).filter(Boolean);
      const credits = [graph?.info?.attribution, info?.text, ...extra].filter(Boolean);
      $('route-attribution').textContent = [...new Set(credits)].join(' ／ ');
      let message;
      if (!globalThis.L) message = '地図を表示できません。緯度・経度から経路を検索できます。';
      else if (!bg) message = '背景なし。経路と指定地点を表示します。';
      else if (missing.size) message = 'この範囲には表示できないタイルがあります。必要な範囲を事前生成してください。';
      else message = '事前生成済みのタイルを表示します。';
      if (bg?.info?.source_sha256 && graph?.info?.source_sha256 && bg.info.source_sha256 !== graph.info.source_sha256) {
        message += ' 背景と道路網の元PBFが異なります。';
      }
      $('route-map-status').textContent = message;
      $('route-to-precompute').hidden = !bg || !missing.size;
    }

    function setBackground(key) {
      const changed = key !== selectedBackground;
      selectedBackground = key;
      const bg = selected();
      if (changed || (map && bg && !tileLayer)) {
        if (tileLayer) { tileLayer.remove(); tileLayer = null; }
        missing.clear();
        if (map && bg) {
          const layer = L.tileLayer('/preview/' + bg.key + '/{z}/{x}/{y}.png', {
            minZoom: 0, maxZoom: 22, keepBuffer: 0, noWrap: true,
          });
          const keyOf = tile => [tile.z, tile.x, tile.y].join('/');
          layer.on('tileerror', event => {
            if (tileLayer !== layer) return;
            missing.add(keyOf(event.coords)); backgroundStatus();
          });
          layer.on('tileunload', event => {
            if (tileLayer === layer && missing.delete(keyOf(event.coords))) backgroundStatus();
          });
          tileLayer = layer;
          layer.addTo(map);
        }
      }
      backgroundStatus();
    }

    function showMap() {
      if (!graph || $('view-routes').hidden || !globalThis.L) return;
      if (!map) {
        map = L.map($('route-map'), { minZoom: 0, maxZoom: 22, attributionControl: false }).setView([36, 138], 5);
        markers = L.layerGroup().addTo(map);
        map.on('click', event => {
          const point = event.latlng.wrap();
          $('route-' + target + '-lat').value = point.lat.toFixed(7);
          $('route-' + target + '-lon').value = point.lng.toFixed(7);
          invalidate();
          if (target === 'start') chooseTarget('end');
        });
        fitGraph();
        setBackground(selectedBackground);
        drawMarkers();
      }
      map.invalidateSize({ pan: false });
    }

    function updateGraph() {
      const next = datasets.find(item => item.id === $('route-dataset').value) || null;
      if (next?.id !== graph?.id) {
        graph = next;
        invalidate();
        fitGraph();
      } else graph = next;
      const info = graph?.info;
      const rows = info ? [
        ['元PBFのSHA-256', info.source_sha256], ['作成日時', graph.created_at],
        ['道路の区間', count(info.edge_count) + ' 区間'], ['ノード', count(info.node_count) + ' 点'],
        ['適用した通行制限', count(info.restriction_count) + ' 件'],
        ['保守的に通行を除外した規制', count(info.excluded_restriction_count) + ' 件'],
        ['対象となる道路・地点が道路網にない規制', count(info.outside_restriction_count ?? 0) + ' 件'],
        ['条件付き通行タグのある道路', count(info.conditional_way_count) + ' 本'],
        ['条件付き通行タグのある地点', count(info.conditional_node_count) + ' 点'], ['出典', info.attribution],
      ] : [];
      const signature = JSON.stringify(rows);
      if ($('route-info').dataset.rows !== signature) {
        $('route-info').replaceChildren(...rows.flatMap(([label, value]) => [element('dt', '', label), element('dd', '', value)]));
        $('route-info').dataset.rows = signature;
      }
      $('route-search').disabled = !graph || Boolean(activeSearchId);
    }

    function update(snapshot) {
      updateRouteHttp(snapshot.routing);
      const oldId = graph?.id;
      datasets = snapshot.routing?.datasets || [];
      fillSelect($('route-dataset'), datasets.map(item => ({ value: item.id, label: item.name })), oldId, '道路網がありません');
      updateGraph();
      $('route-workspace').hidden = !graph;
      $('route-catalog-error').hidden = !snapshot.routing?.error;
      $('route-catalog-error').textContent = displayText(snapshot.routing?.error || '');
      if (hasGraphs !== Boolean(graph)) {
        $('route-build-panel').open = !graph;
        hasGraphs = Boolean(graph);
      }
      backgrounds = (snapshot.datasets || []).filter(item => !item.retired && !item.error && validId(item.id))
        .flatMap(dataset => (dataset.profiles || []).filter(p => !p.retired && validId(p.id))
          .map(p => ({ key: dataset.id + '/' + p.id, name: dataset.name + ' ／ ' + profileLabel(p), info: dataset.info })));
      const matching = graph?.info?.source_sha256 ? backgrounds.find(bg => bg.info?.source_sha256 === graph.info.source_sha256) : null;
      const preferred = graph?.id !== oldId ? matching?.key || '' : selectedBackground;
      setBackground(fillSelect($('route-background'), [{ value: '', label: '背景なし' },
        ...backgrounds.map(bg => ({ value: bg.key, label: bg.name }))], preferred, '背景なし'));
      showMap();
    }

    $('route-dataset').addEventListener('change', () => {
      updateGraph();
      const matching = backgrounds.find(bg => graph?.info?.source_sha256 && bg.info?.source_sha256 === graph.info.source_sha256);
      $('route-background').value = matching?.key || '';
      setBackground($('route-background').value);
    });
    $('route-background').addEventListener('change', () => setBackground($('route-background').value));
    $('route-mode').addEventListener('change', invalidate);
    for (const place of places) {
      $('route-pick-' + place).addEventListener('click', () => chooseTarget(place));
      for (const axis of ['lat', 'lon']) $('route-' + place + '-' + axis).addEventListener('input', invalidate);
    }
    $('route-swap').addEventListener('click', () => {
      for (const axis of ['lat', 'lon']) {
        const start = $('route-start-' + axis), end = $('route-end-' + axis);
        [start.value, end.value] = [end.value, start.value];
      }
      invalidate();
    });
    $('route-build-form').addEventListener('submit', event => {
      event.preventDefault();
      const input_path = pathInputValue($('route-pbf')), name = $('route-name').value.trim();
      if (input_path && name) submit('route_build', { input_path, name });
    });
    $('route-to-precompute').addEventListener('click', () => {
      const bg = selected();
      if (!map || !bg) return;
      const [dataset, profile] = bg.key.split('/');
      const b = map.getBounds();
      const west = Math.max(-180, b.getWest()), east = Math.min(180, b.getEast());
      const south = Math.max(-85.05112878, b.getSouth()), north = Math.min(85.05112878, b.getNorth());
      if (west < east && south < north) precompute({ dataset, profile, west, south, east, north, zoom: map.getZoom() });
    });
    $('route-search-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!graph || activeSearchId) return;
      invalidate();
      const request = revision;
      const status = $('route-search-status');
      try {
        const start = readPoint('start'), end = readPoint('end');
        if (!start || !end) throw Error('出発地と目的地の緯度・経度を確認してください。');
        activeSearchId = globalThis.crypto.randomUUID();
        $('route-search').disabled = true;
        status.textContent = '経路を検索しています…';
        const result = await nativeInvoke('tile_manager_query', { action: 'route_search', payload: {
          search_id: activeSearchId, dataset: graph.id, mode: $('route-mode').value, start, end,
        } });
        if (request !== revision) return;
        if (!Array.isArray(result?.geometry) || !result.geometry.length || !result.geometry.every(valid)
          || !valid(result.snapped_start) || !valid(result.snapped_end)
          || !Number.isFinite(result.distance_m) || !Number.isFinite(result.duration_s)) throw Error('経路の結果を読み取れません。');
        drawMarkers(result);
        if (map && !$('view-routes').hidden) {
          map.fitBounds([...result.geometry.map(latLng), latLng(start), latLng(end)], { padding: [25, 25], maxZoom: 17, animate: false });
        }
        const distance = result.distance_m >= 1000 ? count(result.distance_m / 1000) + ' km' : count(Math.round(result.distance_m)) + ' m';
        $('route-summary').textContent = ($('route-mode').value === 'car' ? '自動車' : '徒歩') + '　' + distance + ' ／ 概算 ' + duration(result.duration_s);
        $('route-snaps').textContent = '道路上の出発地 ' + coordinate(result.snapped_start) + ' ／ 目的地 ' + coordinate(result.snapped_end);
        $('route-result').hidden = false;
        status.textContent = '経路を表示しました。';
      } catch (error) {
        if (request !== revision) return;
        status.textContent = displayText(typeof error === 'string' ? error : error.message);
        status.classList.add('error');
      } finally {
        if (request === revision) {
          activeSearchId = null;
          $('route-search').disabled = !graph;
        }
      }
    });
    return { update, showMap };
  };
})();
