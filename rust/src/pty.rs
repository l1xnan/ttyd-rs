use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use bytes::Bytes;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, mpsc as tokio_mpsc, watch};

use crate::config::Config;

/// Queued client input messages. A fast or hostile writable client cannot grow this without bound.
pub const INPUT_QUEUE_CAPACITY: usize = 64;

/// Largest `0` payload accepted from one WebSocket frame.
pub const MAX_INPUT_FRAME: usize = 256 * 1024;

/// Default amount of PTY output kept for replay when a client reconnects.
pub const DEFAULT_OUTPUT_BUFFER_LIMIT: usize = 4 * 1024 * 1024;

const EVENT_CHANNEL_CAPACITY: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    Running,
    Exited(i32),
}

#[derive(Clone, Debug)]
pub struct OutputFrame {
    pub offset: u64,
    pub data: Bytes,
}

impl OutputFrame {
    pub fn end(&self) -> u64 {
        self.offset.saturating_add(self.data.len() as u64)
    }
}

#[derive(Clone, Debug)]
pub enum SessionEvent {
    Data(OutputFrame),
    Eof,
}

pub enum InputReject {
    Full(Vec<u8>),
    Closed,
}

/// Raw output history kept for reconnecting clients.
struct OutputRing {
    chunks: VecDeque<Bytes>,
    bytes: usize,
    start: u64,
    limit: usize,
}

impl OutputRing {
    fn new(limit: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            start: 0,
            limit: limit.max(1),
        }
    }

    fn end(&self) -> u64 {
        self.start.saturating_add(self.bytes as u64)
    }

    fn push(&mut self, data: Bytes) -> OutputFrame {
        let offset = self.end();
        self.bytes = self.bytes.saturating_add(data.len());
        self.chunks.push_back(data.clone());

        // Keep the buffer bounded, but always retain at least one chunk so a
        // single oversized read can still be replayed.
        while self.bytes > self.limit && self.chunks.len() > 1 {
            let Some(front) = self.chunks.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(front.len());
            self.start = self.start.saturating_add(front.len() as u64);
        }

        OutputFrame { offset, data }
    }

    fn snapshot(&self) -> (Vec<u8>, u64) {
        let mut output = Vec::with_capacity(self.bytes);
        for chunk in &self.chunks {
            output.extend_from_slice(chunk);
        }
        (output, self.end())
    }
}

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    pid: Option<u32>,
    #[cfg(unix)]
    pgid: Option<i32>,
    pub input_tx: tokio_mpsc::Sender<Vec<u8>>,
    events: broadcast::Sender<SessionEvent>,
    ring: Arc<Mutex<OutputRing>>,
    status: watch::Sender<SessionStatus>,
    exited: Arc<AtomicBool>,
    kill_signal: i32,
}

