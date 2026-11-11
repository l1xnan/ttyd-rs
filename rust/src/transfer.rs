//! HTTP file transfer endpoints, completely independent of the PTY protocol.
//!
//! All requests are gated by `--http-transfer` plus `-W`, bound to a live
//! session id and its owner, and must carry `X-TTYD-Transfer: 1` (cross-site
//! requests cannot set that header without a CORS preflight).

// A ready-made `Response` is the natural error type for these helpers: every
// failure is returned to the client unchanged. Boxing it at each of the call
// sites would only add noise, and the helpers are per-request, not hot paths.
#![allow(clippy::result_large_err)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Extension, Path as AxumPath, Query, Request, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures_util::StreamExt;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::info;

use crate::config::Config;
use crate::cwd::{self, ResolveError, ResolvedDir};
use crate::server::{json_error, json_response, no_store, AppState, AuthUser};
use crate::session::{Lookup, ManagedSession};
use crate::ws;

const TRANSFER_HEADER: HeaderName = HeaderName::from_static("x-ttyd-transfer");
const FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");
const NOSNIFF: HeaderName = HeaderName::from_static("x-content-type-options");
const DOWNLOAD_CHUNK: usize = 64 * 1024;

struct TransferGuard {
    session: Arc<ManagedSession>,
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        self.session.end_transfer();
    }
}

struct TransferContext {
    session: Arc<ManagedSession>,
    dir: ResolvedDir,
    _guard: TransferGuard,
}

/// Shared admission checks for list / upload / download.
fn guard(
    state: &AppState,
    id: &str,
    action: &str,
    auth: &AuthUser,
    headers: &HeaderMap,
) -> Result<TransferContext, Response> {
    if !state.config.http_transfer {
        return Err(no_store(StatusCode::NOT_FOUND));
    }
    if !state.config.writable {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "file transfer requires -W/--writable",
        ));
    }
    if headers.get(&TRANSFER_HEADER).and_then(|v| v.to_str().ok()) != Some("1") {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "missing X-TTYD-Transfer header",
        ));
    }
    if headers
        .get(&FETCH_SITE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|site| site.eq_ignore_ascii_case("cross-site"))
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "cross-site file transfer is not allowed",
        ));
    }
    // Same-site GET requests usually have no Origin header; only validate it
    // when present so `-O` does not break ordinary downloads.
    if state.config.check_origin && headers.contains_key(ORIGIN) && !ws::check_origin(headers) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "request origin does not match Host",
        ));
    }
    if id.is_empty() || id.len() > 128 {
        return Err(no_store(StatusCode::NOT_FOUND));
    }

    let session = match state.sessions.live(id, auth.user.as_deref()) {
        Lookup::Found(session) => session,
        Lookup::Forbidden => {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "session belongs to another user",
            ))
        }
        Lookup::NotFound => return Err(no_store(StatusCode::NOT_FOUND)),
    };

    let dir = match cwd::resolve(&state.config, &session) {
        Ok(dir) => dir,
        Err(ResolveError::OutsideRoot) => {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "current directory is outside --http-transfer-root",
            ))
        }
        Err(ResolveError::Io(error)) => {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to resolve transfer directory: {error}"),
            ))
        }
    };

    session.begin_transfer();
    info!(
        user = ?auth.user,
        session = %id,
        action,
        cwd = %dir.path.display(),
        followed_cwd = dir.followed,
        "http transfer"
    );
    Ok(TransferContext {
        session: session.clone(),
        dir,
        _guard: TransferGuard { session },
    })
}

/// Only a single path component is ever accepted. Client supplied file names
/// are never joined into a path containing a separator.
fn sanitize_name(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty() || raw == "." || raw == ".." || raw.len() > 255 {
        return Err("invalid file name");
    }
    if raw.ends_with('.') || raw.ends_with(' ') {
        return Err("invalid file name");
    }
    if raw.chars().any(|ch| {
        ch.is_control() || ch == '/' || ch == '\\' || ch == ':' || ch == '"' || ch == '\''
    }) {
        return Err("invalid file name");
    }
    let stem = raw.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("reserved file name");
    }
    Ok(raw.to_owned())
}

fn parent_dir(config: &Config, resolved: &ResolvedDir) -> Result<PathBuf, Response> {
    let parent = resolved.path.canonicalize().map_err(|error| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("cannot open transfer directory: {error}"),
        )
    })?;
    if let Some(root) = &config.http_transfer_root {
        if !cwd::within_root(&parent, root) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "current directory is outside --http-transfer-root",
            ));
        }
    }
    Ok(parent)
}

fn symlink_or_dir_error() -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        "symlinks and directories cannot be transferred",
    )
}

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    path: Option<String>,
}

