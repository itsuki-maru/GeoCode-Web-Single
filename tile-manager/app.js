(() => {
  'use strict';

  const ACTIVE_STATES = new Set(['starting', 'queued', 'running', 'cancelling']);
  const STATE_LABELS = {
    starting: '受付中', queued: '待機中', running: '実行中', cancelling: '取消処理中',
    succeeded: '完了', failed: '失敗', cancelled: '取消済み', interrupted: '中断',
    deadline_exceeded: '期限終了',
  };
  const TERMINAL_STAGE_LABELS = {
    succeeded: '処理が完了しました', failed: '処理に失敗しました', cancelled: '処理を取り消しました',
    interrupted: '処理が中断しました', deadline_exceeded: '制限時間を超えたため処理を終了しました',
  };
  const ACTION_LABELS = {
    import: 'PBFの取り込み', precompute: 'タイルの事前生成', resume: '事前生成の再開',
    register: 'データセットの登録', prepare: '描画条件の準備', background: '背景地図への登録',
    rebind: '本体DBの対応付け更新',
  };
  const STAGE_LABELS = {
    NotStarted: '開始を待っています', Validating: '入力を検査しています', Searching: '地物を検索しています',
    Drawing: '地図を描画しています', Encoding: 'PNGへ変換しています',
    ImportPass1: 'PBFを読み取っています（第1段階）', ImportPass2: 'PBFを読み取っています（第2段階）',
    ImportPass3: 'PBFを読み取っています（第3段階）', BuildingGeometry: '地物と縮約形状を作成しています',
    ImportLandmask: '陸域ポリゴンを取り込んでいます', ImportElevation: '標高資料を取り込んでいます',
    BuildingContours: '等高線を作成しています', FinalValidation: '完成データを検査しています',
    Publishing: 'データセットを登録しています', Exporting: 'タイルを事前生成しています', Completed: '処理が完了しました',
    checking: 'DBの整合性と内容を照合しています', backup: 'catalogのバックアップを作成しています',
    before_backup: '更新前の保存先を確認しています', before_commit: '対応付けを更新しています', committing: '対応付けを確定しています', completed: '移設処理が完了しました', saving_proof: '移設記録を保存しています',
  };
  const VIEW_LABELS = {
    import: ['地図を取り込む', '取得済みのPBFから、この端末で使える地図を作成します。'],
    datasets: ['データセット', '取り込んだ地図と、描画条件を管理します。'],
    precompute: ['タイルを事前生成', '必要な範囲のPNGを、あらかじめこの端末へ保存します。'],
    activity: ['処理状況・履歴', '実行中の進捗と、これまでの処理結果を確認します。'],
  };
  const count = value => new Intl.NumberFormat('ja-JP').format(Number(value) || 0);
  const text = value => value == null ? '' : String(value);
  const object = value => value && typeof value === 'object' ? value : {};
  const parseObject = value => {
    if (typeof value !== 'string') return object(value);
    try { return object(JSON.parse(value)); } catch { return {}; }
  };
  const errorMessage = error => typeof error === 'string' ? error : text(error?.message || error || '処理に失敗しました。');
  const shortId = id => id ? `${text(id).slice(0, 12)}…` : '未準備';
  const isActive = state => ACTIVE_STATES.has(state);

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const value = Math.floor(seconds);
    if (value >= 3600) return `${Math.floor(value / 3600)}時間 ${Math.floor(value % 3600 / 60)}分`;
    if (value >= 60) return `${Math.floor(value / 60)}分 ${value % 60}秒`;
    return `${value}秒`;
  }

  function progressView(job, now = Date.now()) {
    const progress = object(job.progress);
    const completed = Number.isFinite(progress.completed) && progress.completed >= 0 ? progress.completed : 0;
    const total = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : null;
    const active = isActive(job.state);
    // 取り込みのcompleted/totalは各段階の値であり、PBF全体の割合にはしない。
    const percentage = job.kind === 'precompute' && total !== null
      ? Math.min(100, Math.max(0, completed / total * 100)) : null;
    const start = Date.parse(job.created_at);
    const end = active ? now : Date.parse(job.updated_at);
    const elapsed = Number.isFinite(progress.elapsed_seconds) ? progress.elapsed_seconds
      : Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 1000 : null;
    let stage = STAGE_LABELS[progress.stage] || text(progress.stage);
    if (job.state === 'queued') stage = '処理を開始できるまで待機しています';
    if (job.state === 'cancelling') stage = '取消を要求しました。実処理の終了を待っています';
    // 終端時のprogress.stageは最後に記録された工程。現在も処理中とは表示しない。
    if (TERMINAL_STAGE_LABELS[job.state]) stage = TERMINAL_STAGE_LABELS[job.state];
    return { active, completed, total, percentage, elapsed, stage: stage || STATE_LABELS[job.state] || text(job.state) };
  }

  function importPayload(values) {
    const features = values.features || 'standard-v2';
    const result = { name: text(values.name).trim(), input_path: text(values.input_path).trim(),
      features, missing_nodes: values.missing_nodes || 'error' };
    if (!result.name || !result.input_path) throw new Error('PBFファイルと地図の名前を指定してください。');
    if (features !== 'roads-v1') {
      const landmask = text(values.landmask_input).trim();
      const elevation = text(values.elevation_input).trim();
      if (landmask) result.landmask_input = landmask;
      if (elevation) result.elevation_input = elevation;
      result.invalid_areas = values.invalid_areas || 'skip-feature';
      if (elevation) result.elevation_datum_policy = values.elevation_datum_policy || 'strict';
      if (features === 'standard-v2') result.contour_data = elevation && values.contour_data ? 'on' : 'off';
    }
    return result;
  }

  function precomputePayload(values) {
    const bbox = ['west', 'south', 'east', 'north'].map(key => {
      const raw = text(values[key]).trim();
      return raw ? Number(raw) : NaN;
    });
    const min = text(values.min_zoom).trim() ? Number(values.min_zoom) : NaN;
    const max = text(values.max_zoom).trim() ? Number(values.max_zoom) : NaN;
    const limit = Number(values.max_tiles);
    if (!values.dataset_id) throw new Error('データセットを選択してください。');
    if (!bbox.every(Number.isFinite) || bbox[0] < -180 || bbox[2] > 180 || bbox[0] >= bbox[2]
      || bbox[1] < -85.05112878 || bbox[3] > 85.05112878 || bbox[1] >= bbox[3]) {
      throw new Error('範囲は、西端＜東端・南端＜北端となる経度・緯度で指定してください。');
    }
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 22 || min > max) {
      throw new Error('ズームは0〜22で、最小ズーム≦最大ズームとなるよう指定してください。');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('生成枚数の上限には1以上の整数を指定してください。');
    const result = { dataset_id: values.dataset_id, bbox, min_zoom: min, max_zoom: max, max_tiles: limit };
    if (values.render_id) result.render_id = values.render_id;
    return result;
  }

  function profileLabel(profile) {
    const info = parseObject(profile.info_json || profile.info);
    const contract = object(info.render_contract);
    const spec = contract.render_spec;
    let label = info.style_version || contract.style_version || '標準の描画条件';
    if (spec) {
      const visible = [['roads', '道路'], ['buildings', '建物'], ['labels', '名称'], ['contours', '等高線'], ['hillshade', '陰影']]
        .filter(([key]) => spec[key]).map(([, name]) => name);
      label = visible.length ? visible.join('・') : '背景のみ';
      if (spec.labels) label += ` ／ ${({ ja: '日本語', en: '英語', local: '現地名称' })[spec.language] || spec.language}`;
    } else {
      label = ({ 'roads-v1': '道路のみ', 'standard-terrain-v1': '標準地形図', 'osm-like-v1': '地名・ランドマーク付き' })[label] || label;
    }
    return `${label} — ${text(profile.id).slice(0, 10)}`;
  }

  function createSubmissionClient(invoke, uuid = () => globalThis.crypto.randomUUID()) {
    let pending = false, attempt = null;
    return {
      get pending() { return pending; },
      async submit(action, payload) {
        if (pending) throw new Error('現在、処理の受付を確認しています。');
        const signature = JSON.stringify([action, payload]);
        if (!attempt || attempt.signature !== signature) attempt = { signature, id: uuid() };
        pending = true;
        try {
          const result = await invoke('tile_manager_submit', { action, payload, requestId: attempt.id });
          attempt = null;
          return result;
        } finally {
          // 応答を受け取れなかった場合は、同じ要求IDで再確認し二重実行を避ける。
          pending = false;
        }
      },
    };
  }

  globalThis.GeoCodeTileManager = Object.freeze({ progressView, importPayload, precomputePayload, profileLabel, createSubmissionClient, duration });
  if (typeof document === 'undefined') return;

  function mount() {
    const $ = id => document.getElementById(id);
    const state = { snapshot: null, view: 'import', selectedDataset: '', profiles: new Map(),
      polling: false, initialized: false, seenRequests: new Map(), plan: null, planSignature: '',
      datasetSignature: '', activitySignature: '', planning: false, initializing: false, settingsOpen: false,
      pendingCancels: new Set(), logRequestId: '', rebindPlan: null, rebinding: false, rebindRevision: 0 };
    const nativeInvoke = async (command, args) => {
      const invoke = globalThis.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error('専用ウィンドウを開けませんでした。local-tiles gui で起動してください。');
      return invoke(command, args);
    };
    const submission = createSubmissionClient(nativeInvoke);
    const element = (tag, className, content) => {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (content !== undefined) result.textContent = text(content);
      return result;
    };
    const setText = (id, value) => { $(id).textContent = text(value); };
    const selectedDataset = () => state.snapshot?.datasets?.find(item => item.id === state.selectedDataset);
    const usableProfiles = dataset => (dataset?.profiles || []).filter(item => !item.retired);
    const selectedProfile = () => state.profiles.get(state.selectedDataset) || '';
    const pendingRequests = () => (state.snapshot?.requests || []).filter(item => isActive(item.state));
    const ownerBusy = () => state.snapshot?.owner_available === false || pendingRequests().length > 0;
    const canWrite = () => state.snapshot?.configured && !state.snapshot?.error && !submission.pending && !ownerBusy();

    function notify(message, error = false) {
      setText('notice-text', message);
      $('notice').classList.toggle('error', error);
      $('notice').hidden = false;
    }
    function showView(view) {
      if (!VIEW_LABELS[view]) return;
      state.view = view;
      for (const [name] of Object.entries(VIEW_LABELS)) $(`view-${name}`).hidden = name !== view;
      for (const button of document.querySelectorAll('#navigation [data-view]')) {
        const active = button.dataset.view === view;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      }
      const [title, description] = VIEW_LABELS[view];
      setText('page-title', title); setText('page-description', description);
    }
    function updateWriterButtons() {
      for (const button of document.querySelectorAll('[data-writer]')) {
        button.disabled = !canWrite() || button.dataset.unavailable === 'true';
      }
      $('setup-submit').disabled = state.initializing;
      $('plan-submit').disabled = state.planning || !state.snapshot?.configured || !selectedDataset()
        || Boolean(selectedDataset()?.retired || selectedDataset()?.error);
    }
    function markUnavailable(id, unavailable) {
      $(id).dataset.unavailable = unavailable ? 'true' : 'false';
    }

    function updateImportFields() {
      const features = $('import-features').value;
      const standard = features !== 'roads-v1';
      const elevation = Boolean($('import-elevation').value.trim());
      $('import-standard-fields').hidden = !standard;
      $('import-area-option').hidden = !standard;
      $('import-datum-option').hidden = !standard;
      $('import-contour-option').hidden = features !== 'standard-v2';
      $('import-contour-data').disabled = !standard || !elevation;
      if (!elevation) $('import-contour-data').checked = false;
    }

    function fillSelect(select, values, preferred, emptyLabel) {
      const items = values.length ? values : [{ value: '', label: emptyLabel, disabled: true }];
      const signature = JSON.stringify(items);
      if (select.dataset.options !== signature) {
        select.replaceChildren(...items.map(item => {
          const option = element('option', '', item.label); option.value = item.value;
          option.disabled = Boolean(item.disabled); return option;
        }));
        select.dataset.options = signature;
      }
      const value = items.some(item => item.value === preferred && !item.disabled) ? preferred
        : items.find(item => !item.disabled)?.value || '';
      select.value = value;
      return value;
    }

    function invalidatePlan() {
      state.plan = null; state.planSignature = '';
      $('plan-result').hidden = true;
      markUnavailable('precompute-run', true);
      updateWriterButtons();
    }

    function chooseDataset(id) {
      if (state.selectedDataset !== id) {
        state.selectedDataset = id;
        state.datasetSignature = '';
        $('dataset-url-result').hidden = true;
        invalidatePlan();
      }
      renderDatasets();
    }

    function renderDatasets() {
      const datasets = state.snapshot?.datasets || [];
      const available = datasets.filter(item => !item.retired);
      if (!datasets.some(item => item.id === state.selectedDataset)) state.selectedDataset = available[0]?.id || datasets[0]?.id || '';
      const signature = JSON.stringify([datasets, state.selectedDataset]);
      if (state.datasetSignature !== signature) {
        const cards = datasets.map(dataset => {
          const card = element('button', `dataset-card${dataset.id === state.selectedDataset ? ' selected' : ''}`);
          card.type = 'button'; card.setAttribute('aria-pressed', String(dataset.id === state.selectedDataset));
          card.append(element('span', 'dataset-card-title with-badge', dataset.name || '名前のない地図'));
          const kind = ({ 1: '道路のみ', 2: '標準地形図', 3: '地名・ランドマーク付き' })[dataset.info?.schema_version] || '完成地図';
          card.append(element('span', 'dataset-card-description', `${kind} · ${count(dataset.info?.feature_count)} 地物`));
          const badge = element('span', `badge${dataset.retired ? ' neutral' : dataset.current_profile_prepared ? '' : ' busy'}`, dataset.retired ? '利用停止' : dataset.current_profile_prepared ? '準備済み' : '条件を確認');
          card.append(badge);
          const bottom = element('span', 'dataset-card-bottom');
          bottom.append(element('span', '', dataset.storage_kind === 'external' ? '外部DB' : '取り込み済み'), element('span', '', shortId(dataset.id)));
          card.append(bottom); card.addEventListener('click', () => chooseDataset(dataset.id)); return card;
        });
        $('dataset-list').replaceChildren(...cards);
        state.datasetSignature = signature;
      }
      $('dataset-empty').hidden = datasets.length > 0;
      const dataset = selectedDataset();
      $('dataset-detail').hidden = !dataset;
      fillSelect($('precompute-dataset'), available.map(item => ({ value: item.id, label: item.name })), state.selectedDataset, '先に地図を取り込んでください');
      if (!dataset) {
        fillSelect($('precompute-profile'), [], '', '描画条件がありません');
        markUnavailable('precompute-run', true); updateWriterButtons(); return;
      }
      setText('dataset-detail-name', dataset.name);
      setText('dataset-detail-meta', `${count(dataset.info?.feature_count)} 地物 · 登録日 ${dateText(dataset.created_at)} · ${shortId(dataset.id)}`);
      setText('dataset-detail-path', dataset.database_path || '—');
      $('dataset-detail-error').hidden = !dataset.error;
      setText('dataset-detail-error', dataset.error || '');
      const profiles = usableProfiles(dataset);
      const options = profiles.map(item => ({ value: item.id, label: profileLabel(item) }));
      const previous = selectedProfile();
      const chosen = fillSelect($('dataset-profile'), options, previous, '先に描画条件を準備してください');
      state.profiles.set(dataset.id, chosen);
      fillSelect($('precompute-profile'), dataset.retired ? [] : options, chosen, '先に描画条件を準備してください');
      if (dataset.retired) $('precompute-dataset').selectedIndex = -1;
      if (previous && chosen !== previous) invalidatePlan();
      const usable = !dataset.retired && !dataset.error;
      $('dataset-copy-url').disabled = !chosen || !usable;
      markUnavailable('dataset-background', !chosen || !usable);
      markUnavailable('prepare-submit', !usable);
      $('dataset-to-precompute').disabled = !chosen || !usable;
      setText('dataset-profile-hint', chosen ? 'この描画条件のURL・事前生成を利用します。' : '下の「描画条件を準備」から利用する条件を追加してください。');
      const customSupported = Number(dataset.info?.schema_version) === 3;
      $('prepare-custom').disabled = !customSupported;
      if (!customSupported) $('prepare-custom').checked = false;
      $('prepare-spec-fields').hidden = !$('prepare-custom').checked || !customSupported;
      setText('prepare-custom-hint', customSupported ? '同じ地図から、異なる表示内容のタイルを作成できます。' : 'この形式は、データセットの標準の描画条件で準備します。');
      $('spec-language').disabled = !$('spec-labels').checked;
      updateWriterButtons();
    }

    function dateText(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    }

    function badgeFor(status) {
      const kind = status === 'succeeded' ? '' : ['failed', 'deadline_exceeded'].includes(status) ? ' failed'
        : ['cancelled', 'interrupted'].includes(status) ? ' cancelled' : isActive(status) ? ' busy' : ' neutral';
      return element('span', `badge${kind}`, STATE_LABELS[status] || status || '状態不明');
    }

    function logPath(container, path, requestId) {
      if (!path) return;
      const line = element('div', 'job-log');
      line.append(element('span', 'path-value', path));
      const copy = element('button', 'text-button', 'パスをコピー'); copy.type = 'button';
      copy.addEventListener('click', () => copyText(path).then(() => notify('ログファイルのパスをコピーしました。')).catch(error => notify(errorMessage(error), true)));
      line.append(copy); container.append(line);
      if (requestId) {
        const open = element('button', 'button secondary small', 'ログを表示'); open.type = 'button';
        open.addEventListener('click', () => openLog(requestId)); container.append(open);
      }
    }

    function jobCard(job, openDetails) {
      const view = progressView(job);
      const card = element('article', `card job-card${job.state === 'succeeded' ? ' complete' : ['failed', 'deadline_exceeded'].includes(job.state) ? ' failed' : ''}`);
      const heading = element('div', 'job-heading'), left = element('div');
      const dataset = state.snapshot?.datasets?.find(item => item.id === job.dataset_id);
      const name = job.request?.name || dataset?.name || '';
      left.append(element('h3', 'job-title', `${ACTION_LABELS[job.kind] || job.kind}${name ? ` ／ ${name}` : ''}`));
      left.append(element('p', 'job-subtitle', `${dateText(job.created_at)} · ${shortId(job.id)}`));
      const right = element('div', 'job-heading-right'); right.append(badgeFor(job.state));
      if (view.active) {
        const cancel = element('button', 'button danger small', job.state === 'cancelling' || state.pendingCancels.has(job.id) ? '取消処理中…' : '取消');
        cancel.type = 'button'; cancel.disabled = job.state === 'cancelling' || state.pendingCancels.has(job.id);
        cancel.addEventListener('click', () => cancelJob(job.id)); right.append(cancel);
      } else if (job.kind === 'precompute' && ['failed', 'cancelled', 'interrupted', 'deadline_exceeded'].includes(job.state)) {
        const resume = element('button', 'button secondary small', '再開'); resume.type = 'button';
        resume.dataset.writer = ''; resume.disabled = !canWrite();
        resume.addEventListener('click', () => submit('resume', { job: job.id })); right.append(resume);
      }
      heading.append(left, right); card.append(heading);
      const progress = element('div', 'job-progress'), caption = element('div', 'progress-caption');
      caption.append(element('span', '', view.stage));
      let detail = view.total !== null ? `${count(view.completed)} / ${count(view.total)}${job.kind === 'precompute' ? ' 枚' : ''}` : `${count(view.completed)} 処理済み`;
      if (view.percentage !== null) detail += ` · ${Math.floor(view.percentage)}%`;
      detail += ` · ${duration(view.elapsed)}`;
      caption.append(element('span', '', detail)); progress.append(caption);
      // value属性で描画するため、style属性や外部スタイル挿入は必要ない。
      const bar = element('progress', `native-progress${job.state === 'succeeded' ? ' complete' : ''}`);
      bar.max = 100; bar.setAttribute('aria-label', view.stage);
      if (view.percentage !== null) bar.value = view.percentage;
      else if (!view.active) bar.value = job.state === 'succeeded' ? 100 : 0;
      progress.append(bar);
      if (job.kind === 'precompute' && Number.isFinite(job.progress?.reused_tiles)) {
        progress.append(element('p', 'hint', `新規生成 ${count(job.progress.rendered_tiles)} 枚 · 既存PNGの再利用 ${count(job.progress.reused_tiles)} 枚`));
      }
      card.append(progress);
      if (job.error) card.append(element('p', 'job-error', job.error));
      const details = element('details', 'job-details'); details.dataset.jobId = job.id; details.open = openDetails.has(job.id);
      details.append(element('summary', '', 'ログと詳細を表示'));
      const lines = [`ジョブID: ${job.id}`, `状態: ${STATE_LABELS[job.state] || job.state}`];
      if (job.dataset_id) lines.push(`データセット: ${job.dataset_id}`);
      const diagnostics = Array.isArray(job.progress?.diagnostics) ? job.progress.diagnostics : [];
      for (const entry of diagnostics) lines.push(`[${entry.level || 'Info'}] ${entry.message || ''}`);
      if (job.progress?.dropped_diagnostics) lines.push(`省略された診断: ${count(job.progress.dropped_diagnostics)}`);
      if (job.error) lines.push(job.error);
      lines.push('', '入力条件', JSON.stringify(job.request || {}, null, 2));
      details.append(element('pre', '', lines.join('\n')));
      const receipt = (state.snapshot?.requests || []).find(item => item.job_id === job.id);
      logPath(details, receipt?.log_path, receipt?.id);
      card.append(details); return card;
    }

    function renderActivity(force = false) {
      const jobs = state.snapshot?.jobs || [], requests = state.snapshot?.requests || [];
      const signature = JSON.stringify([jobs, requests, submission.pending, ownerBusy(), [...state.pendingCancels]]);
      if (!force && signature === state.activitySignature) return;
      const open = new Set([...document.querySelectorAll('[data-job-id][open]')].map(item => item.dataset.jobId));
      $('job-list').replaceChildren(...jobs.map(job => jobCard(job, open)));
      const visibleRequests = requests.filter(request => !request.job_id || !jobs.some(job => job.id === request.job_id));
      $('request-list').replaceChildren(...visibleRequests.map(request => {
        const card = element('article', 'card request-card');
        const details = element('details');
        const summary = element('summary', 'job-title', ACTION_LABELS[request.action] || request.action);
        details.append(summary, element('p', 'job-subtitle', `${dateText(request.created_at)} · 受付 ${shortId(request.id)}`));
        if (request.error) details.append(element('p', 'job-error', request.error));
        logPath(details, request.log_path, request.id);
        if (request.result) details.append(element('pre', 'receipt-result', JSON.stringify(request.result, null, 2)));
        card.append(details, badgeFor(request.state)); return card;
      }));
      $('activity-empty').hidden = jobs.length > 0 || visibleRequests.length > 0;
      state.activitySignature = signature;
      updateWriterButtons();
    }

    function renderSettings() {
      const snapshot = state.snapshot || {}, config = snapshot.config || {};
      const values = [['設定ファイル', snapshot.config_path], ['データセット', config.dataset_path],
        ['PNGの保存先', config.cache_path], ['作業領域', config.work_path], ['地図の管理DB', config.catalog_database_path],
        ['生成ワーカー数', config.workers], ['事前生成の受付上限', config.precompute_max_tiles == null ? null : `${count(config.precompute_max_tiles)} 枚`]];
      $('settings-values').replaceChildren(...values.flatMap(([label, value]) => [element('dt', '', label), element('dd', '', value ?? '未設定')]));
    }

    function applySnapshot(snapshot) {
      state.snapshot = snapshot;
      if (snapshot.rebind && snapshot.rebind.binding_matches === false) $('rebind-panel').hidden = false;
      $('show-rebind').disabled = !snapshot.configured;
      const configured = snapshot.configured === true;
      $('setup-panel').hidden = configured;
      $('workspace').hidden = !configured;
      $('navigation').setAttribute('aria-disabled', String(!configured));
      for (const button of document.querySelectorAll('#navigation button')) button.disabled = !configured;
      setText('setup-config-path', snapshot.config_path || '');
      const jobs = snapshot.jobs || [], requests = snapshot.requests || [];
      const running = jobs.filter(job => isActive(job.state)).length;
      const preAccepted = requests.filter(request => isActive(request.state) && !request.job_id).length;
      setText('dataset-count', (snapshot.datasets || []).filter(dataset => !dataset.retired).length);
      setText('nav-dataset-count', (snapshot.datasets || []).filter(dataset => !dataset.retired).length);
      setText('running-count', running + preAccepted); setText('nav-job-count', running + preAccepted);
      setText('completed-count', jobs.filter(job => job.state === 'succeeded').length);
      const badge = $('connection-status');
      badge.className = `badge${snapshot.error ? ' failed' : !configured ? ' neutral' : ownerBusy() ? ' busy' : ''}`;
      badge.textContent = snapshot.error ? '設定を確認' : !configured ? '初期設定が必要' : ownerBusy() ? '処理中' : '準備完了';
      $('owner-message').hidden = !configured || !ownerBusy();
      setText('owner-message-title', pendingRequests().length ? '生成処理を実行しています' : '別の処理が生成領域を使用しています');
      $('connection-error').hidden = !snapshot.error;
      setText('connection-error', snapshot.error || '');
      setText('refresh-time', `${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 更新`);
      for (const job of jobs) if (!isActive(job.state)) state.pendingCancels.delete(job.id);
      if (state.initialized) {
        for (const receipt of requests) {
          const before = state.seenRequests.get(receipt.id);
          if (before && isActive(before) && receipt.state === 'succeeded') {
            notify(`${ACTION_LABELS[receipt.action] || '処理'}が完了しました。`);
            const id = receipt.result?.dataset_id || receipt.result?.id;
            if (id && (snapshot.datasets || []).some(dataset => dataset.id === id) && ['import', 'register', 'prepare'].includes(receipt.action)) {
              state.selectedDataset = id;
              if (receipt.result?.render_id) state.profiles.set(id, receipt.result.render_id);
            }
          } else if (before && isActive(before) && receipt.state === 'failed') {
            notify(receipt.error || `${ACTION_LABELS[receipt.action] || '処理'}に失敗しました。処理状況を確認してください。`, true);
          }
        }
      }
      for (const receipt of requests) state.seenRequests.set(receipt.id, receipt.state);
      state.initialized = true;
      if (configured) { renderDatasets(); renderActivity(); }
      else { setText('page-title', 'ローカル地図の作成'); setText('page-description', '地図を作成するための準備を始めます。'); }
      renderSettings(); updateWriterButtons();
    }

    async function refresh() {
      if (state.polling) return;
      state.polling = true;
      $('refresh-button').disabled = true;
      try { applySnapshot(await nativeInvoke('tile_manager_snapshot')); }
      catch (error) {
        $('connection-error').hidden = false;
        setText('connection-error', errorMessage(error));
        $('connection-status').className = 'badge failed'; setText('connection-status', '状態を確認できません');
      } finally {
        state.polling = false;
        $('refresh-button').disabled = false;
      }
    }

    async function submit(action, payload) {
      if (action !== 'rebind' && !canWrite()) { notify('ほかの処理が終了してから開始してください。状態の確認と取消は利用できます。', true); return; }
      const task = submission.submit(action, payload);
      updateWriterButtons();
      try {
        const receipt = await task;
        if (receipt?.id) state.seenRequests.set(receipt.id, receipt.state || 'starting');
        notify(`${ACTION_LABELS[action] || '処理'}を受け付けました。画面を閉じた後も処理は続きます。`);
        showView('activity');
        await refresh();
      } catch (error) { notify(errorMessage(error), true); }
      finally { updateWriterButtons(); renderActivity(true); }
    }

    async function cancelJob(id) {
      if (state.pendingCancels.has(id)) return;
      state.pendingCancels.add(id); renderActivity(true);
      try {
        await nativeInvoke('tile_manager_query', { action: 'cancel', payload: { job: id } });
        notify('取消を要求しました。実処理が終了するまでお待ちください。');
        await refresh();
      } catch (error) { state.pendingCancels.delete(id); notify(errorMessage(error), true); }
      finally { renderActivity(true); }
    }

    async function openLog(requestId) {
      state.logRequestId = requestId;
      $('refresh-log').disabled = true;
      if (!$('log-dialog').open) $('log-dialog').showModal();
      setText('log-dialog-note', 'ログを読み込んでいます…');
      try {
        const result = await nativeInvoke('tile_manager_query', { action: 'log', payload: { request_id: requestId } });
        if (state.logRequestId !== requestId) return;
        setText('log-dialog-path', result.path || '');
        setText('log-dialog-text', result.text || 'まだログ出力がありません。');
        setText('log-dialog-note', result.truncated ? 'ログが大きいため、末尾の64KiBを表示しています。' : '実行中の処理は「ログを更新」で最新の出力を確認できます。');
      } catch (error) { setText('log-dialog-text', errorMessage(error)); setText('log-dialog-note', 'ログを読み取れませんでした。'); }
      finally { $('refresh-log').disabled = false; }
    }

    function readPrecompute() {
      return precomputePayload({ dataset_id: $('precompute-dataset').value, render_id: $('precompute-profile').value,
        west: $('bbox-west').value, south: $('bbox-south').value, east: $('bbox-east').value, north: $('bbox-north').value,
        min_zoom: $('precompute-min-zoom').value, max_zoom: $('precompute-max-zoom').value, max_tiles: $('precompute-max-tiles').value });
    }

    async function copyText(value) {
      if (globalThis.navigator?.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(value); return; } catch { /* local WebView fallback below */ }
      }
      const input = element('textarea', 'clipboard-fallback'); input.value = value;
      document.body.append(input); input.select();
      try { if (!document.execCommand('copy')) throw new Error('コピーできませんでした。表示された値を選択してコピーしてください。'); }
      finally { input.remove(); }
    }

    for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
    $('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
    $('refresh-button').addEventListener('click', refresh);
    $('show-settings').addEventListener('click', () => { renderSettings(); $('settings-dialog').showModal(); });
    const invalidateRebind = () => { state.rebindRevision++; state.rebindPlan = null; $('rebind-apply').disabled = true; };
    for (const id of ['rebind-source', 'rebind-proof']) $(id).addEventListener('input', invalidateRebind);
    $('show-rebind').addEventListener('click', () => { $('rebind-panel').hidden = !$('rebind-panel').hidden; });
    const rebindQuery = async (action, payload) => {
      if (state.rebinding || submission.pending) return null;
      state.rebinding = true; $('rebind-plan').disabled = true; $('rebind-inspect').disabled = true;
      try { return await nativeInvoke('tile_manager_query', { action, payload }); }
      finally { state.rebinding = false; $('rebind-plan').disabled = false; $('rebind-inspect').disabled = false; }
    };
    $('rebind-inspect').addEventListener('click', async () => {
      invalidateRebind();
      try {
        const result = await rebindQuery('rebind_inspect', {});
        if (result) $('rebind-diagnosis').textContent = `${result.message}\n記録された本体DB: ${result.previous.path}\n現在の本体DB: ${result.target.path}\ncatalog: ${result.catalog.path}`;
      } catch (error) { notify(errorMessage(error), true); }
    });
    $('rebind-plan').addEventListener('click', async () => {
      invalidateRebind();
      const revision = state.rebindRevision;
      try {
        const result = await rebindQuery('rebind_plan', { source_database: $('rebind-source').value.trim() || null, proof: $('rebind-proof').value.trim() || null });
        if (!result || revision !== state.rebindRevision) return;
        state.rebindPlan = result;
        const plan = result.payload;
        $('rebind-diagnosis').textContent = `同一性を確認しました。\n変更前: ${plan.previous.path}\n変更後: ${plan.target.path}\n確認方法: ${plan.evidence}\nデータセット: ${plan.catalog_contents.rows.local_tile_datasets || 0}件\nジョブ履歴: ${plan.catalog_contents.rows.local_tile_jobs || 0}件\n適用前にcatalogのバックアップを作成します。`;
        $('rebind-apply').disabled = false;
      } catch (error) { notify(errorMessage(error), true); }
    });
    $('rebind-apply').addEventListener('click', async () => {
      const plan = state.rebindPlan;
      if (!plan || state.rebinding || submission.pending) return;
      invalidateRebind();
      await submit('rebind', { kind: 'apply', plan });
    });
    $('rebind-prepare').addEventListener('click', async () => {
      const output = $('rebind-output').value.trim();
      if (!output || state.rebinding || submission.pending) { if (!output) notify('移設記録の保存先を入力してください。', true); return; }
      await submit('rebind', { kind: 'prepare', output });
    });
    $('close-settings').addEventListener('click', () => $('settings-dialog').close());
    $('close-log').addEventListener('click', () => $('log-dialog').close());
    $('refresh-log').addEventListener('click', () => { if (state.logRequestId) openLog(state.logRequestId); });
    for (const button of document.querySelectorAll('[data-pick]')) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const path = await nativeInvoke('tile_manager_pick_path', { kind: button.dataset.pick });
          if (path) { $(button.dataset.target).value = path; $(button.dataset.target).dispatchEvent(new Event('input', { bubbles: true })); }
        } catch (error) { notify(errorMessage(error), true); }
        finally { button.disabled = false; }
      });
    }
    $('setup-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (state.initializing) return;
      if ($('setup-password').value !== $('setup-password-confirm').value) { notify('確認用パスワードが一致しません。', true); return; }
      state.initializing = true; updateWriterButtons();
      try {
        await nativeInvoke('tile_manager_initialize', { form: {
          app_title: $('setup-title-input').value.trim(), admin_username: $('setup-username').value.trim(), admin_password: $('setup-password').value,
          failed_account_lock: '15', next_challenge_minutes: '5', challenge_limit_time_failed_count: '5', access_token_exp_minutes: '60', refresh_token_exp_minutes: '1440',
        } });
        $('setup-password').value = ''; $('setup-password-confirm').value = '';
        notify('設定の準備が完了しました。地図の取り込みを始められます。');
        await refresh(); showView('import');
      } catch (error) { notify(errorMessage(error), true); }
      finally { state.initializing = false; updateWriterButtons(); }
    });
    $('import-features').addEventListener('change', updateImportFields);
    $('import-elevation').addEventListener('input', updateImportFields);
    $('import-form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        const values = Object.fromEntries(new FormData(event.currentTarget)); values.contour_data = $('import-contour-data').checked;
        submit('import', importPayload(values));
      } catch (error) { notify(errorMessage(error), true); }
    });
    $('register-form').addEventListener('submit', event => {
      event.preventDefault(); submit('register', { database: $('register-database').value.trim(), name: $('register-name').value.trim() });
    });
    $('prepare-custom').addEventListener('change', () => { $('prepare-spec-fields').hidden = !$('prepare-custom').checked; });
    $('spec-labels').addEventListener('change', () => { $('spec-language').disabled = !$('spec-labels').checked; });
    $('prepare-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!selectedDataset()) return;
      const spec = $('prepare-custom').checked && !$('prepare-custom').disabled ? {
        revision: 1, roads: $('spec-roads').checked, buildings: $('spec-buildings').checked, contours: $('spec-contours').checked,
        hillshade: $('spec-hillshade').checked, labels: $('spec-labels').checked, language: $('spec-labels').checked ? $('spec-language').value : 'local',
      } : null;
      submit('prepare', { dataset: state.selectedDataset, spec });
    });
    function changeProfile(select) {
      state.profiles.set(state.selectedDataset, select.value);
      $('dataset-profile').value = select.value; $('precompute-profile').value = select.value;
      $('dataset-url-result').hidden = true; invalidatePlan();
    }
    $('dataset-profile').addEventListener('change', event => changeProfile(event.currentTarget));
    $('precompute-profile').addEventListener('change', event => changeProfile(event.currentTarget));
    $('precompute-dataset').addEventListener('change', event => chooseDataset(event.currentTarget.value));
    $('dataset-copy-url').addEventListener('click', async () => {
      $('dataset-copy-url').disabled = true;
      try {
        const result = await nativeInvoke('tile_manager_query', { action: 'url', payload: { dataset: state.selectedDataset, render: selectedProfile() } });
        const url = result.relative_url || result.url;
        if (!url) throw new Error('タイルURLを取得できませんでした。描画条件を確認してください。');
        setText('dataset-url', url); $('dataset-url-result').hidden = false;
        await copyText(url); notify('タイルURLをコピーしました。');
      } catch (error) { notify(errorMessage(error), true); }
      finally { $('dataset-copy-url').disabled = !selectedProfile(); }
    });
    $('dataset-background').addEventListener('click', () => submit('background', { dataset: state.selectedDataset, render: selectedProfile(), name: selectedDataset()?.name }));
    $('dataset-to-precompute').addEventListener('click', () => { renderDatasets(); showView('precompute'); });
    $('bbox-japan').addEventListener('click', () => {
      for (const [key, value] of Object.entries({ west: 122, south: 20, east: 154, north: 46 })) $(`bbox-${key}`).value = value;
      invalidatePlan();
    });
    $('precompute-form').addEventListener('input', invalidatePlan);
    $('precompute-form').addEventListener('change', invalidatePlan);
    $('precompute-form').addEventListener('submit', async event => {
      event.preventDefault(); if (state.planning) return;
      let payload; try { payload = readPrecompute(); } catch (error) { notify(errorMessage(error), true); return; }
      const signature = JSON.stringify(payload);
      invalidatePlan(); state.planning = true; updateWriterButtons();
      try {
        const result = await nativeInvoke('tile_manager_query', { action: 'plan', payload });
        if (JSON.stringify(readPrecompute()) !== signature) throw new Error('条件が変更されました。予定枚数をもう一度確認してください。');
        state.plan = { result, payload }; state.planSignature = signature;
        const allowed = result.allowed === true && result.exceeds_max_tiles !== true;
        setText('plan-count', count(result.total_tiles ?? result.tile_count));
        setText('plan-description', allowed ? '条件を確認したら、下のボタンから生成を開始できます。' : `受付上限 ${count(result.max_tiles)} 枚を超えています。範囲またはズームを小さくしてください。`);
        const zooms = object(result.zooms);
        setText('plan-zooms', Object.entries(zooms).map(([zoom, amount]) => `z${zoom}: ${count(amount)}枚`).join(' ／ '));
        $('plan-result').classList.toggle('not-allowed', !allowed); $('plan-result').hidden = false;
        markUnavailable('precompute-run', !allowed);
      } catch (error) { notify(errorMessage(error), true); }
      finally { state.planning = false; updateWriterButtons(); }
    });
    $('precompute-run').addEventListener('click', () => {
      try {
        if (!state.plan || JSON.stringify(readPrecompute()) !== state.planSignature || !state.plan.result.allowed) {
          invalidatePlan(); throw new Error('予定枚数を確認してから生成を開始してください。');
        }
        const payload = { ...state.plan.payload, render_id: state.plan.result.render_id };
        submit('precompute', payload);
      } catch (error) { notify(errorMessage(error), true); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    updateImportFields(); markUnavailable('precompute-run', true); updateWriterButtons();
    async function poll() {
      await refresh();
      globalThis.setTimeout(poll, document.hidden ? 3000 : 1000);
    }
    poll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