impl PtySession {
    pub fn spawn(
        config: &Config,
        extra_args: &[String],
        columns: u16,
        rows: u16,
        user: Option<&str>,
    ) -> Result<Self> {
        let mut argv = config.command.clone();
        argv.extend(extra_args.iter().map(OsString::from));

        let columns = if columns == 0 { 80 } else { columns };
        let rows = if rows == 0 { 24 } else { rows };

        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open a PTY")?;

        let mut command = CommandBuilder::new(&argv[0]);
        for arg in &argv[1..] {
            command.arg(arg);
        }
        if let Some(cwd) = &config.cwd {
            command.cwd(cwd);
        }
        command.env("TERM", &config.terminal_type);
        if let Some(user) = user.filter(|user| !user.is_empty()) {
            command.env("TTYD_USER", user);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .context("failed to spawn the command")?;
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        #[cfg(unix)]
        let pgid = pair.master.process_group_leader();

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let mut writer = pair
            .master
            .take_writer()
            .context("failed to get PTY writer")?;

        let (input_tx, mut input_rx) = tokio_mpsc::channel::<Vec<u8>>(INPUT_QUEUE_CAPACITY);
        let (events, _) = broadcast::channel::<SessionEvent>(EVENT_CHANNEL_CAPACITY);
        let (status, _) = watch::channel(SessionStatus::Running);
        let ring = Arc::new(Mutex::new(OutputRing::new(config.session_buffer_size)));
        let exited = Arc::new(AtomicBool::new(false));
        let waiter_exited = exited.clone();
        let read_size = config.serv_buf_size.max(1);

        let reader_ring = ring.clone();
        let reader_events = events.clone();
        std::thread::Builder::new()
            .name("ttyd-pty-reader".to_owned())
            .spawn(move || {
                let mut buffer = vec![0u8; read_size];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            let frame = {
                                let mut ring = reader_ring
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                ring.push(Bytes::copy_from_slice(&buffer[..count]))
                            };
                            let _ = reader_events.send(SessionEvent::Data(frame));
                        }
                        Err(error) => {
                            if error.kind() != std::io::ErrorKind::Interrupted {
                                break;
                            }
                        }
                    }
                }
                let _ = reader_events.send(SessionEvent::Eof);
            })
            .context("failed to start PTY reader thread")?;

        std::thread::Builder::new()
            .name("ttyd-pty-writer".to_owned())
            .spawn(move || {
                while let Some(data) = input_rx.blocking_recv() {
                    if writer.write_all(&data).is_err() || writer.flush().is_err() {
                        break;
                    }
                }
            })
            .context("failed to start PTY writer thread")?;

        let waiter_status = status.clone();
        std::thread::Builder::new()
            .name("ttyd-pty-waiter".to_owned())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => -1,
                };
                waiter_exited.store(true, Ordering::SeqCst);
                let _ = waiter_status.send(SessionStatus::Exited(code));
            })
            .context("failed to start PTY wait thread")?;

        Ok(Self {
            master: Mutex::new(pair.master),
            killer: Arc::new(Mutex::new(killer)),
            pid,
            #[cfg(unix)]
            pgid,
            input_tx,
            events,
            ring,
            status,
            exited,
            kill_signal: config.signal,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    pub fn status(&self) -> watch::Receiver<SessionStatus> {
        self.status.subscribe()
    }

    pub fn snapshot(&self) -> (Vec<u8>, u64) {
        self.ring
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot()
    }

    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub fn try_write(&self, data: Vec<u8>) -> Result<(), InputReject> {
        match self.input_tx.try_send(data) {
            Ok(()) => Ok(()),
            Err(tokio_mpsc::error::TrySendError::Full(data)) => Err(InputReject::Full(data)),
            Err(tokio_mpsc::error::TrySendError::Closed(_)) => Err(InputReject::Closed),
        }
    }

    pub fn resize(&self, columns: u16, rows: u16) {
        if columns == 0 || rows == 0 {
            return;
        }
        let Ok(master) = self.master.lock() else {
            return;
        };
        let _ = master.resize(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn kill(&self, signal: i32) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }

        #[cfg(not(unix))]
        let _ = signal;

        #[cfg(unix)]
        {
            let target = self.pgid.or_else(|| self.pid.map(|pid| pid as i32));
            if let Some(target) = target.filter(|target| *target > 0) {
                let signal = if signal > 0 { signal } else { 1 };
                let result = unsafe { libc::kill(-target, signal) };
                if result == 0 {
                    return;
                }
            }
        }

        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    pub fn kill_default(&self) {
        self.kill(self.kill_signal);
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill(self.kill_signal);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    fn idle_command() -> Vec<OsString> {
        if cfg!(windows) {
            vec![
                OsString::from("powershell.exe"),
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 30"),
            ]
        } else {
            vec![OsString::from("sleep"), OsString::from("30")]
        }
    }

    #[cfg(unix)]
    fn idle_config() -> Config {
        Config {
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
            endpoints: crate::config::Endpoints::from_base_path(None),
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
            command: idle_command(),
            command_string: "sleep".to_owned(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn input_queue_rejects_when_the_pty_stops_reading() {
        let config = idle_config();
        let session = PtySession::spawn(&config, &[], 80, 24, None).expect("spawn");
        let mut rejected = false;
        for _ in 0..4_096 {
            match session.try_write(vec![b'a'; 4096]) {
                Ok(()) => {}
                Err(InputReject::Full(_)) => {
                    rejected = true;
                    break;
                }
                Err(InputReject::Closed) => break,
            }
        }
        drop(session);
        assert!(rejected, "bounded input queue did not fill");
    }
}
