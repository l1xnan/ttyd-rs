use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

#[cfg(unix)]
use anyhow::anyhow;
use anyhow::{bail, Context, Result};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{
    ACCEPT_ENCODING, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE, HOST, LOCATION,
    PROXY_AUTHENTICATE, WWW_AUTHENTICATE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{body::Body, Router};
use bytes::Bytes;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tracing_subscriber::filter::LevelFilter;

use crate::config::Config;
use crate::html::HtmlAssets;
use crate::tls::{build_acceptor, ConnInfo, TlsListener};
use crate::ws;

pub struct AppState {
    pub config: Arc<Config>,
    pub html: Arc<HtmlAssets>,
    pub clients: AtomicUsize,
    pub shutdown: CancellationToken,
}

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user: Option<String>,
}

pub async fn run(config: Config) -> Result<()> {
    init_logging(config.debug_level);
    log_config(&config);

    let html = Arc::new(HtmlAssets::load()?);
    let state = Arc::new(AppState {
        config: Arc::new(config.clone()),
        html,
        clients: AtomicUsize::new(0),
        shutdown: CancellationToken::new(),
    });

    let app = build_router(state.clone());
    spawn_signal_task(state.clone());

    if config.is_unix_socket() {
        serve_unix(state, app).await
    } else {
        serve_tcp(state, app).await
    }
}

fn build_router(state: Arc<AppState>) -> Router {
    let mut app = Router::new()
        .route(&state.config.endpoints.index, get(index_handler))
        .route(&state.config.endpoints.token, get(token_handler))
        .route(&state.config.endpoints.ws, get(ws::handler));

    if !state.config.endpoints.parent.is_empty() {
        app = app.route(&state.config.endpoints.parent, get(redirect_handler));
    }

    app.fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, auth_middleware))
        .layer(middleware::from_fn(server_header))
}

async fn server_header(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "server",
        HeaderValue::from_str(&format!("ttyd/{}", crate::config::VERSION))
            .expect("valid server header"),
    );
    response
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Response {
    if state.config.ssl {
        if let Some(ConnectInfo(info)) =
            request.extensions().get::<ConnectInfo<ConnInfo>>().cloned()
        {
            if !info.tls {
                return redirect_to_https(&request);
            }
        }
    }

    match check_auth(&state.config, request.headers()) {
        Ok(user) => {
            request.extensions_mut().insert(AuthUser { user });
            next.run(request).await
        }
        Err(AuthFailure::Unauthorized) => unauthorized(false),
        Err(AuthFailure::ProxyUnauthorized) => unauthorized(true),
    }
}

enum AuthFailure {
    Unauthorized,
    ProxyUnauthorized,
}

fn check_auth(config: &Config, headers: &HeaderMap) -> Result<Option<String>, AuthFailure> {
    if let Some(name) = &config.auth_header {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| AuthFailure::ProxyUnauthorized)?;
        let value = headers
            .get(&name)
            .filter(|value| !value.is_empty())
            .ok_or(AuthFailure::ProxyUnauthorized)?;
        return Ok(Some(String::from_utf8_lossy(value.as_bytes()).into_owned()));
    }

    if let Some(credential) = &config.credential {
        let value = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthFailure::Unauthorized)?;
        let supplied = value
            .strip_prefix("Basic ")
            .ok_or(AuthFailure::Unauthorized)?;
        if supplied == credential {
            return Ok(None);
        }
        return Err(AuthFailure::Unauthorized);
    }

    Ok(None)
}

fn unauthorized(proxy: bool) -> Response {
    let (header, status) = if proxy {
        (
            PROXY_AUTHENTICATE,
            StatusCode::PROXY_AUTHENTICATION_REQUIRED,
        )
    } else {
        (WWW_AUTHENTICATE, StatusCode::UNAUTHORIZED)
    };
    (status, [(header, "Basic realm=\"ttyd\"")]).into_response()
}

