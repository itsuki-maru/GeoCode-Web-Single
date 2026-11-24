import { escapeHtml } from "./marker";
import { releaseDeferredDetails, disposeMapContent, registerProgressiveHtml } from "./content";
import { installDesktopPopupHeightLimit, updatePopupLayout } from "./popup-layout";
import { createGoogleMapLink, googleMapLocationUrl } from "./google-map-link";
import { validPoint } from "./route-result";

export interface PopupBody {
  body?: string;
  free_text: string;
  managed_markdown: string;
  sync_required: boolean;
}
export type PopupBodies = Record<string, PopupBody>;
type Content = { kind: "marker" | "shape"; id: string; name: string; body: string };
type RoutePosition = { lat: number; lng: number };
type MarkdownReferences = Record<string, { href: string; title: string | null }>;
type RenderMarkdown = (markdown: string, links?: MarkdownReferences) => string;
interface Options {
  map: {
    getContainer?(): HTMLElement;
    on(event: string, fn: (event: any) => void): void;
    off?(event: string, fn: (event: any) => void): void;
  };
  renderMarkdown: RenderMarkdown;
  sanitizeHtml(html: string): string;
  setupImages(root: ParentNode, render?: RenderMarkdown): void;
  loadBody?(kind: string, id: string): Promise<PopupBody>;
  snapshot?: PopupBodies;
  analysis?: Record<string, string>;
  answerMap?: boolean;
  desktopHeightLimit?: "marker" | "all";
  showGoogleMapLink?: boolean;
  routeSearch?: {
    isAvailable(): boolean;
    search(destination: RoutePosition, onLocationError: (message: string) => void): void;
    cancelPending(): void;
  };
  getMarkerRecord?(id: string): { latitude: number; longitude: number } | undefined;
}

const routeAvailabilityEvents = ["basemapstatechange", "googleroutesavailabilitychange"];

export function isPopupBody(value: any): value is PopupBody {
  return (
    !!value &&
    typeof value.free_text === "string" &&
    typeof value.managed_markdown === "string" &&
    typeof value.sync_required === "boolean" &&
    (value.body === undefined || typeof value.body === "string")
  );
}

