# WebTransport fallback spike

**Handoff status: incomplete experiment, not a working or release-ready fallback.**

Branch: `feat/webtransport-fallback` on `thejustinwalsh/SimDeck` only.
Base: upstream `main` at `2d7346b68a46ffd92c7353aac5ee6a5490fcbb03`.
No Xcode 27 changes are included. No upstream PR is authorized by this handoff.
The installed working SimDeck service has not been replaced by this spike.

## Resume here

1. Resolve `wtransport 0.7.2` using Cargo, generate/review Cargo.lock, and compile.
   The previous attempt could not reach the registry; Rust API compatibility is
   unverified. Do not claim the server builds from formatting checks.
2. Finish the browser lifecycle: replace one-time canvas transfer with transferable
   VideoFrame rendering or recreate the canvas reliably on transport switches.
   Handle packet loss by discarding dependent deltas until a new keyframe, reorder
   complete frames, bound decode queues, and release readers/frames on every exit.
3. Verify the ephemeral certificate meets browser hash-pinning requirements
   (including lifetime and key algorithm), then implement rotation and shutdown.
4. Verify authenticated POST bootstrap, allowed Origin, expired/replayed tickets,
   malformed datagrams and loss recovery. Add focused tests to existing suites.
5. Run the tool through its native CLI, directly on its reported localhost URL,
   with `SIMDECK_ENABLE_WEBTRANSPORT=1`. No Portless and no OS trust changes.
   Explicitly select `stream=webtransport`; automatic fallback policy is not done.
6. In a separate fork integration branch, apply the Xcode 27 #87 fix for this
   machine. Keep it out of the standalone feature diff. Test Chrome with WebRTC
   blocked, Safari/default WebRTC, side-panel viewing, input, reconnects, rotation,
   decoder loss recovery and resource use before installing or updating skill pins.

Validation so far: client TypeScript check and 3 protocol tests passed using
an existing cached toolchain; cargo fmt and git diff checks passed. Cargo check,
lockfile resolution and end-to-end QUIC/video/input validation remain undone.
See WEBTRANSPORT-CLIENT-HANDOFF.md for the client contract and known gaps.

## Transport design

This spike adds a loopback-only QUIC endpoint beside the existing TCP API. The
existing WebRTC endpoint remains unchanged. The authenticated
`POST /api/simulators/{udid}/webtransport` bootstrap route issues a 30-second,
single-use ticket bound to the request origin and simulator UDID. It returns
the `https://127.0.0.1:<udp-port>/...` URL and the ephemeral self-signed
certificate's SHA-256 DER hash for browser `serverCertificateHashes`. No
certificate is installed into OS trust.

Video uses WebTransport datagrams. Every datagram is at most the negotiated
`Connection::max_datagram_size()` and starts with a 24-byte header:

```text
SDV1 (4) | sequence u32be | fragmentIndex u16be | fragmentCount u16be |
totalBytes u32be | timestampUs f64be | payload
```

The reassembled payload is `u32be JSON length`, version 1 JSON metadata, then
the AVCC encoded bytes. Metadata contains `frameSequence`, `timestampUs`,
`isKeyFrame`, `width`, `height`, `codec`, and optional `description` bytes.
The server fragments every frame and never sends a whole frame as one
datagram. A reliable bidirectional stream accepts length-prefixed JSON control
messages; `{"type":"keyframe"}` requests recovery. Datagram loss is handled
by the client detecting a sequence/fragment gap and requesting a keyframe.

The server keeps only the current frame plus the bounded broadcast subscription
buffer; it does not gate frame production on ACKs. Existing iOS subscription
drop cleanup and Android native encoder ownership are reused through the
shared source factory.

Known spike limitations/TODOs:

- The endpoint is opt-in with `SIMDECK_ENABLE_WEBTRANSPORT=1`; initialization
  failure is logged and leaves the existing WebRTC service running.
- Client scaffolding is included; browser runtime verification and QUIC certificate
  rotation are unfinished.
- Bootstrap currently reports `maxDatagramSize: 0`; the client must use the
  negotiated connection value from its WebTransport session. The field is
  retained only for contract discovery.
- The accept loop is process-lifetime state and has no explicit shutdown hook;
  endpoint drop during process shutdown remains the cleanup path.
- The endpoint binds `127.0.0.1:0`, so this is intentionally local-browser
  only. LAN/Cloudflare exposure needs a separate certificate and bind policy.
