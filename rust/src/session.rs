use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use bytes::Bytes;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
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

/// Result of looking up a session that may belong to somebody else.
#[derive(Debug)]
pub enum Lookup<T> {
    Found(T),
    Forbidden,
    NotFound,
}

/// Result of deleting a live session or a history record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    Live,
    History,
    Forbidden,
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Running,
    Exited,
}

/// Metadata returned by the session HTTP APIs. It never contains the replay
/// buffer; history output is only served over the WebSocket replay.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub owner: Option<String>,
    pub command: String,
    pub state: SessionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
}

/// A read-only replay of an ended session.
#[derive(Clone, Debug)]
pub struct HistoryReplay {
    pub output: Bytes,
    pub exit_code: i32,
}

struct HistoryEntry {
    id: String,
    owner: Option<String>,
    command: String,
    exit_code: i32,
    ended_at: u64,
    output: Bytes,
}

impl HistoryEntry {
    fn summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            owner: self.owner.clone(),
            command: self.command.clone(),
            state: SessionState::Exited,
            attached: None,
            exit_code: Some(self.exit_code),
            ended_at: Some(self.ended_at),
        }
    }
}

/// Bounded, in-memory table of ended sessions. Entries are stored oldest first
/// and trimmed from the front, so the newest records always survive.
struct HistoryTable {
    limit: usize,
    entries: VecDeque<HistoryEntry>,
}

impl HistoryTable {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            entries: VecDeque::new(),
        }
    }

    fn push(&mut self, entry: HistoryEntry) {
        if self.limit == 0 {
            return;
        }

        // A session must never be archived twice; keep the newest copy.
        if let Some(position) = self
            .entries
            .iter()
            .position(|existing| existing.id == entry.id)
        {
            self.entries.remove(position);
        }
        self.entries.push_back(entry);
        while self.entries.len() > self.limit {
            self.entries.pop_front();
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.entries.iter().any(|entry| entry.id == id)
    }

    fn list(&self, owner: Option<&str>) -> Vec<SessionSummary> {
        self.entries
            .iter()
            .rev()
            .filter(|entry| entry.owner.as_deref() == owner)
            .map(HistoryEntry::summary)
            .collect()
    }

    fn get(&self, id: &str, owner: Option<&str>) -> Lookup<SessionSummary> {
        match self.entries.iter().find(|entry| entry.id == id) {
            Some(entry) if entry.owner.as_deref() != owner => Lookup::Forbidden,
            Some(entry) => Lookup::Found(entry.summary()),
            None => Lookup::NotFound,
        }
    }

    fn replay(&self, id: &str, owner: Option<&str>) -> Lookup<HistoryReplay> {
        match self.entries.iter().find(|entry| entry.id == id) {
            Some(entry) if entry.owner.as_deref() != owner => Lookup::Forbidden,
            Some(entry) => Lookup::Found(HistoryReplay {
                output: entry.output.clone(),
                exit_code: entry.exit_code,
            }),
            None => Lookup::NotFound,
        }
    }

    fn remove(&mut self, id: &str, owner: Option<&str>) -> Lookup<()> {
        let Some(position) = self.entries.iter().position(|entry| entry.id == id) else {
            return Lookup::NotFound;
        };
        if self.entries[position].owner.as_deref() != owner {
            return Lookup::Forbidden;
        }
        self.entries.remove(position);
        Lookup::Found(())
    }
}

struct SessionStateInner {
    attached: usize,
    detached_at: Option<Instant>,
    timeout: Duration,
    /// In-flight HTTP file transfers must keep the session alive even when no
    /// WebSocket client is attached (the reaper runs once per second).
    active_transfers: usize,
}

pub struct ManagedSession {
    pub id: String,
    pub owner: Option<String>,
    /// Launch command recorded when the session was created.
    pub command: String,
    pub pty: Arc<PtySession>,
    created_at: SystemTime,
    state: Mutex<SessionStateInner>,
    /// Serializes "check -> write temp -> rename" for clients sharing a session.
    pub transfer_lock: tokio::sync::Mutex<()>,
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
    fn new(
        id: String,
        owner: Option<String>,
        command: String,
        pty: Arc<PtySession>,
        timeout: Duration,
    ) -> Self {
        Self {
            id,
            owner,
            command,
            pty,
            created_at: SystemTime::now(),
            state: Mutex::new(SessionStateInner {
                attached: 1,
                detached_at: None,
                timeout,
                active_transfers: 0,
            }),
            transfer_lock: tokio::sync::Mutex::new(()),
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

    pub fn attached_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .attached
    }

    pub fn is_expired(&self, now: Instant) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.attached == 0
            && state.active_transfers == 0
            && state
                .detached_at
                .is_some_and(|detached| now.saturating_duration_since(detached) >= state.timeout)
    }

