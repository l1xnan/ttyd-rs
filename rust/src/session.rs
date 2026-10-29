use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use ring::rand::{SecureRandom, SystemRandom};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::pty::PtySession;

/// Upper bound for a client supplied session timeout.
pub const MAX_SESSION_TIMEOUT_SECS: u64 = 60 * 60;

#[derive(Debug)]
pub enum AttachError {
    Forbidden,
    Spawn(anyhow::Error),
}

struct SessionState {
    attached: usize,
    detached_at: Option<Instant>,
    timeout: Duration,
}

pub struct ManagedSession {
    pub id: String,
    pub owner: Option<String>,
    pub pty: Arc<PtySession>,
    state: Mutex<SessionState>,
}

/// Everything needed to attach to an existing session or start a new one.
pub struct AttachRequest<'a> {
    pub session_id: Option<&'a str>,
    pub owner: Option<&'a str>,
    pub columns: u16,
    pub rows: u16,
    pub user: Option<&'a str>,
    pub args: &'a [String],
    pub timeout: Duration,
}

impl ManagedSession {
    fn new(id: String, owner: Option<String>, pty: Arc<PtySession>, timeout: Duration) -> Self {
        Self {
            id,
            owner,
            pty,
            state: Mutex::new(SessionState {
                attached: 1,
                detached_at: None,
                timeout,
            }),
        }
    }

    pub fn attach(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.attached = state.attached.saturating_add(1);
        state.detached_at = None;
    }

    /// Returns the number of clients still attached.
    fn detach(&self) -> usize {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.attached = state.attached.saturating_sub(1);
        if state.attached == 0 {
            state.detached_at = Some(Instant::now());
        }
        state.attached
    }

    fn set_timeout(&self, timeout: Duration) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.timeout = timeout;
    }

    fn timeout(&self) -> Duration {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .timeout
    }

    fn is_expired(&self, now: Instant) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.attached == 0
            && state
                .detached_at
                .is_some_and(|detached| now.saturating_duration_since(detached) >= state.timeout)
    }
}

pub struct SessionManager {
    config: Arc<Config>,
    sessions: Mutex<HashMap<String, Arc<ManagedSession>>>,
}

impl SessionManager {
    pub fn start(config: Arc<Config>, shutdown: CancellationToken) -> Arc<Self> {
        let manager = Arc::new(Self {
            config,
            sessions: Mutex::new(HashMap::new()),
        });

        let weak = Arc::downgrade(&manager);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
            interval.tick().await;

            loop {
                tokio::select! {
                    _ = shutdown.cancelled() => {
                        if let Some(manager) = weak.upgrade() {
                            manager.shutdown_all();
                        }
                        break;
                    }
                    _ = interval.tick() => {
                        let Some(manager) = weak.upgrade() else {
                            break;
                        };
                        manager.reap_expired();
                    }
                }
            }
        });

        manager
    }

    /// Resolve a client supplied timeout. `None` uses the server default.
    /// A server default of zero disables session persistence entirely.
    pub fn resolve_timeout(&self, requested: Option<u64>) -> Duration {
        let default = self.config.session_timeout;
        if default == 0 {
            return Duration::ZERO;
        }

        let seconds = requested.unwrap_or(default).min(MAX_SESSION_TIMEOUT_SECS);
        Duration::from_secs(seconds)
    }

    pub fn attach_or_create(
        &self,
        request: AttachRequest<'_>,
    ) -> Result<(Arc<ManagedSession>, bool), AttachError> {
        let AttachRequest {
            session_id,
            owner,
            columns,
            rows,
            user,
            args,
            timeout,
        } = request;
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(requested_id) = session_id.filter(|id| !id.is_empty() && id.len() <= 128) {
            if let Some(session) = sessions.get(requested_id).cloned() {
                if session.is_expired(Instant::now()) {
                    sessions.remove(requested_id);
                    session.pty.kill_default();
                } else if session.pty.is_exited() {
                    sessions.remove(requested_id);
                } else if session.owner.as_deref() != owner {
                    return Err(AttachError::Forbidden);
                } else {
                    session.set_timeout(timeout);
                    session.attach();
                    return Ok((session, false));
                }
            }
        }

        let pty = PtySession::spawn(self.config.as_ref(), args, columns, rows, user)
            .map_err(AttachError::Spawn)?;
        let id = generate_id(&sessions);
        let session = Arc::new(ManagedSession::new(
            id.clone(),
            owner.map(str::to_owned),
            Arc::new(pty),
            timeout,
        ));
        sessions.insert(id, session.clone());
        Ok((session, true))
    }

    /// Detach one client. A zero timeout means the session is removed and the
    /// command killed as soon as the last client leaves.
    pub fn detach(&self, session: &Arc<ManagedSession>) -> usize {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let remaining = session.detach();

        if remaining == 0 && session.timeout().is_zero() {
            sessions.remove(&session.id);
            drop(sessions);
            session.pty.kill_default();
        }

        remaining
    }

    fn reap_expired(&self) {
        let now = Instant::now();
        let expired: Vec<Arc<ManagedSession>> = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, session)| session.pty.is_exited() || session.is_expired(now))
                .map(|(id, _)| id.clone())
                .collect();

            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect()
        };

        for session in expired {
            session.pty.kill_default();
        }
    }

    fn shutdown_all(&self) {
        let sessions: Vec<Arc<ManagedSession>> = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions.drain().map(|(_, session)| session).collect()
        };

        for session in sessions {
            session.pty.kill_default();
        }
    }
}

