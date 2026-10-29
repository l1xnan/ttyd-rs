use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Extension, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use bytes::{Bytes, BytesMut};
use futures_util::SinkExt;
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::MissedTickBehavior;
use tracing::{debug, info, warn};
use url::Url;

use crate::config::hostname;
use crate::pty::{InputReject, PtySession, SessionEvent, SessionStatus, MAX_INPUT_FRAME};
use crate::server::{peer_string, AppState, AuthUser};
use crate::session::{AttachError, AttachRequest, ManagedSession, SessionManager};
use crate::tls::ConnInfo;

pub(crate) const CLOSE_NORMAL: u16 = 1000;
pub(crate) const CLOSE_GOING_AWAY: u16 = 1001;
pub(crate) const CLOSE_POLICY: u16 = 1008;
pub(crate) const CLOSE_TOO_LARGE: u16 = 1009;
pub(crate) const CLOSE_ERROR: u16 = 1011;
const PAUSE_BUFFER_LIMIT: usize = 1024 * 1024;
const REPLAY_CHUNK_SIZE: usize = 64 * 1024;
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

pub async fn handler(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    uri: Uri,
    Extension(auth): Extension<AuthUser>,
    connect: ConnectInfo<ConnInfo>,
) -> Response {
    let peer = peer_string(&connect);

    if state.config.once && state.clients.load(Ordering::SeqCst) > 0 {
        warn!("refuse to serve WS client due to the --once option.");
        return StatusCode::FORBIDDEN.into_response();
    }

    if state.config.max_clients > 0
        && state.clients.load(Ordering::SeqCst) >= state.config.max_clients
    {
        warn!("refuse to serve WS client due to the --max-clients option.");
        return StatusCode::FORBIDDEN.into_response();
    }

    if state.config.check_origin && !check_origin(&headers) {
        warn!("refuse to serve WS client from different origin due to the --check-origin option.");
        return StatusCode::FORBIDDEN.into_response();
    }

    let mut current = state.clients.load(Ordering::SeqCst);
    loop {
        if state.config.once && current > 0 {
            return StatusCode::FORBIDDEN.into_response();
        }
        if state.config.max_clients > 0 && current >= state.config.max_clients {
            return StatusCode::FORBIDDEN.into_response();
        }
        match state.clients.compare_exchange_weak(
            current,
            current + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }

    let clients = current + 1;
    info!(
        "WS   {} - {}, clients: {}",
        state.config.endpoints.ws, peer, clients
    );

    let guard = ClientGuard {
        state: state.clone(),
        peer: peer.clone(),
    };
    let args = if state.config.url_arg {
        parse_url_args(&uri)
    } else {
        Vec::new()
    };

    ws.protocols(["tty"]).on_upgrade(move |socket| async move {
        let result = run_socket(socket, state.clone(), auth.user, args).await;
        if let Err(error) = result {
            debug!("WS connection ended with error: {error}");
        }
        drop(guard);
    })
}

struct ClientGuard {
    state: Arc<AppState>,
    peer: String,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        let clients = self
            .state
            .clients
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1);
        info!("WS closed from {}, clients: {}", self.peer, clients);
        if (self.state.config.once || self.state.config.exit_no_conn) && clients == 0 {
            info!("exiting due to the --once/--exit-no-conn option.");
            self.state.shutdown.cancel();
        }
    }
}

struct Initial {
    columns: u16,
    rows: u16,
    session: Option<String>,
    session_timeout: Option<u64>,
}

/// Keeps a session attached for as long as the WebSocket lifetime, even when
/// the function returns through an error path.
struct Attachment {
    manager: Arc<SessionManager>,
    session: Arc<ManagedSession>,
}

impl Attachment {
    fn new(manager: Arc<SessionManager>, session: Arc<ManagedSession>) -> Self {
        Self { manager, session }
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.manager.detach(&self.session);
    }
}

fn parse_url_args(uri: &Uri) -> Vec<String> {
    form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .filter_map(|(key, value)| (key == "arg").then(|| value.into_owned()))
        .collect()
}