fn redirect_to_https(request: &Request) -> Response {
    let host = match request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
    {
        Some(host) => host,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let location = format!("https://{host}{path}");
    (StatusCode::FOUND, [(LOCATION, location)]).into_response()
}

async fn index_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    connect: ConnectInfo<ConnInfo>,
) -> Response {
    log_http(&state.config.endpoints.index, &connect);

    if let Some(index) = &state.config.index {
        return match tokio::fs::read(index).await {
            Ok(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "text/html")
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
            Err(error) => {
                warn!("failed to read index.html {}: {error}", index.display());
                StatusCode::NOT_FOUND.into_response()
            }
        };
    }

    let use_gzip = headers
        .get(ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("gzip"));

    if use_gzip {
        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/html")
            .header(CONTENT_ENCODING, "gzip")
            .body(Body::from(Bytes::from_static(state.html.gzip)))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/html")
            .body(Body::from(state.html.plain.clone()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

async fn token_handler(
    State(state): State<Arc<AppState>>,
    connect: ConnectInfo<ConnInfo>,
) -> Response {
    log_http(&state.config.endpoints.token, &connect);
    let credential = state.config.credential.as_deref().unwrap_or("");
    let body = format!("{{\"token\": \"{credential}\"}}");
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json;charset=utf-8")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn redirect_handler(
    State(state): State<Arc<AppState>>,
    connect: ConnectInfo<ConnInfo>,
) -> Response {
    log_http(&state.config.endpoints.parent, &connect);
    (
        StatusCode::FOUND,
        [(LOCATION, state.config.endpoints.index.clone())],
    )
        .into_response()
}

fn log_http(path: &str, connect: &ConnectInfo<ConnInfo>) {
    let peer = peer_string(connect);
    info!("HTTP {path} - {peer}");
}

pub fn peer_string(connect: &ConnectInfo<ConnInfo>) -> String {
    connect
        .0
        .peer
        .map(|peer| peer.to_string())
        .unwrap_or_else(|| "unix".to_owned())
}

async fn serve_tcp(state: Arc<AppState>, app: Router) -> Result<()> {
    let address = bind_address(&state.config)?;
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to listen on {address}"))?;
    let local = listener
        .local_addr()
        .context("failed to get local address")?;

    let acceptor = if state.config.ssl {
        Some(build_acceptor(&state.config)?)
    } else {
        None
    };

    apply_privileges(&state.config)?;
    info!("Listening on port: {}", local.port());
    open_browser(&state.config, local);

    if let Some(acceptor) = acceptor {
        let listener = TlsListener::new(listener, acceptor);
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<ConnInfo>(),
        )
        .with_graceful_shutdown(shutdown_future(state.shutdown.clone()))
        .await
        .context("server error")?;
    } else {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<ConnInfo>(),
        )
        .with_graceful_shutdown(shutdown_future(state.shutdown.clone()))
        .await
        .context("server error")?;
    }

    Ok(())
}

fn bind_address(config: &Config) -> Result<SocketAddr> {
    if let Some(interface) = &config.interface {
        if let Ok(ip) = interface.parse::<IpAddr>() {
            return Ok(SocketAddr::new(ip, config.port));
        }

        if let Ok(addresses) = interface.to_socket_addrs() {
            let addresses = addresses.collect::<Vec<_>>();
            if let Some(address) = addresses
                .iter()
                .find(|address| address.is_ipv6() == config.ipv6)
                .or_else(|| addresses.first())
            {
                return Ok(SocketAddr::new(address.ip(), config.port));
            }
        }

        let interfaces = if_addrs::get_if_addrs()
            .with_context(|| format!("failed to list interfaces for {interface}"))?;
        let mut candidates = interfaces
            .into_iter()
            .filter(|candidate| candidate.name == *interface)
            .collect::<Vec<_>>();
        candidates.sort_by_key(|candidate| candidate.ip().is_ipv6() != config.ipv6);

        if let Some(candidate) = candidates.first() {
            return Ok(SocketAddr::new(candidate.ip(), config.port));
        }

        bail!("failed to find interface: {interface}");
    }

    let ip = if config.ipv6 {
        IpAddr::V6(Ipv6Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };
    Ok(SocketAddr::new(ip, config.port))
}

fn open_browser(config: &Config, local: SocketAddr) {
    if !config.browser {
        return;
    }

    let scheme = if config.ssl { "https" } else { "http" };
    let host = match local.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => "localhost".to_owned(),
        IpAddr::V6(ip) if ip.is_unspecified() => "localhost".to_owned(),
        IpAddr::V6(ip) => format!("[{ip}]"),
        ip => ip.to_string(),
    };
    let port = local.port();
    let default_port = (config.ssl && port == 443) || (!config.ssl && port == 80);
    let url = if default_port {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    };

    if let Err(error) = webbrowser::open(&url) {
        warn!("failed to open browser: {error}");
    }
}

#[cfg(unix)]
async fn serve_unix(state: Arc<AppState>, app: Router) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;

    let path = state
        .config
        .interface
        .as_ref()
        .ok_or_else(|| anyhow!("missing UNIX socket path"))?;
    let path = std::path::Path::new(path);

    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_socket() {
            std::fs::remove_file(path)
                .with_context(|| format!("failed to remove old socket {}", path.display()))?;
        } else {
            bail!("refusing to replace non-socket path: {}", path.display());
        }
    }

    let listener = tokio::net::UnixListener::bind(path)
        .with_context(|| format!("failed to listen on {}", path.display()))?;

    if let Some(owner) = &state.config.socket_owner {
        if let Err(error) = apply_socket_owner(path, owner) {
            warn!("failed to set socket owner {owner}: {error}");
        }
    }
    apply_privileges(&state.config)?;

    info!("Listening on UNIX socket: {}", path.display());

    let result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<ConnInfo>(),
    )
    .with_graceful_shutdown(shutdown_future(state.shutdown.clone()))
    .await;

    let _ = std::fs::remove_file(path);
    result.context("server error")?;
    Ok(())
}