    /// Keep this session alive while an HTTP transfer is in flight.
    pub fn begin_transfer(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active_transfers = state.active_transfers.saturating_add(1);
    }

    pub fn end_transfer(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active_transfers = state.active_transfers.saturating_sub(1);
    }

    fn summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            owner: self.owner.clone(),
            command: self.command.clone(),
            state: SessionState::Running,
            attached: Some(self.attached_count()),
            exit_code: None,
            ended_at: None,
        }
    }
}

pub struct SessionManager {
    config: Arc<Config>,
    sessions: Mutex<HashMap<String, Arc<ManagedSession>>>,
    history: Mutex<HistoryTable>,
}

impl SessionManager {
    pub fn start(config: Arc<Config>, shutdown: CancellationToken) -> Arc<Self> {
        let history_limit = config.history_limit;
        let manager = Arc::new(Self {
            config,
            sessions: Mutex::new(HashMap::new()),
            history: Mutex::new(HistoryTable::new(history_limit)),
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
        let now = Instant::now();
        let mut reclaimed: Option<Arc<ManagedSession>> = None;

        if let Some(requested_id) = session_id.filter(|id| !id.is_empty() && id.len() <= 128) {
            if let Some(session) = sessions.get(requested_id).cloned() {
                if session.is_expired(now) || session.pty.is_exited() {
                    reclaimed = sessions.remove(requested_id);
                } else if session.owner.as_deref() != owner {
                    return Err(AttachError::Forbidden);
                } else {
                    session.set_timeout(timeout);
                    session.attach();
                    return Ok((session, false));
                }
            }
        }

        if let Some(session) = reclaimed {
            self.archive(&session);
            session.pty.kill_default();
        }

        let pty = PtySession::spawn(self.config.as_ref(), args, columns, rows, user)
            .map_err(AttachError::Spawn)?;
        let id = {
            let history = self
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            generate_id(&sessions, &history)
        };
        let command = command_line(&self.config.command_string, args);
        let session = Arc::new(ManagedSession::new(
            id.clone(),
            owner.map(str::to_owned),
            command,
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
            if let Some(removed) = sessions.remove(&session.id) {
                self.archive(&removed);
                drop(sessions);
                removed.pty.kill_default();
            }
        }

        remaining
    }

    /// Running sessions for the given owner, newest first.
    pub fn live_sessions(&self, owner: Option<&str>) -> Vec<SessionSummary> {
        let now = Instant::now();
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut live: Vec<&ManagedSession> = sessions
            .values()
            .filter(|session| session.owner.as_deref() == owner)
            .filter(|session| !session.pty.is_exited() && !session.is_expired(now))
            .map(Arc::as_ref)
            .collect();
        live.sort_by_key(|session| std::cmp::Reverse(session.created_at));
        live.into_iter().map(ManagedSession::summary).collect()
    }

    /// Ended sessions for the given owner, newest first. No replay data.
    pub fn history_sessions(&self, owner: Option<&str>) -> Vec<SessionSummary> {
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .list(owner)
    }

    /// Metadata for one running session or history record.
    pub fn get(&self, id: &str, owner: Option<&str>) -> Lookup<SessionSummary> {
        let now = Instant::now();
        {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(session) = sessions.get(id) {
                if session.owner.as_deref() != owner {
                    return Lookup::Forbidden;
                }
                if !session.pty.is_exited() && !session.is_expired(now) {
                    return Lookup::Found(session.summary());
                }
            }
        }

        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id, owner)
    }

    /// Locate a *running* session and hand out its PTY handle.
    ///
    /// Unlike [`Self::get`] this returns the session itself so HTTP transfer
    /// handlers can resolve its cwd and write files. Ended, expired and
    /// read-only history sessions have no shell cwd to follow and are reported
    /// as `NotFound`.
    pub fn live(&self, id: &str, owner: Option<&str>) -> Lookup<Arc<ManagedSession>> {
        if id.is_empty() || id.len() > 128 {
            return Lookup::NotFound;
        }
        let now = Instant::now();
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match sessions.get(id) {
            Some(session) if session.owner.as_deref() != owner => Lookup::Forbidden,
            Some(session) if session.pty.is_exited() || session.is_expired(now) => Lookup::NotFound,
            Some(session) => Lookup::Found(session.clone()),
            None => Lookup::NotFound,
        }
    }

    /// Read-only replay data for one ended session.
    pub fn history_for(&self, id: &str, owner: Option<&str>) -> Lookup<HistoryReplay> {
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .replay(id, owner)
    }

    /// Delete a running session (kill and archive it) or a history record.
    pub fn delete(&self, id: &str, owner: Option<&str>) -> DeleteOutcome {
        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match sessions.get(id) {
                Some(session) if session.owner.as_deref() != owner => {
                    return DeleteOutcome::Forbidden;
                }
                Some(_) => sessions.remove(id),
                None => None,
            }
        };

        if let Some(session) = session {
            self.archive(&session);
            session.pty.kill_default();
            return DeleteOutcome::Live;
        }

        match self
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id, owner)
        {
            Lookup::Found(()) => DeleteOutcome::History,
            Lookup::Forbidden => DeleteOutcome::Forbidden,
            Lookup::NotFound => DeleteOutcome::NotFound,
        }
    }

