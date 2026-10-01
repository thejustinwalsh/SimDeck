# WebTransport client spike

This spike adds an explicit `stream=webtransport` client path while keeping
WebRTC as the default and existing fallback. It is intentionally isolated to
the browser client; the Rust implementation is described in WEBTRANSPORT-HANDOFF.md.

The client requests `POST /api/simulators/{udid}/webtransport` and expects:

```json
{
  "version": 1,
  "url": "https://…",
  "serverCertificateHash": [32],
  "expiresAt": 1790812800
}
```

The certificate hash is passed to the `WebTransport` constructor as a SHA-256
`serverCertificateHashes` entry. The authenticated same-origin bootstrap request
is the only client API request; the returned transport ticket is used as-is.
No certificate or trust changes are made by the client.

`webTransportProtocol.ts` parses the 24-byte `SDV1` datagram header, bounds
fragment/frame memory, expires incomplete frames, reassembles out-of-order
fragments, and parses the length-prefixed UTF-8 metadata followed by AVCC
bytes. `webTransport.worker.ts` owns the transport, reliable length-prefixed
JSON control stream, WebCodecs H.264 decoder, and OffscreenCanvas output.
Sequence gaps request a keyframe when the missing dependency is not itself a
keyframe. There is no per-frame ACK or decode gating.

Known spike limits:

- The Rust bootstrap and transport endpoint are included in this branch but have not been compiled or exercised together.
- The server must provide AVCC-compatible H.264 payloads and a valid 32-byte
  certificate hash.
- Decoder recovery after a closed transport and richer worker statistics remain
  follow-up work.
- This spike transfers the canvas to the worker once. Reconnect or switching
  away from WebTransport requires a fresh canvas until rendering is promoted to
  transferable `VideoFrame` objects.
- Ordinary pointer/keyboard controls remain on the existing WebSocket/DataChannel
  path; the reliable WebTransport stream only carries keyframe requests.
- Browser support must be validated on the target Chromium/WebTransport builds;
  WebRTC remains the safe default.

Validation was limited to static inspection and protocol tests because this
handoff does not install dependencies or launch a server. The existing client
dependency tree was not modified.