#[cfg(not(unix))]
async fn serve_unix(_state: Arc<AppState>, _app: Router) -> Result<()> {
    bail!("UNIX domain sockets are not supported on this platform")
}

#[cfg(unix)]
fn apply_socket_owner(path: &std::path::Path, owner: &str) -> Result<()> {
    use nix::unistd::{chown, Gid, Group, Uid, User};

    let (user, group) = owner.split_once(':').unwrap_or((owner, ""));
    let uid = if user.is_empty() {
        None
    } else if let Ok(uid) = user.parse::<u32>() {
        Some(Uid::from_raw(uid))
    } else {
        Some(
            User::from_name(user)?
                .ok_or_else(|| anyhow!("unknown user: {user}"))?
                .uid,
        )
    };
    let gid = if group.is_empty() {
        None
    } else if let Ok(gid) = group.parse::<u32>() {
        Some(Gid::from_raw(gid))
    } else {
        Some(
            Group::from_name(group)?
                .ok_or_else(|| anyhow!("unknown group: {group}"))?
                .gid,
        )
    };

    chown(path, uid, gid).with_context(|| format!("chown {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn apply_privileges(config: &Config) -> Result<()> {
    use nix::unistd::{setgid, setuid, Gid, Uid};

    if let Some(gid) = config.gid {
        setgid(Gid::from_raw(gid)).with_context(|| format!("failed to set gid to {gid}"))?;
    }
    if let Some(uid) = config.uid {
        setuid(Uid::from_raw(uid)).with_context(|| format!("failed to set uid to {uid}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn apply_privileges(config: &Config) -> Result<()> {
    if config.uid.is_some() || config.gid.is_some() {
        warn!("--uid and --gid are not supported on this platform");
    }
    Ok(())
}

async fn shutdown_future(token: CancellationToken) {
    token.cancelled().await;
}

fn spawn_signal_task(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut first = true;

        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("failed to install SIGTERM handler");

        loop {
            #[cfg(unix)]
            let (name, number) = tokio::select! {
                result = tokio::signal::ctrl_c() => {
                    if let Err(error) = result {
                        warn!("failed to wait for SIGINT: {error}");
                        continue;
                    }
                    ("SIGINT", 2)
                }
                _ = terminate.recv() => ("SIGTERM", 15),
            };

            #[cfg(not(unix))]
            let (name, number) = {
                if let Err(error) = tokio::signal::ctrl_c().await {
                    warn!("failed to wait for Ctrl-C: {error}");
                    continue;
                }
                ("SIGINT", 2)
            };

            if first {
                first = false;
                info!("received signal: {name} ({number}), exiting...");
                info!("send ^C to force exit.");
                state.shutdown.cancel();
            } else {
                std::process::exit(1);
            }
        }
    });
}

fn init_logging(debug_level: i32) {
    let level = match debug_level {
        0 => LevelFilter::OFF,
        1..=3 => LevelFilter::WARN,
        4..=7 => LevelFilter::INFO,
        8..=15 => LevelFilter::DEBUG,
        _ => LevelFilter::TRACE,
    };
    let _ = tracing_subscriber::fmt()
        .with_max_level(level)
        .with_target(false)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .try_init();
}

fn log_config(config: &Config) {
    info!("ttyd version {}", crate::config::VERSION);
    info!("tty configuration:");
    if config.credential.is_some() {
        info!("  basic auth: enabled");
    }
    info!("  start command: {}", config.command_string);
    info!("  close signal: {} ({})", config.signal_name, config.signal);
    info!("  terminal type: {}", config.terminal_type);
    if !config.endpoints.parent.is_empty() {
        info!("endpoints:");
        info!("  base-path: {}", config.endpoints.parent);
        info!("  index    : {}", config.endpoints.index);
        info!("  token    : {}", config.endpoints.token);
        info!("  websocket: {}", config.endpoints.ws);
    }
    if let Some(auth_header) = &config.auth_header {
        info!("  auth header: {auth_header}");
    }
    if let Some(socket_owner) = &config.socket_owner {
        info!("  socket owner: {socket_owner}");
    }
    if config.check_origin {
        info!("  check origin: true");
    }
    if config.url_arg {
        info!("  allow url arg: true");
    }
    if config.max_clients > 0 {
        info!("  max clients: {}", config.max_clients);
    }
    if config.once {
        info!("  once: true");
    }
    if config.exit_no_conn {
        info!("  exit_no_conn: true");
    }
    if let Some(index) = &config.index {
        info!("  custom index.html: {}", index.display());
    }
    if let Some(cwd) = &config.cwd {
        info!("  working directory: {}", cwd.display());
    }
    if !config.writable {
        warn!("The --writable option is not set, will start in readonly mode");
    }
}

#[cfg(test)]
mod protocol_tests {
    use std::ffi::OsString;
    use std::net::SocketAddr;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Duration;

    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::WebSocketStream;
    use tokio_util::sync::CancellationToken;

    use super::{build_router, AppState};
    use crate::config::{Config, Endpoints};
    use crate::html::HtmlAssets;
    use crate::pty::MAX_INPUT_FRAME;
    use crate::tls::ConnInfo;
    use crate::ws::{CLOSE_ERROR, CLOSE_NORMAL, CLOSE_POLICY, CLOSE_TOO_LARGE};

    type Client = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    fn shell(script: &str) -> Vec<OsString> {
        if cfg!(windows) {
            vec!["cmd.exe".into(), "/c".into(), script.into()]
        } else {
            vec!["sh".into(), "-c".into(), script.into()]
        }
    }

    fn read_line_command() -> Vec<OsString> {
        if cfg!(windows) {
            vec![
                "cmd.exe".into(),
                "/v:on".into(),
                "/c".into(),
                "set /p line=&& echo got:!line!".into(),
            ]
        } else {
            shell("read line; printf 'got:%s\n' \"$line\"")
        }
    }

    fn test_config(command: Vec<OsString>, command_string: &str) -> Config {
        Config {
            port: 0,
            interface: None,
            socket_owner: None,
            credential: None,
            auth_header: None,
            uid: None,
            gid: None,
            signal: 15,
            signal_name: "SIGTERM".to_owned(),
            cwd: None,
            endpoints: Endpoints::from_base_path(None),
            ping_interval: 0,
            serv_buf_size: 4096,
            ipv6: false,
            ssl: false,
            ssl_cert: None,
            ssl_key: None,
            ssl_ca: None,
            url_arg: false,
            writable: false,
            check_origin: false,
            max_clients: 0,
            once: false,
            exit_no_conn: false,
            browser: false,
            debug_level: 0,
            terminal_type: "xterm-256color".to_owned(),
            index: None,
            prefs_json: "{}".to_owned(),
            command,
            command_string: command_string.to_owned(),
        }
    }

    async fn spawn_server(config: Config) -> (SocketAddr, CancellationToken) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let state = Arc::new(AppState {
            config: Arc::new(config),
            html: Arc::new(HtmlAssets::load().unwrap()),
            clients: AtomicUsize::new(0),
            shutdown: shutdown.clone(),
        });
        let app = build_router(state);
        let token = shutdown.clone();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<ConnInfo>(),
            )
            .with_graceful_shutdown(super::shutdown_future(token))
            .await;
        });
        (addr, shutdown)
    }

    async fn connect(addr: SocketAddr, credential: Option<&str>) -> Client {
        let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", "tty".parse().unwrap());
        if let Some(credential) = credential {
            request.headers_mut().insert(
                "Authorization",
                format!("Basic {credential}").parse().unwrap(),
            );
        }
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .expect("connect timed out")
        .expect("websocket handshake failed");
        socket
    }

    async fn read_initial(socket: &mut Client) -> Vec<u8> {
        let mut title = Vec::new();
        let mut saw_title = false;
        let mut saw_prefs = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !(saw_title && saw_prefs) {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let message = tokio::time::timeout(remaining, socket.next())
                .await
                .expect("timed out waiting for the initial frames")
                .expect("socket closed before the initial frames")
                .expect("websocket error");
            match message {
                Message::Binary(data) => match data.first().copied() {
                    Some(b'1') => {
                        saw_title = true;
                        title = data[1..].to_vec();
                    }
                    Some(b'2') => saw_prefs = true,
                    _ => {}
                },
                Message::Close(frame) => panic!("closed before the initial frames: {frame:?}"),
                _ => {}
            }
        }
        title
    }

    fn init_message(token: &str) -> Message {
        let body = serde_json::json!({
            "AuthToken": token,
            "columns": 80,
            "rows": 24,
        });
        Message::Text(body.to_string().into())
    }

    struct SessionEnd {
        output: Vec<u8>,
        close_code: u16,
    }

    fn cursor_position_report() -> Vec<u8> {
        b"0\x1b[1;1R".to_vec()
    }

    fn asks_for_cursor(payload: &[u8]) -> bool {
        payload.windows(4).any(|window| window == *b"\x1b[6n")
    }

    async fn finish(socket: &mut Client, mut after_cursor: Option<Vec<u8>>) -> SessionEnd {
        let mut output = Vec::new();
        let mut answered_cursor = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for WebSocket close; output {}",
                String::from_utf8_lossy(&output)
            );
            let message = tokio::time::timeout(remaining, socket.next())
                .await
                .expect("timed out waiting for WebSocket close")
                .expect("socket ended without a close frame")
                .expect("websocket error");
            match message {
                Message::Binary(data) if data.first() == Some(&b'0') => {
                    let payload = &data[1..];
                    if !answered_cursor && asks_for_cursor(payload) {
                        answered_cursor = true;
                        socket
                            .send(Message::Binary(cursor_position_report().into()))
                            .await
                            .unwrap();
                        if let Some(input) = after_cursor.take() {
                            socket.send(Message::Binary(input.into())).await.unwrap();
                        }
                    }
                    output.extend_from_slice(payload);
                }
                Message::Close(frame) => {
                    let close_code = frame.map(|frame| u16::from(frame.code)).unwrap_or(1005);
                    return SessionEnd { output, close_code };
                }
                _ => {}
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handshake_resize_and_normal_exit() {
        let script = if cfg!(windows) {
            "echo hello-ttyd"
        } else {
            "sleep 0.4; printf 'hello-ttyd'"
        };
        let mut config = test_config(shell(script), "hello-ttyd");
        // Windows ConPTY waits for a cursor-position reply before running the command.
        config.writable = true;
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, None).await;
        let title = read_initial(&mut socket).await;
        assert!(
            String::from_utf8_lossy(&title).contains("hello-ttyd"),
            "title was {}",
            String::from_utf8_lossy(&title)
        );
        socket.send(init_message("")).await.unwrap();
        socket
            .send(Message::Binary(
                br#"1{"columns":120,"rows":40}"#.to_vec().into(),
            ))
            .await
            .unwrap();

        let end = finish(&mut socket, None).await;
        shutdown.cancel();
        let text = String::from_utf8_lossy(&end.output);
        assert!(text.contains("hello-ttyd"), "output was {text}");
        assert_eq!(end.close_code, CLOSE_NORMAL);
        assert_ne!(end.close_code, 1006);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn writable_session_returns_input() {
        let mut config = test_config(read_line_command(), "read");
        config.writable = true;
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, None).await;
        read_initial(&mut socket).await;
        socket.send(init_message("")).await.unwrap();
        let secret = b"0secret\r\n".to_vec();
        let after_cursor = if cfg!(windows) {
            Some(secret)
        } else {
            socket.send(Message::Binary(secret.into())).await.unwrap();
            None
        };

        let end = finish(&mut socket, after_cursor).await;
        shutdown.cancel();
        let text = String::from_utf8_lossy(&end.output);
        assert!(text.contains("got:secret"), "output was {text}");
        assert_eq!(end.close_code, CLOSE_NORMAL);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn readonly_session_discards_input() {
        let config = test_config(read_line_command(), "read");
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, None).await;
        read_initial(&mut socket).await;
        socket.send(init_message("")).await.unwrap();
        if !cfg!(windows) {
            socket
                .send(Message::Binary(b"0secret\r\n".to_vec().into()))
                .await
                .unwrap();
        }

        let leaked = tokio::time::timeout(Duration::from_secs(5), async {
            let mut output = Vec::new();
            let mut answered_cursor = false;
            while let Some(message) = socket.next().await {
                let Ok(message) = message else {
                    return false;
                };
                match message {
                    Message::Binary(data) if data.first() == Some(&b'0') => {
                        let payload = &data[1..];
                        if !answered_cursor && asks_for_cursor(payload) {
                            answered_cursor = true;
                            socket
                                .send(Message::Binary(cursor_position_report().into()))
                                .await
                                .unwrap();
                            socket
                                .send(Message::Binary(b"0secret\r\n".to_vec().into()))
                                .await
                                .unwrap();
                        }
                        output.extend_from_slice(payload);
                        if String::from_utf8_lossy(&output).contains("got:secret") {
                            return true;
                        }
                    }
                    Message::Close(_) => return false,
                    _ => {}
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        shutdown.cancel();
        assert!(!leaked, "readonly session wrote input into the terminal");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejects_a_bad_auth_token() {
        let credential = base64::engine::general_purpose::STANDARD.encode("user:pass");
        let mut config = test_config(shell("exit 0"), "exit");
        config.credential = Some(credential.clone());
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, Some(&credential)).await;
        read_initial(&mut socket).await;
        socket.send(init_message("wrong-token")).await.unwrap();

        let end = finish(&mut socket, None).await;
        shutdown.cancel();
        assert_eq!(end.close_code, CLOSE_POLICY);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_zero_exit_uses_a_legal_close_code() {
        let mut config = test_config(shell("exit 2"), "exit 2");
        config.writable = true;
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, None).await;
        read_initial(&mut socket).await;
        socket.send(init_message("")).await.unwrap();

        let end = finish(&mut socket, None).await;
        shutdown.cancel();
        assert_eq!(end.close_code, CLOSE_ERROR);
        assert_ne!(end.close_code, 1006);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pty_spawn_failure_closes_the_socket() {
        let config = test_config(
            vec!["ttyd-missing-binary-for-test".into()],
            "ttyd-missing-binary-for-test",
        );
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, None).await;
        read_initial(&mut socket).await;
        socket.send(init_message("")).await.unwrap();

        let end = finish(&mut socket, None).await;
        shutdown.cancel();
        assert_eq!(end.close_code, CLOSE_ERROR);
        assert_ne!(end.close_code, 1006);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oversized_input_is_rejected() {
        let script = if cfg!(windows) {
            "ping -n 31 127.0.0.1 >nul"
        } else {
            "sleep 30"
        };
        let mut config = test_config(shell(script), "sleep");
        config.writable = true;
        let (addr, shutdown) = spawn_server(config).await;
        let mut socket = connect(addr, None).await;
        read_initial(&mut socket).await;
        socket.send(init_message("")).await.unwrap();
        let mut frame = vec![0u8; MAX_INPUT_FRAME + 2];
        frame[0] = b'0';
        socket.send(Message::Binary(frame.into())).await.unwrap();

        let end = finish(&mut socket, None).await;
        shutdown.cancel();
        assert_eq!(end.close_code, CLOSE_TOO_LARGE);
    }
}