    /// Copy a session's metadata and replay buffer into the history table.
    fn archive(&self, session: &ManagedSession) {
        if self.config.history_limit == 0 {
            return;
        }
        let (output, _) = session.pty.snapshot();
        let entry = HistoryEntry {
            id: session.id.clone(),
            owner: session.owner.clone(),
            command: session.command.clone(),
            exit_code: session.pty.exit_code().unwrap_or(-1),
            ended_at: unix_millis(SystemTime::now()),
            output: Bytes::from(output),
        };
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(entry);
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
            self.archive(&session);
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

fn command_line(base: &str, args: &[String]) -> String {
    let mut command = base.to_owned();
    for arg in args {
        command.push(' ');
        command.push_str(arg);
    }
    command
}

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

fn generate_id(sessions: &HashMap<String, Arc<ManagedSession>>, history: &HistoryTable) -> String {
    let random = SystemRandom::new();
    for _ in 0..16 {
        let mut bytes = [0u8; 16];
        if random.fill(&mut bytes).is_ok() {
            let mut id = String::with_capacity(32);
            for byte in bytes {
                let _ = write!(&mut id, "{byte:02x}");
            }
            if !sessions.contains_key(&id) && !history.contains(&id) {
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
    while sessions.contains_key(&id) || history.contains(&id) {
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
        test_config_with_history(20)
    }

    fn test_config_with_history(history_limit: usize) -> Arc<Config> {
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
            history_limit,
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
            http_transfer: false,
            http_transfer_root: None,
            http_transfer_dir: None,
            http_transfer_max_upload: 64 * 1024 * 1024,
            http_transfer_session_quota: 256 * 1024 * 1024,
            http_transfer_follow_cwd: true,
        })
    }

    fn history_entry(id: &str, owner: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            id: id.to_owned(),
            owner: owner.map(str::to_owned),
            command: "sleep".to_owned(),
            exit_code: 0,
            ended_at: 1,
            output: Bytes::from_static(b"output"),
        }
    }

    #[test]
    fn history_table_drops_the_oldest_entry() {
        let mut history = HistoryTable::new(2);
        history.push(history_entry("a", None));
        history.push(history_entry("b", None));
        history.push(history_entry("c", None));

        assert!(!history.contains("a"));
        assert!(history.contains("b"));
        assert!(history.contains("c"));
        let list = history.list(None);
        assert_eq!(
            list.iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(list[0].state, SessionState::Exited);
        assert_eq!(list[0].exit_code, Some(0));
    }

    #[test]
    fn history_table_zero_limit_discards_everything() {
        let mut history = HistoryTable::new(0);
        history.push(history_entry("a", None));

        assert!(history.list(None).is_empty());
        assert!(!history.contains("a"));
        assert!(matches!(history.remove("a", None), Lookup::NotFound));
    }

    #[test]
    fn history_table_filters_entries_by_owner() {
        let mut history = HistoryTable::new(20);
        history.push(history_entry("alice-1", Some("alice")));
        history.push(history_entry("bob-1", Some("bob")));
        history.push(history_entry("alice-2", Some("alice")));

        let alice = history.list(Some("alice"));
        assert_eq!(
            alice
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["alice-2", "alice-1"]
        );
        assert!(history.list(None).is_empty());
        assert!(matches!(
            history.get("bob-1", Some("alice")),
            Lookup::Forbidden
        ));
        assert!(matches!(
            history.remove("bob-1", Some("alice")),
            Lookup::Forbidden
        ));
    }

    #[test]
    fn history_table_replaces_duplicate_ids() {
        let mut history = HistoryTable::new(20);
        history.push(history_entry("same", None));
        let mut newer = history_entry("same", None);
        newer.exit_code = 7;
        history.push(newer);

        let list = history.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].exit_code, Some(7));
    }

    #[test]
    fn builds_the_launch_command_from_url_arguments() {
        assert_eq!(command_line("bash", &[]), "bash");
        assert_eq!(
            command_line("bash", &["-l".to_owned(), "script.sh".to_owned()]),
            "bash -l script.sh"
        );
    }

    #[test]
    fn unix_millis_is_never_zero_for_now() {
        assert!(unix_millis(SystemTime::now()) > 0);
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

    #[tokio::test]
    async fn zero_timeout_detach_archives_a_history_record() {
        let shutdown = CancellationToken::new();
        let manager = SessionManager::start(test_config(), shutdown.clone());

        let (session, _) = manager
            .attach_or_create(AttachRequest {
                session_id: None,
                owner: Some("alice"),
                columns: 80,
                rows: 24,
                user: Some("alice"),
                args: &[],
                timeout: Duration::ZERO,
            })
            .expect("create");
        let id = session.id.clone();
        assert_eq!(manager.detach(&session), 0);

        let history = manager.history_sessions(Some("alice"));
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, id);
        assert_eq!(history[0].owner.as_deref(), Some("alice"));
        assert_eq!(history[0].command, "sleep");
        assert_eq!(history[0].exit_code, Some(-1));
        assert!(history[0].ended_at.is_some());
        assert!(manager.history_for(&id, Some("alice")).is_found());
        assert!(manager.history_for(&id, Some("bob")).is_forbidden());
        assert!(matches!(
            manager.get(&id, Some("alice")),
            Lookup::Found(SessionSummary {
                state: SessionState::Exited,
                ..
            })
        ));

        shutdown.cancel();
        drop(manager);
    }

    #[tokio::test]
    async fn history_limit_is_applied_when_archiving() {
        let shutdown = CancellationToken::new();
        let manager = SessionManager::start(test_config_with_history(1), shutdown.clone());

        let (first, _) = manager
            .attach_or_create(AttachRequest {
                session_id: None,
                owner: None,
                columns: 80,
                rows: 24,
                user: None,
                args: &[],
                timeout: Duration::ZERO,
            })
            .expect("first");
        let first_id = first.id.clone();
        assert_eq!(manager.detach(&first), 0);

        let (second, _) = manager
            .attach_or_create(AttachRequest {
                session_id: None,
                owner: None,
                columns: 80,
                rows: 24,
                user: None,
                args: &[],
                timeout: Duration::ZERO,
            })
            .expect("second");
        let second_id = second.id.clone();
        assert_eq!(manager.detach(&second), 0);

        let history = manager.history_sessions(None);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, second_id);
        assert_ne!(history[0].id, first_id);

        shutdown.cancel();
        drop(manager);
    }

    trait LookupTestExt<T> {
        fn is_found(&self) -> bool;
        fn is_forbidden(&self) -> bool;
    }

    impl<T> LookupTestExt<T> for Lookup<T> {
        fn is_found(&self) -> bool {
            matches!(self, Lookup::Found(_))
        }

        fn is_forbidden(&self) -> bool {
            matches!(self, Lookup::Forbidden)
        }
    }
}
