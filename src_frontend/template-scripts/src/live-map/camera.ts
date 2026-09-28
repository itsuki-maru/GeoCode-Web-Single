type Signal = { message_id: string; viewer_id: string; kind: "answer" | "ice"; data: unknown };
type Incoming = { id: number; viewer_id: string; kind: "offer" | "ice"; data: any };
type Exchange = { messages: Incoming[]; lease_ms: number };

import { CameraFullscreen } from "./camera-fullscreen";

class CameraHttpError extends Error {
  constructor(readonly status: number) {
    super(`camera HTTP ${status}`);
  }
}

/** A single popup owns one connection. HTTP signals contain no media. */
export class CameraViewer {
  readonly element = document.createElement("div");
  private readonly status = document.createElement("p");
  private readonly video = document.createElement("video");
  private readonly play = document.createElement("button");
  private readonly presentation = document.createElement("div");
  private readonly expand = document.createElement("button");
  private readonly fullscreen = new CameraFullscreen();
  private peer: RTCPeerConnection | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private active = false;
  private id = "";
  private key = "";
  private after = 0;
  private pending: Signal[] = [];
  private remoteIce: RTCIceCandidateInit[] = [];
  private lastReply = 0;
  private connectingSince = 0;
  private joined = false;
  private receivedFrame = false;
  private readonly visibility = () => {
    if (document.hidden) this.close("カメラ受信を停止しました。ポップアップを開き直してください。");
  };
  private readonly pagehide = () => this.close();

  constructor(
    private readonly publicId: string,
    private readonly memberId: string,
    private readonly displayName = "共有カメラ",
  ) {
    this.element.className = "live-camera";
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.cssText =
      "width:100%;max-width:100%;height:auto;max-height:50dvh;object-fit:contain;background:#111;display:none";
    this.video.setAttribute("aria-label", "共有カメラ映像");
    this.play.type = "button";
    this.play.textContent = "映像を再生";
    this.play.hidden = true;
    this.play.onclick = () =>
      void this.video
        .play()
        .then(() => {
          this.play.hidden = true;
        })
        .catch(() => {});
    this.presentation.className = "live-camera-presentation";
    this.presentation.append(this.status, this.video, this.play);
    this.expand.type = "button";
    this.expand.textContent = "全画面で表示";
    this.expand.hidden = true;
    this.expand.onclick = (event) => {
      event.stopPropagation();
      if (this.active && this.receivedFrame)
        this.fullscreen.open(this.presentation, this.displayName, this.expand);
    };
    this.element.append(this.presentation, this.expand);
  }
  private get base(): string {
    return `/live-api/maps/${encodeURIComponent(this.publicId)}`;
  }
  private setVideoVisible(visible: boolean): void {
    if (this.element.classList.contains("has-video") === visible) return;
    this.element.classList.toggle("has-video", visible);
    this.element.dispatchEvent(new Event("camera-layoutchange", { bubbles: true }));
  }
  private get connectionUrl(): string {
    return `${this.base}/camera/viewers/${this.id}`;
  }

  open(): void {
    this.close();
    if (document.hidden) return;
    if (typeof RTCPeerConnection === "undefined" || !globalThis.crypto?.randomUUID) {
      this.status.textContent = "このブラウザではカメラ共有を利用できません。";
      return;
    }
    this.active = true;
    this.id = crypto.randomUUID();
    this.key = crypto.randomUUID();
    this.after = 0;
    this.pending = [];
    this.remoteIce = [];
    this.receivedFrame = false;
    this.lastReply = performance.now();
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("pagehide", this.pagehide);
    this.watchdog = setInterval(() => {
      if (this.joined && performance.now() - this.lastReply > 12000)
        this.close("接続が途切れました。開き直してください。", true);
      else if (
        this.joined &&
        (this.peer?.connectionState !== "connected" || !this.receivedFrame) &&
        performance.now() - this.connectingSince > 20000
      )
        this.close(
          this.peer?.connectionState === "connected"
            ? "接続しましたが映像を受信できません。配信端末を確認してください。"
            : "映像に接続できません。ネットワークやSTUN/TURNの設定を確認してください。",
          true,
        );
    }, 250);
    void this.tick(this.generation);
  }

