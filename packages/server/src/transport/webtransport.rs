use crate::api::routes::AppState;
use crate::auth;
use crate::transport::packet::FramePacket;
use crate::transport::webrtc::{create_video_source, wait_for_h264_sync_keyframe};
use axum::http::HeaderMap;
use bytes::Bytes;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio::time;
use tracing::warn;
use wtransport::{Endpoint, Identity, ServerConfig};

const TICKET_TTL: Duration = Duration::from_secs(30);
const MAX_TICKETS: usize = 256;
const CONTROL_STREAM_TIMEOUT: Duration = Duration::from_secs(5);
const VIDEO_MAGIC: &[u8; 4] = b"SDV1";
const VIDEO_HEADER_BYTES: usize = 24;

static SERVER: OnceLock<Arc<WebTransportServer>> = OnceLock::new();

struct Ticket {
    udid: String,
    origin: String,
    expires_at: SystemTime,
}

pub struct WebTransportServer {
    endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>,
    certificate_hash: [u8; 32],
    tickets: Mutex<HashMap<String, Ticket>>,
    state: AppState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub version: u8,
    pub url: String,
    pub server_certificate_hash: [u8; 32],
    pub ticket: String,
    pub expires_at: u64,
    pub max_datagram_size: usize,
}

pub async fn start(state: AppState) -> anyhow::Result<()> {
    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
    let certificate_hash = *identity
        .certificate_chain()
        .as_slice()
        .first()
        .ok_or_else(|| anyhow::anyhow!("WebTransport identity has no certificate"))?
        .hash()
        .as_ref();
    let config = ServerConfig::builder()
        .with_bind_address(SocketAddr::new(
            IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            0,
        ))
        .with_identity(identity)
        .build();
    let endpoint = Endpoint::server(config)?;
    let server = Arc::new(WebTransportServer {
        endpoint,
        certificate_hash,
        tickets: Mutex::new(HashMap::new()),
        state,
    });
    SERVER
        .set(server.clone())
        .map_err(|_| anyhow::anyhow!("WebTransport endpoint initialized twice"))?;
    tokio::spawn(accept_loop(server));
    Ok(())
}

pub fn bootstrap(
    state: &AppState,
    udid: &str,
    headers: &HeaderMap,
) -> anyhow::Result<BootstrapResponse> {
    let server = SERVER
        .get()
        .ok_or_else(|| anyhow::anyhow!("WebTransport endpoint is unavailable"))?;
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| anyhow::anyhow!("WebTransport bootstrap requires an Origin header"))?;
    if !auth::origin_is_allowed_for_webtransport(&state.config, origin) {
        anyhow::bail!("WebTransport origin is not allowed");
    }
    let ticket = crate::auth::generate_access_token();
    let expires_at = SystemTime::now() + TICKET_TTL;
    let mut tickets = server.tickets.lock().unwrap();
    let now = SystemTime::now();
    tickets.retain(|_, ticket| ticket.expires_at > now);
    while tickets.len() >= MAX_TICKETS {
        let Some(oldest) = tickets
            .iter()
            .min_by_key(|(_, ticket)| ticket.expires_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        tickets.remove(&oldest);
    }
    tickets.insert(
        ticket.clone(),
        Ticket {
            udid: udid.to_owned(),
            origin: origin.to_owned(),
            expires_at,
        },
    );
    let address = server.endpoint.local_addr()?;
    Ok(BootstrapResponse {
        version: 1,
        url: format!(
            "https://127.0.0.1:{}/api/simulators/{udid}/video?ticket={ticket}",
            address.port()
        ),
        server_certificate_hash: server.certificate_hash,
        ticket,
        expires_at: expires_at.duration_since(UNIX_EPOCH)?.as_secs(),
        max_datagram_size: 0,
    })
}

async fn accept_loop(server: Arc<WebTransportServer>) {
    loop {
        let incoming = server.endpoint.accept().await;
        let server = server.clone();
        tokio::spawn(async move {
            let Ok(request) = incoming.await else { return };
            let Some((udid, ticket)) =
                ticket_for_request(&server, request.path(), request.origin())
            else {
                request.forbidden().await;
                return;
            };
            let Ok(connection) = request.accept().await else {
                return;
            };
            handle_connection(server.state.clone(), connection, udid).await;
            drop(ticket);
        });
    }
}

fn ticket_for_request(
    server: &WebTransportServer,
    path: &str,
    origin: Option<&str>,
) -> Option<(String, Ticket)> {
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let udid = path
        .strip_prefix("/api/simulators/")?
        .strip_suffix("/video")?;
    let ticket = query
        .split('&')
        .find_map(|part| part.strip_prefix("ticket="))?;
    let origin = origin?;
    let mut tickets = server.tickets.lock().ok()?;
    let ticket_data = tickets.remove(ticket)?;
    if ticket_data.udid != udid
        || ticket_data.origin != origin
        || ticket_data.expires_at <= SystemTime::now()
    {
        return None;
    }
    Some((udid.to_owned(), ticket_data))
}