// 本文はページの Markdown レンダラーで描画し、操作欄はユーザーの Markdown の外側に構築する。
export function createPopupContentRuntime(options: Options) {
  if (options.desktopHeightLimit) installDesktopPopupHeightLimit(options.map);
  const canSwitchContent = options.snapshot !== undefined || Boolean(options.loadBody);
  const contentControls = canSwitchContent
    ? `<label>表示内容<select aria-label="表示内容">
        <option value="free" disabled>自由入力の内容</option>
        <option value="answers" disabled>フォームからの登録</option>
        <option value="normal" selected>通常表示</option>
      </select></label>`
    : "";
  const printModeLabel = canSwitchContent
    ? '<span class="popup-content-print-label">通常表示</span>'
    : "";
  const contents = new Map<string, Content & { html: string }>();
  const analysis = new Map<string, string>(Object.entries(options.analysis || {}));
  const cache = new Map<string, { body: string; pending: Promise<PopupBody> }>();
  const sessions = new WeakMap<HTMLElement, { dispose(): void }>();
  const activeSessions = new Set<{ dispose(): void }>();
  const stopToolbarEvent = (event: Event) => event.stopPropagation();
  const render = (content: Content) => {
    const key = `${content.kind}:${content.id}`;
    const previous = contents.get(key);
    if (previous?.body === content.body && previous.name === content.name) return previous.html;
    if (previous) releaseDeferredDetails(previous.html);
    const heightClass =
      options.desktopHeightLimit === "all" || options.desktopHeightLimit === content.kind
        ? " popup-content-height-limited"
        : "";
    const html = `<div class="geocode-content-popup${heightClass}" data-content-key="${escapeHtml(key)}">
      <div class="popup-content-toolbar">${contentControls}</div>${printModeLabel}
      <div class="popup-content-analysis"></div>
      <h1 class="popup-content-title">${escapeHtml(content.name)}</h1>
      <p class="popup-content-note" role="status"></p>
      <div class="md-detail-contents popup-content-body">${content.body.trim() ? options.renderMarkdown(content.body) : "内容はありません。"}</div></div>`;
    contents.set(key, { ...content, html });
    return html;
  };
  const onOpen = async (event: any) => {
    const popup = event.popup;
    const root = popup
      ?.getElement?.()
      ?.querySelector(".geocode-content-popup") as HTMLElement | null;
    if (!root) return;
    const key = root.dataset.contentKey!;
    const content = contents.get(key);
    if (!content) return;
    if (sessions.has(root)) return;
    const note = root.querySelector<HTMLElement>(".popup-content-note")!;
    const body = root.querySelector<HTMLElement>(".popup-content-body")!;
    const printLabel = root.querySelector<HTMLElement>(".popup-content-print-label");
    const analysisElement = root.querySelector<HTMLElement>(".popup-content-analysis")!;
    const normalBodyHtml = body.innerHTML;
    const toolbar = root.querySelector(".popup-content-toolbar")!;
    const select = toolbar.querySelector<HTMLSelectElement>("select");
    const toolbarEvents = ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "wheel"];
    let displayedMode = "normal";
    let transientHtml = "";
    let analysisHtml = "";
    let disposeRouteAction: (() => void) | undefined;
    let googleMapLink: HTMLAnchorElement | undefined;
    const mobile = root.ownerDocument.body.classList.contains("map-mobile-controls");
    const mapContainer =
      mobile && (options.routeSearch || options.showGoogleMapLink)
        ? options.map.getContainer?.()
        : undefined;
    const oldPaddingTopLeft = popup.options?.autoPanPaddingTopLeft;
    const oldPaddingBottomRight = popup.options?.autoPanPaddingBottomRight;
    let actionTopPadding: number | undefined;
    const restoreActionPadding = () => {
      if (actionTopPadding === undefined) return;
      popup.options.autoPanPaddingTopLeft = oldPaddingTopLeft;
      popup.options.autoPanPaddingBottomRight = oldPaddingBottomRight;
      actionTopPadding = undefined;
      root.classList.remove("popup-content-overlaps-controls");
    };
    const updateActionPadding = () => {
      if (!mapContainer || !popup.options) return false;
      if (!googleMapLink && !toolbar.classList.contains("popup-content-toolbar-route")) {
        const changed = actionTopPadding !== undefined;
        restoreActionPadding();
        return changed;
      }
      const mapBounds = mapContainer.getBoundingClientRect();
      // visibility:hidden でも操作群の高さを保持し、余裕ができたときに復帰できる。
      const controlsBottom = Math.max(
        0,
        ...Array.from(
          mapContainer.querySelectorAll(".leaflet-top"),
          (corner) => corner.getBoundingClientRect().bottom - mapBounds.top,
        ),
      );
      const popupElement: HTMLElement = popup.getElement();
      const marginBottom = parseFloat(getComputedStyle(popupElement).marginBottom) || 0;
      const popupHeight = popupElement.offsetHeight + marginBottom;
      const bottomPadding = 45;
      const controlsPadding = Math.max(10, controlsBottom + 8);
      // 本文を読める高さを確保し、操作群と同時に収まらない場合だけ操作群を隠す。
      const overlapsControls = controlsPadding + popupHeight + bottomPadding > mapBounds.height;
      const topPadding = overlapsControls ? 10 : controlsPadding;
      root.classList.toggle("popup-content-overlaps-controls", overlapsControls);
      if (actionTopPadding === topPadding) return false;
      actionTopPadding = topPadding;
      popup.options.autoPanPaddingTopLeft = [10, topPadding];
      popup.options.autoPanPaddingBottomRight = [10, bottomPadding];
      return true;
    };
    const update = () => {
      updatePopupLayout(popup, root, { force: updateActionPadding() });
    };
    const onResize = () => {
      updateActionPadding();
      updatePopupLayout(popup, root, { force: true });
    };
    const session = {
      dispose: () => {
        if (select) select.onchange = null;
        disposeRouteAction?.();
        googleMapLink?.remove();
        restoreActionPadding();
        if (mapContainer) options.map.off?.("resize", onResize);
        for (const type of toolbarEvents) toolbar.removeEventListener(type, stopToolbarEvent);
        root.removeEventListener("geocode:contentchange", update);
        disposeMapContent(root);
        releaseDeferredDetails(transientHtml);
        releaseDeferredDetails(analysisHtml);
        transientHtml = "";
        sessions.delete(root);
        activeSessions.delete(session);
      },
    };
    sessions.set(root, session);
    activeSessions.add(session);
    // 図形はポップアップを開いた地点、マーカーは操作時点の登録座標を使う。
    const anchor: RoutePosition | undefined =
      content.kind === "shape" ? popup.getLatLng?.() : undefined;
    const shapeDestination = anchor ? { lat: anchor.lat, lng: anchor.lng } : undefined;
    const getDestination = (): RoutePosition | undefined => {
      const marker = content.kind === "marker" ? options.getMarkerRecord?.(content.id) : undefined;
      const point = marker ? { lat: marker.latitude, lng: marker.longitude } : shapeDestination;
      return point && validPoint(point) ? point : undefined;
    };
    const linkDestination = options.showGoogleMapLink ? getDestination() : undefined;
    if (linkDestination) {
      const link = createGoogleMapLink(root.ownerDocument);
      link.className = "popup-content-google-link";
      link.href = googleMapLocationUrl(linkDestination);
      link.addEventListener("click", (click) => {
        const point = getDestination();
        if (point) link.href = googleMapLocationUrl(point);
        else {
          click.preventDefault();
          link.remove();
          googleMapLink = undefined;
          update();
        }
      });
      for (const type of toolbarEvents) link.addEventListener(type, stopToolbarEvent);
      googleMapLink = link;
      toolbar.after(link);
    }
    if (options.routeSearch) {
      const routeSearch = options.routeSearch;
      const routeButton = root.ownerDocument.createElement("button");
      routeButton.type = "button";
      routeButton.className = "popup-content-route-button";
      routeButton.textContent = "この場所への経路";
      routeButton.hidden = !routeSearch.isAvailable() || !getDestination();
      toolbar.classList.toggle("popup-content-toolbar-route", !routeButton.hidden);
      toolbar.append(routeButton);
      const routeNote = root.ownerDocument.createElement("p");
      routeNote.className = "popup-content-route-note";
      routeNote.setAttribute("role", "status");
      toolbar.after(routeNote);
      let startedSearch = false;
      const refreshRouteAction = () => {
        const hide = !routeSearch.isAvailable() || !getDestination();
        if (routeButton.hidden === hide) return;
        routeButton.hidden = hide;
        toolbar.classList.toggle("popup-content-toolbar-route", !hide);
        if (hide) routeNote.textContent = "";
        update();
      };
      routeButton.onclick = () => {
        const destination = getDestination();
        if (!destination || !routeSearch.isAvailable()) return;
        if (routeNote.textContent) {
          routeNote.textContent = "";
          update();
        }
        startedSearch = true;
        routeSearch.search(destination, (message) => {
          if (sessions.get(root) !== session || routeButton.hidden) return;
          routeNote.textContent = message;
          update();
        });
      };
      for (const event of routeAvailabilityEvents) options.map.on(event, refreshRouteAction);
      disposeRouteAction = () => {
        routeButton.onclick = null;
        for (const event of routeAvailabilityEvents) options.map.off?.(event, refreshRouteAction);
        if (startedSearch) routeSearch.cancelPending();
      };
    }
    updateActionPadding();
    if (mapContainer) options.map.on("resize", onResize);
    root.addEventListener("geocode:contentchange", update);
    const analysisContent = analysis.get(key) || "";
    analysisHtml = analysisContent
      ? registerProgressiveHtml(analysisContent, options.sanitizeHtml)
      : "";
    analysisElement.innerHTML = analysisHtml;
    if (select && printLabel) {
      select.value = "normal";
      for (const option of Array.from(select.options)) option.disabled = option.value !== "normal";
      printLabel.textContent = "通常表示";
      note.textContent = "表示内容を確認しています…";
    }
    // キーボードのフォーカスを閉じ込めず、選択欄の操作中に地図がドラッグやズームされることを防ぐ。
    for (const type of toolbarEvents) toolbar.addEventListener(type, stopToolbarEvent);
    // 最初の画像の一括読み込みで、ポップアップのレイアウトが同期的に更新される場合がある。
    // Leaflet が準備済みの文字列を復元しないよう、初期化前に実際のノードを保持する。
    if (popup.setContent) popup.setContent(root);
    else update();
    options.setupImages(root, options.renderMarkdown);
    if (!select || !printLabel) return;
    try {
      let info: PopupBody;
      if (options.snapshot !== undefined) {
        info = options.snapshot[key];
      } else {
        let cached = cache.get(key);
        if (!cached || cached.body !== content.body) {
          const pending = options.loadBody!(content.kind, content.id);
          cached = { body: content.body, pending };
          cache.set(key, cached);
          pending.catch(() => {
            if (cache.get(key)?.pending === pending) cache.delete(key);
          });
        }
        cache.delete(key);
        cache.set(key, cached);
        while (cache.size > 32) cache.delete(cache.keys().next().value!);
        info = await cached.pending;
      }
      if (sessions.get(root) !== session || !root.isConnected) return;
      if (!isPopupBody(info)) throw Error("Invalid popup body");
      if (info.body !== undefined && info.body !== content.body) {
        note.textContent = "内容が更新されています。地図を再読み込みしてから切り替えてください。";
        update();
        return;
      }
      if (info.sync_required) {
        note.textContent =
          "本文と登録の対応を確認できないため、通常表示のみ利用できます。登録一覧の編集から確認してください。";
        update();
        return;
      }
      for (const option of Array.from(select.options)) option.disabled = false;
      const show = () => {
        if (sessions.get(root) !== session || !root.isConnected) return;
        const mode = select.value;
        const markdown =
          mode === "free"
            ? info.free_text
            : mode === "answers"
              ? info.managed_markdown
              : content.body;
        if (mode !== displayedMode) {
          disposeMapContent(body);
          releaseDeferredDetails(transientHtml);
          transientHtml = "";
          if (mode === "normal") body.innerHTML = normalBodyHtml;
          else {
            transientHtml = markdown.trim()
              ? options.renderMarkdown(markdown)
              : mode === "free"
                ? "自由入力の内容はありません。"
                : "フォームからの登録はありません。";
            body.innerHTML = transientHtml;
          }
          displayedMode = mode;
          options.setupImages(root, options.renderMarkdown);
        }
        note.textContent =
          mode === "answers" && options.answerMap
            ? "この対象の登録データをすべて表示します。絞り込み・分析に使用した登録だけには限定しません。"
            : "";
        printLabel.textContent = select.selectedOptions[0]?.textContent || "通常表示";
        update();
      };
      select.onchange = show;
      show();
    } catch {
      if (sessions.get(root) !== session || !root.isConnected) return;
      note.textContent =
        "表示内容を取得できないため、通常表示のみ利用できます。開き直して再試行してください。";
      update();
    }
  };
  options.map.on("popupopen", (event) => void onOpen(event));
  options.map.on("popupclose", (event) => {
    const root = event.popup?.getElement?.()?.querySelector(".geocode-content-popup");
    if (root) {
      sessions.get(root)?.dispose();
      const content = contents.get(root.dataset.contentKey!);
      // ポップアップが閉じている間は、準備済みの折りたたんだ HTML だけを保持する。
      // 表示したマーカーを切り替えるたびに、展開済みの画像 DOM が蓄積しないようにする。
      if (content) event.popup.setContent?.(content.html);
    }
  });
  const release = (kind: "marker" | "shape", id: string) => {
    const key = `${kind}:${id}`;
    const content = contents.get(key);
    if (content) releaseDeferredDetails(content.html);
    contents.delete(key);
    cache.delete(key);
  };
  options.map.on("unload", () => {
    [...activeSessions].forEach((session) => session.dispose());
    contents.forEach((content) => releaseDeferredDetails(content.html));
    contents.clear();
    cache.clear();
    analysis.clear();
  });
  return {
    render,
    release,
    setAnalysis: (key: string, html: string) => analysis.set(key, html),
    getAnalysis: () => Object.fromEntries(analysis),
  };
}