fn check_origin(headers: &HeaderMap) -> bool {
    let origin = match headers.get(ORIGIN).and_then(|value| value.to_str().ok()) {
        Some(origin) => origin,
        None => return false,
    };
    let url = match Url::parse(origin) {
        Ok(url) => url,
        Err(_) => return false,
    };
    let mut origin_host = match url.host_str() {
        Some(host) => host.to_owned(),
        None => return false,
    };
    if let Some(port) = url.port() {
        if port != 80 && port != 443 {
            origin_host.push(':');
            origin_host.push_str(&port.to_string());
        }
    }

    headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(&origin_host))
}

async fn run_socket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    user: Option<String>,
    args: Vec<String>,
) -> anyhow::Result<()> {
    send_initial(&mut socket, &state).await?;

    let initial = match wait_initial(&mut socket, &state).await? {
        Some(initial) => initial,
        None => return Ok(()),
    };
    let mut columns = if initial.columns == 0 {
        80
    } else {
        initial.columns
    };
    let mut rows = if initial.rows == 0 { 24 } else { initial.rows };

    let timeout = state.sessions.resolve_timeout(initial.session_timeout);
    let (session, created) = match state.sessions.attach_or_create(AttachRequest {
        session_id: initial.session.as_deref(),
        owner: user.as_deref(),
        columns,
        rows,
        user: user.as_deref(),
        args: &args,
        timeout,
    }) {
        Ok(result) => result,
        Err(AttachError::Forbidden) => {
            warn!("refuse to attach to a session owned by another user");
            close(&mut socket, CLOSE_POLICY).await;
            return Ok(());
        }
        Err(AttachError::Spawn(error)) => {
            warn!("pty_spawn: {error}");
            close(&mut socket, CLOSE_ERROR).await;
            return Ok(());
        }
    };

    let _attachment = Attachment::new(state.sessions.clone(), session.clone());
    send_frame(&mut socket, b'3', session.id.as_bytes()).await?;
    session.pty.resize(columns, rows);

    if created {
        if let Some(pid) = session.pty.pid() {
            info!("started process, pid: {pid}, session: {}", session.id);
        }
    } else {
        info!("attached to session: {}", session.id);
    }

    let mut events = session.pty.subscribe();
    let mut status_rx = session.pty.status();
    let (snapshot, mut last_offset) = session.pty.snapshot();
    send_replay(&mut socket, &snapshot).await?;

    let mut paused = false;
    let mut pending: Option<Bytes> = None;
    let mut paused_output: VecDeque<Bytes> = VecDeque::new();
    let mut paused_bytes = 0usize;
    let mut held_input: Option<Vec<u8>> = None;
    let mut input_blocked = false;
    let mut eof = false;
    let mut exit_code = match *status_rx.borrow() {
        SessionStatus::Exited(code) => Some(code),
        SessionStatus::Running => None,
    };
    let mut drain_deadline = exit_code.map(|_| Instant::now() + EXIT_DRAIN_TIMEOUT);

    let mut ping = if state.config.ping_interval > 0 {
        // Check once a second so the ping is sent near the configured
        // interval and the hangup happens near interval + 7 seconds.
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        interval.tick().await;
        Some(interval)
    } else {
        None
    };
    let mut last_activity = Instant::now();
    let mut last_ping_sent: Option<Instant> = None;
    let input_tx = session.pty.input_tx.clone();
    let ping_interval = Duration::from_secs(state.config.ping_interval);
    let ping_timeout = Duration::from_secs(state.config.ping_interval.saturating_add(7));

    loop {
        if !paused {
            if pending.is_none() {
                if let Some(data) = paused_output.pop_front() {
                    paused_bytes = paused_bytes.saturating_sub(data.len());
                    pending = Some(data);
                }
            }
            if let Some(data) = pending.take() {
                send_output(&mut socket, &data).await?;
            }
        } else if let Some(data) = pending.take() {
            if queue_paused(&mut paused_output, &mut paused_bytes, data) {
                warn!("closing WebSocket: paused output buffer is full");
                close(&mut socket, CLOSE_ERROR).await;
                return Ok(());
            }
        }

        if exit_code.is_some()
            && (eof || drain_deadline.is_some_and(|deadline| Instant::now() >= deadline))
        {
            flush_pending(
                &mut socket,
                &mut pending,
                &mut paused_output,
                &mut paused_bytes,
            )
            .await?;
            let code = exit_code.unwrap_or(-1);
            info!("session {} exited with code {code}", session.id);
            let close_code = if code == 0 { CLOSE_NORMAL } else { CLOSE_ERROR };
            close(&mut socket, close_code).await;
            break;
        }

        tokio::select! {
            biased;
            _ = state.shutdown.cancelled() => {
                close(&mut socket, CLOSE_GOING_AWAY).await;
                return Ok(());
            }
            permit = input_tx.reserve(), if input_blocked => {
                input_blocked = false;
                match permit {
                    Ok(permit) => {
                        if let Some(data) = held_input.take() {
                            permit.send(data);
                        }
                    }
                    Err(_) => {
                        warn!("PTY input closed");
                        close(&mut socket, CLOSE_ERROR).await;
                        return Ok(());
                    }
                }
            }
            message = socket.recv(), if !input_blocked => {
                match message {
                    Some(Ok(message)) => {
                        last_activity = Instant::now();
                        last_ping_sent = None;
                        match handle_message(&session.pty, &state, message, &mut paused, &mut columns, &mut rows).await? {
                            Control::Continue => {}
                            Control::Close => {
                                // The close reply is queued by tungstenite when the
                                // peer's close frame is read. Flush it so the client
                                // observes a clean close handshake.
                                let _ = socket.flush().await;
                                return Ok(());
                            }
                            Control::Hold(data) => {
                                held_input = Some(data);
                                input_blocked = true;
                            }
                            Control::Fail(code) => {
                                warn!("closing WebSocket because input was rejected ({code})");
                                close(&mut socket, code).await;
                                return Ok(());
                            }
                        }
                    }
                    Some(Err(error)) => {
                        debug!("WS receive error: {error}");
                        break;
                    }
                    None => break,
                }
            }
            event = events.recv(), if !eof => {
                match event {
                    Ok(SessionEvent::Data(frame)) => {
                        let frame_end = frame.end();
                        if frame_end <= last_offset {
                            continue;
                        }
                        let data = if frame.offset < last_offset {
                            frame.data.slice((last_offset - frame.offset) as usize..)
                        } else {
                            frame.data
                        };
                        last_offset = frame_end;
                        if paused {
                            if queue_paused(&mut paused_output, &mut paused_bytes, data) {
                                warn!("closing WebSocket: paused output buffer is full");
                                close(&mut socket, CLOSE_ERROR).await;
                                return Ok(());
                            }
                        } else {
                            pending = Some(data);
                        }
                    }
                    Ok(SessionEvent::Eof) | Err(RecvError::Closed) => {
                        eof = true;
                        if exit_code.is_none() {
                            drain_deadline = Some(Instant::now() + EXIT_DRAIN_TIMEOUT);
                        }
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        warn!("closing WebSocket: output receiver lagged by {skipped} frames");
                        close(&mut socket, CLOSE_ERROR).await;
                        return Ok(());
                    }
                }
            }
            status = status_rx.changed(), if exit_code.is_none() => {
                if status.is_ok() {
                    if let SessionStatus::Exited(code) = *status_rx.borrow() {
                        exit_code = Some(code);
                        drain_deadline = Some(Instant::now() + EXIT_DRAIN_TIMEOUT);
                    }
                } else {
                    exit_code = Some(-1);
                    drain_deadline = Some(Instant::now() + EXIT_DRAIN_TIMEOUT);
                }
            }
            _ = async {
                match drain_deadline {
                    Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
                    None => std::future::pending::<()>().await,
                }
            }, if exit_code.is_some() || eof => {
                exit_code.get_or_insert(-1);
                eof = true;
            }
            _ = async {
                match ping.as_mut() {
                    Some(interval) => {
                        interval.tick().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                let now = Instant::now();
                let idle = now.duration_since(last_activity);
                if idle >= ping_timeout {
                    debug!("closing idle WebSocket connection");
                    break;
                }
                if idle < ping_interval {
                    continue;
                }
                let ping_due = last_ping_sent
                    .map(|sent| now.duration_since(sent) >= ping_interval)
                    .unwrap_or(true);
                if !ping_due {
                    continue;
                }
                if socket
                    .send(Message::Ping(Bytes::from_static(b"ttyd")))
                    .await
                    .is_err()
                {
                    break;
                }
                last_ping_sent = Some(now);
            }
        }
    }

    Ok(())
}

enum Control {
    Continue,
    Close,
    Hold(Vec<u8>),
    Fail(u16),
}

fn queue_paused(buf: &mut VecDeque<Bytes>, bytes: &mut usize, data: Bytes) -> bool {
    *bytes = bytes.saturating_add(data.len());
    buf.push_back(data);
    *bytes > PAUSE_BUFFER_LIMIT
}

async fn flush_pending(
    socket: &mut WebSocket,
    pending: &mut Option<Bytes>,
    paused_output: &mut VecDeque<Bytes>,
    paused_bytes: &mut usize,
) -> anyhow::Result<()> {
    if let Some(data) = pending.take() {
        send_output(socket, &data).await?;
    }
    while let Some(data) = paused_output.pop_front() {
        *paused_bytes = paused_bytes.saturating_sub(data.len());
        send_output(socket, &data).await?;
    }
    Ok(())
}

async fn handle_message(
    session: &PtySession,
    state: &Arc<AppState>,
    message: Message,
    paused: &mut bool,
    columns: &mut u16,
    rows: &mut u16,
) -> anyhow::Result<Control> {
    let data = match message {
        Message::Binary(data) => data.to_vec(),
        Message::Text(text) => text.as_bytes().to_vec(),
        Message::Ping(_) | Message::Pong(_) => return Ok(Control::Continue),
        Message::Close(_) => return Ok(Control::Close),
    };

    let Some(command) = data.first().copied() else {
        return Ok(Control::Continue);
    };

    match command {
        b'0' => {
            if state.config.writable && data.len() > 1 {
                let payload = data[1..].to_vec();
                if payload.len() > MAX_INPUT_FRAME {
                    return Ok(Control::Fail(CLOSE_TOO_LARGE));
                }
                match session.try_write(payload) {
                    Ok(()) => {}
                    Err(InputReject::Full(payload)) => return Ok(Control::Hold(payload)),
                    Err(InputReject::Closed) => return Ok(Control::Fail(CLOSE_ERROR)),
                }
            }
        }
        b'1' => {
            if let Ok(value) = serde_json::from_slice::<Value>(&data[1..]) {
                if let Some(value) = value.get("columns").and_then(Value::as_u64) {
                    *columns = value as u16;
                }
                if let Some(value) = value.get("rows").and_then(Value::as_u64) {
                    *rows = value as u16;
                }
                session.resize(*columns, *rows);
            }
        }
        b'2' => *paused = true,
        b'3' => *paused = false,
        b'{' => {}
        _ => warn!("ignored unknown message type: {}", command as char),
    }

    Ok(Control::Continue)
}

async fn send_initial(socket: &mut WebSocket, state: &Arc<AppState>) -> anyhow::Result<()> {
    let title = format!("{} ({})", state.config.command_string, hostname());
    send_frame(socket, b'1', title.as_bytes()).await?;
    send_frame(socket, b'2', state.config.prefs_json.as_bytes()).await?;
    Ok(())
}

async fn wait_initial(
    socket: &mut WebSocket,
    state: &Arc<AppState>,
) -> anyhow::Result<Option<Initial>> {
    loop {
        let message = tokio::select! {
            _ = state.shutdown.cancelled() => {
                close(socket, CLOSE_GOING_AWAY).await;
                return Ok(None);
            }
            message = socket.recv() => message,
        };

        let message = match message {
            Some(Ok(message)) => message,
            Some(Err(error)) => return Err(error.into()),
            None => return Ok(None),
        };

        let data = match message {
            Message::Binary(data) => data.to_vec(),
            Message::Text(text) => text.as_bytes().to_vec(),
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => return Ok(None),
        };

        if data.first() != Some(&b'{') {
            if state.config.credential.is_some() {
                warn!("WS client not authenticated");
                close(socket, CLOSE_POLICY).await;
                return Ok(None);
            }
            continue;
        }

        let value: Value = serde_json::from_slice(&data).unwrap_or(Value::Null);

        if let Some(credential) = &state.config.credential {
            let authenticated = value
                .get("AuthToken")
                .and_then(Value::as_str)
                .is_some_and(|token| token == credential);
            if !authenticated {
                warn!("WS authentication failed");
                close(socket, CLOSE_POLICY).await;
                return Ok(None);
            }
        }

        let columns = value.get("columns").and_then(Value::as_u64).unwrap_or(0) as u16;
        let rows = value.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
        let session = value
            .get("session")
            .and_then(Value::as_str)
            .filter(|session| !session.is_empty() && session.len() <= 128)
            .map(str::to_owned);
        let session_timeout = value.get("sessionTimeout").and_then(Value::as_u64);
        return Ok(Some(Initial {
            columns,
            rows,
            session,
            session_timeout,
        }));
    }
}

async fn send_replay(socket: &mut WebSocket, data: &[u8]) -> anyhow::Result<()> {
    for chunk in data.chunks(REPLAY_CHUNK_SIZE) {
        send_output(socket, chunk).await?;
    }
    Ok(())
}

async fn send_output(socket: &mut WebSocket, data: &[u8]) -> anyhow::Result<()> {
    send_frame(socket, b'0', data).await
}

async fn send_frame(socket: &mut WebSocket, command: u8, data: &[u8]) -> anyhow::Result<()> {
    let mut message = BytesMut::with_capacity(data.len() + 1);
    message.extend_from_slice(&[command]);
    message.extend_from_slice(data);
    socket
        .send(Message::Binary(message.freeze()))
        .await
        .map_err(anyhow::Error::from)
}

async fn close(socket: &mut WebSocket, code: u16) {
    let frame = CloseFrame {
        code,
        reason: Utf8Bytes::from_static(""),
    };
    if let Err(error) = socket.send(Message::Close(Some(frame))).await {
        debug!("failed to send WebSocket close {code}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, host.parse().unwrap());
        if let Some(origin) = origin {
            headers.insert(ORIGIN, origin.parse().unwrap());
        }
        headers
    }

    #[test]
    fn parses_url_arguments() {
        let uri: Uri = "/ws?arg=one&arg=hello%20world&ignored=yes".parse().unwrap();
        assert_eq!(parse_url_args(&uri), ["one", "hello world"]);

        let uri: Uri = "/ws?arg=a+b".parse().unwrap();
        assert_eq!(parse_url_args(&uri), ["a b"]);
    }

    #[test]
    fn ignores_url_arguments_without_query() {
        let uri: Uri = "/ws".parse().unwrap();
        assert!(parse_url_args(&uri).is_empty());
    }

    #[test]
    fn checks_websocket_origin() {
        assert!(check_origin(&headers(
            "127.0.0.1:7681",
            Some("http://127.0.0.1:7681")
        )));
        assert!(check_origin(&headers(
            "example.com",
            Some("https://example.com:443")
        )));
        assert!(check_origin(&headers(
            "example.com:8080",
            Some("http://example.com:8080")
        )));
        assert!(check_origin(&headers(
            "[::1]:7681",
            Some("http://[::1]:7681")
        )));
        assert!(!check_origin(&headers(
            "127.0.0.1:7681",
            Some("http://evil.example")
        )));
        assert!(!check_origin(&headers(
            "127.0.0.1:7681",
            Some("http://127.0.0.1:7682")
        )));
        assert!(!check_origin(&headers("127.0.0.1:7681", None)));
        assert!(!check_origin(&headers("127.0.0.1:7681", Some("not a url"))));
    }
}