async fn handle_connection(state: AppState, connection: wtransport::Connection, udid: String) {
    let Some(max_datagram_size) = connection.max_datagram_size() else {
        return;
    };
    let source = match create_video_source(&state, &udid).await {
        Ok(source) => source,
        Err(error) => {
            warn!("WebTransport source setup failed for {udid}: {error}");
            return;
        }
    };
    let Some(mut control) = time::timeout(CONTROL_STREAM_TIMEOUT, accept_control(&connection))
        .await
        .ok()
        .flatten()
    else {
        return;
    };
    let Some(first) = wait_for_h264_sync_keyframe(&source, Duration::from_secs(5)).await else {
        return;
    };
    let mut frames = source.subscribe();
    let (keyframe_tx, mut keyframe_rx) = mpsc::channel(4);
    tokio::spawn(async move {
        while let Some(message) = control.recv().await {
            if message == "keyframe" {
                let _ = keyframe_tx.send(()).await;
            }
        }
    });
    let mut pending = Some(first);
    let mut waiting_for_keyframe = false;
    loop {
        if keyframe_rx.try_recv().is_ok() {
            source.request_keyframe();
        }
        let frame = if let Some(frame) = pending.take() {
            frame
        } else {
            match tokio::select! {
                result = frames.recv() => result,
                _ = connection.closed() => return,
            } {
                Ok(frame) if !waiting_for_keyframe || frame.is_keyframe => {
                    waiting_for_keyframe = false;
                    frame
                }
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                Err(_) => {
                    source.request_keyframe();
                    continue;
                }
            }
        };
        let packets = match fragment_frame(&frame, max_datagram_size) {
            Ok(packets) => packets,
            Err(error) => {
                warn!("WebTransport frame rejected for {udid}: {error}");
                return;
            }
        };
        for packet in packets {
            if connection.send_datagram(packet).is_err() {
                return;
            }
        }
        match tokio::select! {
            result = frames.recv() => Some(result),
            _ = connection.closed() => None,
        } {
            None => return,
            Some(Ok(next)) => {
                if !waiting_for_keyframe || next.is_keyframe {
                    waiting_for_keyframe = false;
                    pending = Some(next);
                }
            }
            Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                waiting_for_keyframe = true;
                source.request_keyframe();
            }
            Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return,
            Some(Err(_)) => {
                waiting_for_keyframe = true;
                source.request_keyframe();
            }
        }
    }
}

struct ControlReceiver {
    receiver: wtransport::RecvStream,
}

impl ControlReceiver {
    async fn recv(&mut self) -> Option<String> {
        let mut length = [0u8; 4];
        self.receiver.read_exact(&mut length).await.ok()?;
        let length = u32::from_be_bytes(length) as usize;
        if length > 4096 {
            return None;
        }
        let mut body = vec![0u8; length];
        self.receiver.read_exact(&mut body).await.ok()?;
        let value: Value = serde_json::from_slice(&body).ok()?;
        value
            .get("type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    }
}

async fn accept_control(connection: &wtransport::Connection) -> Option<ControlReceiver> {
    let (_, receiver) = connection.accept_bi().await.ok()?;
    Some(ControlReceiver { receiver })
}

fn fragment_frame(
    frame: &FramePacket,
    max_datagram_size: usize,
) -> Result<Vec<Bytes>, &'static str> {
    if max_datagram_size <= VIDEO_HEADER_BYTES {
        return Err("negotiated datagram size is too small for the video header");
    }
    let metadata = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "frameSequence": frame.frame_sequence,
        "timestampUs": frame.timestamp_us,
        "isKeyFrame": frame.is_keyframe,
        "width": frame.width,
        "height": frame.height,
        "codec": frame.codec.as_deref().unwrap_or_default(),
        "description": frame.description.as_ref().map(|value| value.to_vec()),
    }))
    .unwrap_or_default();
    let mut payload = Vec::with_capacity(4 + metadata.len() + frame.data.len());
    payload.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    payload.extend_from_slice(&metadata);
    payload.extend_from_slice(&frame.data);
    let chunk_size = max_datagram_size.saturating_sub(VIDEO_HEADER_BYTES).max(1);
    let count = payload.len().div_ceil(chunk_size).max(1);
    let count = u16::try_from(count).map_err(|_| "video frame exceeds fragment count limit")?;
    Ok(payload
        .chunks(chunk_size)
        .enumerate()
        .map(|(index, chunk)| {
            let mut packet = Vec::with_capacity(VIDEO_HEADER_BYTES + chunk.len());
            packet.extend_from_slice(VIDEO_MAGIC);
            packet.extend_from_slice(&(frame.frame_sequence as u32).to_be_bytes());
            packet.extend_from_slice(&(index as u16).to_be_bytes());
            packet.extend_from_slice(&count.to_be_bytes());
            packet.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            packet.extend_from_slice(&(frame.timestamp_us as f64).to_be_bytes());
            packet.extend_from_slice(chunk);
            Bytes::from(packet)
        })
        .collect())
}
