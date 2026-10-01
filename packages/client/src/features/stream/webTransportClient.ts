import { apiRequest } from "../../api/client";
import type { StreamConnectTarget, StreamStatus, WorkerToMainMessage } from "./streamTypes";

interface WebTransportBootstrap {
  version: 1;
  url: string;
  serverCertificateHash: number[];
  expiresAt: number;
}

export class WebTransportStreamClient {
  private readonly worker: Worker;
  private canvas: HTMLCanvasElement | null = null;
  private disposed = false;

  constructor(private readonly onMessage: (message: WorkerToMainMessage) => void) {
    this.worker = new Worker(new URL("./webTransport.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "frame") this.onMessage({ type: "video-config", size: { width: data.width, height: data.height } });
      else if (data.type === "status") this.onMessage({ type: "status", status: data as StreamStatus });
      else if (data.type === "error") this.onMessage({ type: "status", status: { state: "error", error: data.error } });
    };
  }

  attachCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  clear() {
    this.canvas?.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  async connect(target: StreamConnectTarget) {
    if (!this.canvas) throw new Error("A canvas is required before connecting WebTransport.");
    const bootstrap = await apiRequest<WebTransportBootstrap>(`/api/simulators/${encodeURIComponent(target.udid)}/webtransport`, { method: "POST" });
    if (bootstrap.version !== 1 || bootstrap.serverCertificateHash.length !== 32) {
      throw new Error("Invalid WebTransport bootstrap response.");
    }
    const url = new URL(bootstrap.url, window.location.href);
    const transferable = this.canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: "connect", url: url.toString(), serverCertificateHash: bootstrap.serverCertificateHash, canvas: transferable }, [transferable]);
  }

  sendControl(payload: unknown) {
    void payload;
    return false;
  }

  disconnect() {
    this.worker.postMessage({ type: "disconnect" });
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.postMessage({ type: "disconnect" });
    this.worker.terminate();
  }
}
