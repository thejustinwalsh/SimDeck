import { describe, expect, it } from "vitest";
import {
  parseVideoDatagram,
  parseVideoFramePayload,
  VideoDatagramReassembler,
} from "./webTransportProtocol";

function fragment(sequence: number, index: number, count: number, total: number, body: Uint8Array) {
  const output = new Uint8Array(24 + body.length);
  output.set([0x53, 0x44, 0x56, 0x31]);
  const view = new DataView(output.buffer);
  view.setUint32(4, sequence);
  view.setUint16(8, index);
  view.setUint16(10, count);
  view.setUint32(12, total);
  view.setFloat64(16, 1234);
  output.set(body, 24);
  return output;
}

describe("WebTransport video protocol", () => {
  it("parses and reassembles bounded out-of-order fragments", () => {
    const reassembler = new VideoDatagramReassembler();
    const first = parseVideoDatagram(fragment(7, 1, 2, 3, new Uint8Array([2])));
    const second = parseVideoDatagram(fragment(7, 0, 2, 3, new Uint8Array([1, 3])));
    expect(reassembler.push(first)).toBeNull();
    expect(reassembler.push(second)).toEqual(new Uint8Array([1, 3, 2]));
  });

  it("rejects malformed headers and expires incomplete frames", () => {
    expect(() => parseVideoDatagram(new Uint8Array(24))).toThrow("header");
    const reassembler = new VideoDatagramReassembler({ deadlineMs: 10 });
    const part = parseVideoDatagram(fragment(1, 0, 2, 2, new Uint8Array([1])));
    expect(reassembler.push(part, 0)).toBeNull();
    reassembler.expire(11);
    expect(reassembler.push(part, 12)).toBeNull();
  });

  it("splits metadata from AVCC payload", () => {
    const metadata = new TextEncoder().encode(JSON.stringify({
      frameSequence: 3,
      timestampUs: 9,
      isKeyFrame: true,
      width: 640,
      height: 480,
      codec: "avc1.640028",
      description: [1, 2],
    }));
    const payload = new Uint8Array(4 + metadata.length + 2);
    new DataView(payload.buffer).setUint32(0, metadata.length);
    payload.set(metadata, 4);
    payload.set([0, 1], 4 + metadata.length);
    expect(parseVideoFramePayload(payload)).toMatchObject({
      frameSequence: 3,
      width: 640,
      description: new Uint8Array([1, 2]),
      payload: new Uint8Array([0, 1]),
    });
  });
});