  close(message = "カメラ共有は停止中です。", failed = false): void {
    ++this.generation;
    const wasActive = this.active;
    this.active = false;
    this.expand.hidden = true;
    this.fullscreen.close();
    this.joined = false;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    this.controller?.abort();
    this.controller = null;
    this.peer?.close();
    this.peer = null;
    this.video.onloadeddata = null;
    this.video.onplaying = null;
    this.video.srcObject = null;
    this.video.style.display = "none";
    this.setVideoVisible(false);
    this.play.hidden = true;
    this.status.textContent = message;
    document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("pagehide", this.pagehide);
    if (wasActive && this.id) {
      void fetch(this.connectionUrl, {
        method: "DELETE",
        credentials: "same-origin",
        keepalive: true,
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: this.id, key: this.key, failed }),
      }).catch(() => {});
    }
  }

  private async request(url: string, body: unknown): Promise<any> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!r.ok) throw new CameraHttpError(r.status);
      if (!r.headers.get("content-type")?.includes("application/json"))
        throw new Error("Invalid camera response");
      return await r.json();
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  private async tick(generation: number): Promise<void> {
    const valid = () => this.active && generation === this.generation;
    let delay = 1000;
    try {
      const requestedAt = performance.now();
      if (!this.joined) {
        this.status.textContent = "カメラ共有を確認しています…";
        const join = await this.request(
          `${this.base}/members/${encodeURIComponent(this.memberId)}/camera/viewers`,
          { id: this.id, key: this.key },
        );
        if (!valid()) return;
        const pc = new RTCPeerConnection({
          iceServers: join.ice_servers,
          iceTransportPolicy: join.relay_only ? "relay" : "all",
        });
        this.peer = pc;
        this.joined = true;
        this.connectingSince = performance.now();
        this.lastReply = requestedAt;
        this.status.textContent = "映像に接続しています…";
        pc.onicecandidate = ({ candidate }) => {
          if (candidate && valid()) this.enqueue("ice", candidate.toJSON());
        };
        pc.ontrack = ({ track }) => {
          if (!valid()) return;
          this.video.srcObject = new MediaStream([track]);
          this.video.style.display = "block";
          // 映像領域を表示した時点で幅を確保する。フレーム到着・再生イベントは待たない。
          this.setVideoVisible(true);
          this.status.textContent = "映像の受信を待っています…";
          // トラック登録は映像の到着を意味しない。復号済みフレームの準備を待つ。
          const frameReady = () =>
            valid() && this.video.readyState >= 2 && this.video.videoWidth > 0;
          this.video.onloadeddata = () => {
            if (!frameReady()) return;
            this.receivedFrame = true;
            this.expand.hidden = false;
            this.status.textContent = "映像を受信しました。再生を待っています…";
          };
          this.video.onplaying = () => {
            if (!frameReady()) return;
            this.receivedFrame = true;
            this.expand.hidden = false;
            this.status.textContent = "カメラ共有中";
            this.play.hidden = true;
          };
          void this.video.play().catch(() => {
            if (valid()) this.play.hidden = false;
          });
          track.onended = () => {
            if (valid()) this.close("カメラ共有が終了しました。");
          };
        };
        pc.onconnectionstatechange = () => {
          if (!valid()) return;
          if (pc.connectionState === "failed")
            this.close("映像に接続できません。配信者に再開を依頼してください。", true);
          if (pc.connectionState === "disconnected")
            this.close("映像の接続が途切れました。配信者に再開を依頼してください。", true);
        };
      }
      const sent = this.pending.slice(0, 32);
      const started = performance.now();
      const response: Exchange = await this.request(`${this.connectionUrl}/exchange`, {
        key: this.key,
        after: this.after,
        messages: sent,
      });
      if (!valid()) return;
      this.lastReply = started; // Delayed replies must not extend permission beyond the server lease.
      this.pending.splice(0, sent.length);
      for (const signal of response.messages) {
        if (!valid()) return;
        const pc = this.peer!;
        if (signal.kind === "offer") {
          await pc.setRemoteDescription({ type: "offer", sdp: signal.data });
          if (!valid()) return;
          for (const candidate of this.remoteIce.splice(0)) await pc.addIceCandidate(candidate);
          const answer = await pc.createAnswer();
          if (!valid()) return;
          await pc.setLocalDescription(answer);
          if (!valid()) return;
          this.enqueue("answer", answer.sdp);
        } else if (pc.remoteDescription) await pc.addIceCandidate(signal.data);
        else this.remoteIce.push(signal.data);
        this.after = signal.id;
      }
    } catch (error) {
      if (!valid()) return;
      if (error instanceof CameraHttpError) {
        if (error.status === 404 && !this.joined) {
          this.status.textContent = "カメラは共有されていません。";
          delay = 5000;
        } else {
          this.close(
            error.status === 429
              ? "視聴人数が上限に達しています。開き直してください。"
              : "カメラ共有が終了したか、閲覧できなくなりました。",
          );
          return;
        }
      } else if (this.joined) {
        this.status.textContent = "接続を確認しています…";
      } else {
        this.status.textContent = "カメラに接続できません。";
        delay = 5000;
      }
    }
    if (valid()) this.timer = setTimeout(() => void this.tick(generation), delay);
  }
  private enqueue(kind: Signal["kind"], data: unknown): void {
    if (this.pending.length >= 128) {
      this.close("接続情報が多すぎるため停止しました。");
      return;
    }
    this.pending.push({ message_id: crypto.randomUUID(), viewer_id: this.id, kind, data });
  }
}
