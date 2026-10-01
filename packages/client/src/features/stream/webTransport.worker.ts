import {
  encodeLengthPrefixedJson,
  parseVideoDatagram,
  parseVideoFramePayload,
  VideoDatagramReassembler,
} from "./webTransportProtocol";

interface ConnectMessage {
  type: "connect";
  url: string;
  serverCertificateHash: number[];
  canvas: OffscreenCanvas;
}

let transport: WebTransport | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let decoder: VideoDecoder | null = null;
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let lastFrameSequence = -1;

function post(message: unknown) {
  self.postMessage(message);
}

async function connect(message: ConnectMessage) {
  if (typeof WebTransport !== "function" || typeof VideoDecoder !== "function") {
    throw new Error("WebTransport and WebCodecs VideoDecoder are required.");
  }
  canvas = message.canvas;
  context = canvas.getContext("2d");
  transport = new WebTransport(message.url, {
    serverCertificateHashes: [{ algorithm: "sha-256", value: Uint8Array.from(message.serverCertificateHash) }],
  });
  await transport.ready;
  const control = await transport.createBidirectionalStream();
  writer = control.writable.getWriter();
  void readControl(control.readable);
  decoder = new VideoDecoder({
    output: (frame) => {
      if (!canvas || !context) return;
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      context.drawImage(frame, 0, 0);
      frame.close();
      post({ type: "frame", width: canvas.width, height: canvas.height });
    },
    error: (error) => post({ type: "error", error: error.message }),
  });
  const reassembler = new VideoDatagramReassembler();
  post({ type: "status", state: "streaming" });
  const datagramReader = transport.datagrams.readable.getReader();
  while (true) {
    const { done, value: datagram } = await datagramReader.read();
    if (done) break;
    if (!datagram) continue;
    const fragment = parseVideoDatagram(datagram);
    const payload = reassembler.push(fragment);
    if (!payload) continue;
    const packet = parseVideoFramePayload(payload);
    if (!packet.isKeyFrame && (lastFrameSequence < 0 || packet.frameSequence > lastFrameSequence + 1)) {
      await sendControl({ type: "keyframe" });
    }
    lastFrameSequence = packet.frameSequence;
    if (!decoder.configure) continue;
    if (decoder.state === "unconfigured") {
      decoder.configure({ codec: packet.codec, codedWidth: packet.width, codedHeight: packet.height, description: packet.description ?? undefined });
    }
    decoder.decode(new EncodedVideoChunk({ type: packet.isKeyFrame ? "key" : "delta", timestamp: packet.timestampUs, data: packet.payload }));
  }
  datagramReader.releaseLock();
}

async function sendControl(value: unknown) {
  if (!writer) return;
  await writer.write(encodeLengthPrefixedJson(value));
}

async function readControl(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

self.onmessage = (event: MessageEvent<ConnectMessage | { type: "control"; value: unknown } | { type: "disconnect" }>) => {
  if (event.data.type === "connect") {
    void connect(event.data).catch((error: unknown) => post({ type: "error", error: error instanceof Error ? error.message : String(error) }));
  } else if (event.data.type === "control") {
    void sendControl(event.data.value);
  } else {
    void transport?.close();
    decoder?.close();
    transport = null;
  }
};