fn generate_id(sessions: &HashMap<String, Arc<ManagedSession>>) -> String {
    let random = SystemRandom::new();
    for _ in 0..16 {
        let mut bytes = [0u8; 16];
        if random.fill(&mut bytes).is_ok() {
            let mut id = String::with_capacity(32);
            for byte in bytes {
                let _ = write!(&mut id, "{byte:02x}");
            }
            if !sessions.contains_key(&id) {
                return id;
            }
        }
    }

    // `ring` uses the operating system RNG. This fallback only exists to keep
    // the server usable if that unexpectedly fails.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let base = format!("{nanos:x}{:x}", std::process::id());
    let mut id = base.clone();
    let mut counter = 0u32;
    while sessions.contains_key(&id) {
        counter = counter.saturating_add(1);
        id = format!("{base}{counter:x}");
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, Endpoints};
    use crate::pty::DEFAULT_OUTPUT_BUFFER_LIMIT;
    use std::ffi::OsString;

    fn test_config() -> Arc<Config> {
        let command = if cfg!(windows) {
            vec![
                OsString::from("cmd.exe"),
                OsString::from("/c"),
                OsString::from("ping -n 30 127.0.0.1 >nul"),
            ]
        } else {
            vec![OsString::from("sleep"), OsString::from("30")]
        };

        Arc::new(Config {
            port: 0,
            interface: None,
            socket_owner: None,
            credential: None,
            username: None,
            login_announcement: None,
            auth_header: None,
            uid: None,
            gid: None,
            signal: 15,
            signal_name: "SIGTERM".to_owned(),
            cwd: None,
            endpoints: Endpoints::from_base_path(None),
            ping_interval: 0,
            serv_buf_size: 4096,
            session_timeout: 30,
            session_buffer_size: DEFAULT_OUTPUT_BUFFER_LIMIT,
            ipv6: false,
            ssl: false,
            ssl_cert: None,
            ssl_key: None,
            ssl_ca: None,
            url_arg: false,
            writable: true,
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
            command_string: "sleep".to_owned(),
        })
    }

    #[tokio::test]
    async fn attaches_existing_session_and_rejects_owner_mismatch() {
        let shutdown = CancellationToken::new();
        let manager = SessionManager::start(test_config(), shutdown.clone());

        let (session, created) = manager
            .attach_or_create(AttachRequest {
                session_id: None,
                owner: Some("alice"),
                columns: 80,
                rows: 24,
                user: Some("alice"),
                args: &[],
                timeout: Duration::from_secs(30),
            })
            .expect("create");
        assert!(created);
        let id = session.id.clone();

        let (attached, created) = manager
            .attach_or_create(AttachRequest {
                session_id: Some(&id),
                owner: Some("alice"),
                columns: 80,
                rows: 24,
                user: Some("alice"),
                args: &[],
                timeout: Duration::from_secs(30),
            })
            .expect("attach");
        assert!(!created);
        assert_eq!(attached.id, id);
        assert_eq!(manager.detach(&attached), 1);
        assert_eq!(manager.detach(&session), 0);

        let result = manager.attach_or_create(AttachRequest {
            session_id: Some(&id),
            owner: Some("bob"),
            columns: 80,
            rows: 24,
            user: Some("bob"),
            args: &[],
            timeout: Duration::from_secs(30),
        });
        assert!(matches!(result, Err(AttachError::Forbidden)));

        shutdown.cancel();
        drop(manager);
    }

    #[tokio::test]
    async fn zero_timeout_detach_removes_the_last_client_session() {
        let shutdown = CancellationToken::new();
        let manager = SessionManager::start(test_config(), shutdown.clone());

        let (session, _) = manager
            .attach_or_create(AttachRequest {
                session_id: None,
                owner: None,
                columns: 80,
                rows: 24,
                user: None,
                args: &[],
                timeout: Duration::ZERO,
            })
            .expect("create");
        let id = session.id.clone();
        assert_eq!(manager.detach(&session), 0);

        let (replacement, created) = manager
            .attach_or_create(AttachRequest {
                session_id: Some(&id),
                owner: None,
                columns: 80,
                rows: 24,
                user: None,
                args: &[],
                timeout: Duration::ZERO,
            })
            .expect("recreate");
        assert!(created);
        assert_ne!(replacement.id, id);

        shutdown.cancel();
        drop(manager);
    }
}