/// Resolve a browsing/download path: absolute paths are used as-is, relative
/// ones are based on the upload destination. Canonicalizing first makes `..`
/// and symlinks harmless, then the optional whitelist root is enforced.
fn view_path(
    config: &Config,
    resolved: &ResolvedDir,
    raw: Option<&str>,
) -> Result<PathBuf, Response> {
    let candidate = match raw {
        None | Some("") => resolved.path.clone(),
        Some(value) => {
            let path = Path::new(value);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                resolved.path.join(path)
            }
        }
    };
    let canonical = candidate.canonicalize().map_err(|error| {
        json_error(
            StatusCode::NOT_FOUND,
            &format!("path is not accessible: {error}"),
        )
    })?;
    if let Some(root) = &config.http_transfer_root {
        if !cwd::within_root(&canonical, root) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "path is outside --http-transfer-root",
            ));
        }
    }
    Ok(canonical)
}

#[derive(Debug, Deserialize)]
pub struct NameQuery {
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadResult {
    name: String,
    size: u64,
    path: String,
}

fn random_hex() -> String {
    let mut bytes = [0u8; 8];
    SystemRandom::new().fill(&mut bytes).ok();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn create_temp_file(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    Ok(tokio::fs::File::from_std(options.open(path)?))
}

fn directory_size(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.metadata().ok())
                .filter(|metadata| metadata.is_file())
                .map(|metadata| metadata.len())
                .sum()
        })
        .unwrap_or(0)
}

/// `POST /sessions/{id}/files?name=...` — raw body, streamed to a temp file.
pub async fn upload_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<NameQuery>,
    request: Request,
) -> Response {
    let headers = request.headers().clone();
    let ctx = match guard(&state, &id, "upload", &auth, &headers) {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if !headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/octet-stream"))
    {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "upload requires Content-Type: application/octet-stream",
        );
    }
    let name = match sanitize_name(&query.name) {
        Ok(name) => name,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    let parent = match parent_dir(&state.config, &ctx.dir) {
        Ok(parent) => parent,
        Err(response) => return response,
    };
    let target = parent.join(&name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return json_error(StatusCode::CONFLICT, "file already exists");
    }

    let _lock = ctx.session.transfer_lock.lock().await;
    let temp = parent.join(format!(".ttyd-upload-{}.tmp", random_hex()));
    let max_upload = state.config.http_transfer_max_upload;
    let quota = state.config.http_transfer_session_quota;

    let written: Result<usize, Response> = async {
        let mut file = create_temp_file(&temp).map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot create temporary file: {error}"),
            )
        })?;
        let mut stream = request.into_body().into_data_stream();
        let mut total = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    &format!("upload body error: {error}"),
                )
            })?;
            total = total.saturating_add(chunk.len());
            if total > max_upload {
                return Err(json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upload exceeds the configured size limit",
                ));
            }
            file.write_all(&chunk).await.map_err(|error| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("cannot write upload: {error}"),
                )
            })?;
        }
        file.flush().await.map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot flush upload: {error}"),
            )
        })?;
        file.sync_all().await.map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot sync upload: {error}"),
            )
        })?;
        drop(file);

        if quota > 0 && directory_size(&parent).saturating_add(total as u64) > quota as u64 {
            return Err(json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "directory quota exceeded",
            ));
        }
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(json_error(StatusCode::CONFLICT, "file already exists"));
        }
        std::fs::rename(&temp, &target).map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot finish upload: {error}"),
            )
        })?;
        Ok(total)
    }
    .await;

    if written.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    let total = match written {
        Ok(total) => total,
        Err(response) => return response,
    };
    info!(
        user = ?auth.user,
        session = %id,
        file = %name,
        bytes = total,
        "http upload finished"
    );
    json_response(
        StatusCode::OK,
        &UploadResult {
            name,
            size: total as u64,
            path: target.to_string_lossy().into_owned(),
        },
    )
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn content_disposition(name: &str) -> HeaderValue {
    let ascii: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "-._~".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let value = format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(name)
    );
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// `GET /sessions/{id}/download?path=...` — download any file the server user
/// can read, not just one inside the upload destination. Relative paths are
/// resolved against the destination; `--http-transfer-root` still applies.
pub async fn download_path_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
) -> Response {
    let ctx = match guard(&state, &id, "download", &auth, &headers) {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let target = match view_path(&state.config, &ctx.dir, query.path.as_deref()) {
        Ok(target) => target,
        Err(response) => return response,
    };
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_owned());
    stream_file(target, &name).await
}

async fn stream_file(target: PathBuf, name: &str) -> Response {
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return no_store(StatusCode::NOT_FOUND)
        }
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot stat file: {error}"),
            )
        }
    };
    if metadata.file_type().is_symlink() || metadata.is_dir() {
        return symlink_or_dir_error();
    }
    let file = match tokio::fs::File::open(&target).await {
        Ok(file) => file,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot open file: {error}"),
            )
        }
    };

    let stream = futures_util::stream::unfold(
        (file, vec![0u8; DOWNLOAD_CHUNK]),
        |(mut file, mut buffer)| async move {
            match file.read(&mut buffer).await {
                Ok(0) | Err(_) => None,
                Ok(read) => Some((
                    Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buffer[..read])),
                    (file, buffer),
                )),
            }
        },
    );

    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(CONTENT_DISPOSITION, content_disposition(name));
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&metadata.len().to_string()).unwrap(),
    );
    headers.insert(NOSNIFF, HeaderValue::from_static("nosniff"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
