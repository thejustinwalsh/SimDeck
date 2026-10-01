const HEADER_BYTES = 24;
const MAGIC = new Uint8Array([0x53, 0x44, 0x56, 0x31]);

export interface VideoDatagramFragment {
  sequence: number;
  fragmentIndex: number;
  fragmentCount: number;
  totalBytes: number;
  timestampUs: number;
  payload: Uint8Array;
}

export interface VideoFramePacket {
  frameSequence: number;
  timestampUs: number;
  isKeyFrame: boolean;
  width: number;
  height: number;
  codec: string;
  description: Uint8Array | null;
  payload: Uint8Array;
}

export function parseVideoDatagram(data: ArrayBuffer | Uint8Array): VideoDatagramFragment {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < HEADER_BYTES || !MAGIC.every((value, index) => bytes[index] === value)) {
    throw new Error("Invalid SimDeck video datagram header.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fragmentCount = view.getUint16(10);
  const fragmentIndex = view.getUint16(8);
  const totalBytes = view.getUint32(12);
  if (fragmentCount === 0 || fragmentIndex >= fragmentCount || totalBytes === 0) {
    throw new Error("Invalid SimDeck video fragment bounds.");
  }
  return {
    sequence: view.getUint32(4),
    fragmentIndex,
    fragmentCount,
    totalBytes,
    timestampUs: view.getFloat64(16),
    payload: bytes.subarray(HEADER_BYTES),
  };
}

interface PendingFrame {
  createdAt: number;
  fragmentCount: number;
  fragments: Array<Uint8Array | undefined>;
  receivedBytes: number;
  timestampUs: number;
  totalBytes: number;
}

export class VideoDatagramReassembler {
  private readonly pending = new Map<number, PendingFrame>();
  private pendingBytes = 0;

  constructor(
    private readonly options: {
      maxFrameBytes?: number;
      maxPendingBytes?: number;
      deadlineMs?: number;
    } = {},
  ) {}

  push(fragment: VideoDatagramFragment, now = Date.now()): Uint8Array | null {
    this.expire(now);
    const maxFrameBytes = this.options.maxFrameBytes ?? 8 * 1024 * 1024;
    const maxPendingBytes = this.options.maxPendingBytes ?? 16 * 1024 * 1024;
    if (fragment.totalBytes > maxFrameBytes || fragment.payload.byteLength > maxFrameBytes) {
      return null;
    }
    let frame = this.pending.get(fragment.sequence);
    if (!frame) {
      frame = {
        createdAt: now,
        fragmentCount: fragment.fragmentCount,
        fragments: new Array(fragment.fragmentCount),
        receivedBytes: 0,
        timestampUs: fragment.timestampUs,
        totalBytes: fragment.totalBytes,
      };
      this.pending.set(fragment.sequence, frame);
    }
    if (
      frame.fragmentCount !== fragment.fragmentCount ||
      frame.totalBytes !== fragment.totalBytes ||
      frame.fragments[fragment.fragmentIndex]
    ) {
      return null;
    }
    if (this.pendingBytes + fragment.payload.byteLength > maxPendingBytes) {
      this.pending.delete(fragment.sequence);
      return null;
    }
    frame.fragments[fragment.fragmentIndex] = fragment.payload;
    frame.receivedBytes += fragment.payload.byteLength;
    this.pendingBytes += fragment.payload.byteLength;
    if (frame.fragments.some((part) => !part) || frame.receivedBytes !== frame.totalBytes) {
      return null;
    }
    const output = new Uint8Array(frame.totalBytes);
    let offset = 0;
    for (const part of frame.fragments) {
      output.set(part!, offset);
      offset += part!.byteLength;
    }
    this.pending.delete(fragment.sequence);
    this.pendingBytes -= frame.receivedBytes;
    return output;
  }

  expire(now = Date.now()): void {
    const deadlineMs = this.options.deadlineMs ?? 250;
    for (const [sequence, frame] of this.pending) {
      if (now - frame.createdAt > deadlineMs) {
        this.pending.delete(sequence);
        this.pendingBytes -= frame.receivedBytes;
      }
    }
  }
}

export function parseVideoFramePayload(data: Uint8Array): VideoFramePacket {
  if (data.byteLength < 4) throw new Error("Video frame payload is truncated.");
  const jsonBytes = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (jsonBytes > data.byteLength - 4) throw new Error("Video frame metadata is truncated.");
  const metadata = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + jsonBytes))) as Record<string, unknown>;
  const numberField = (name: string) => {
    const value = metadata[name];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid video metadata field: ${name}`);
    return value;
  };
  const description = metadata.description == null ? null : Uint8Array.from(metadata.description as number[]);
  return {
    frameSequence: numberField("frameSequence"),
    timestampUs: numberField("timestampUs"),
    isKeyFrame: metadata.isKeyFrame === true,
    width: numberField("width"),
    height: numberField("height"),
    codec: typeof metadata.codec === "string" ? metadata.codec : "avc1.640028",
    description,
    payload: data.subarray(4 + jsonBytes),
  };
}

export function encodeLengthPrefixedJson(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const output = new Uint8Array(4 + bytes.byteLength);
  new DataView(output.buffer).setUint32(0, bytes.byteLength);
  output.set(bytes, 4);
  return output;
}
