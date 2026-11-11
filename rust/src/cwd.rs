//! Resolve the directory an HTTP transfer should operate on.
//!
//! On Linux the shell process spawned by the PTY is the direct child (`pid()`
//! comes from `spawn_command`), so `/proc/<pid>/cwd` is the directory the user
//! actually `cd`-ed into. When that is unavailable, uploads use the configured
//! `--http-transfer-dir`, then `-w`, then the process cwd.

use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::session::ManagedSession;

#[derive(Debug)]
pub enum ResolveError {
    OutsideRoot,
    Io(std::io::Error),
}

impl From<std::io::Error> for ResolveError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedDir {
    pub path: PathBuf,
    /// True when `path` is the live shell cwd.
    pub followed: bool,
}

pub fn within_root(candidate: &Path, root: &Path) -> bool {
    match (candidate.canonicalize(), root.canonicalize()) {
        (Ok(candidate), Ok(root)) => candidate.starts_with(root),
        _ => false,
    }
}

fn check_root(config: &Config, path: &Path) -> Result<(), ResolveError> {
    if let Some(root) = &config.http_transfer_root {
        if !within_root(path, root) {
            return Err(ResolveError::OutsideRoot);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn shell_cwd(session: &ManagedSession) -> Option<PathBuf> {
    let pid = session.pty.pid()?;
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()?
        .canonicalize()
        .ok()
}

#[cfg(not(target_os = "linux"))]
fn shell_cwd(_session: &ManagedSession) -> Option<PathBuf> {
    None
}

pub fn resolve(config: &Config, session: &ManagedSession) -> Result<ResolvedDir, ResolveError> {
    if config.http_transfer_follow_cwd {
        if let Some(path) = shell_cwd(session) {
            check_root(config, &path)?;
            return Ok(ResolvedDir {
                path,
                followed: true,
            });
        }
    }

    let fallback = config
        .http_transfer_dir
        .clone()
        .or_else(|| config.cwd.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir()));
    let path = fallback.canonicalize()?;
    std::fs::create_dir_all(&path)?;
    check_root(config, &path)?;
    Ok(ResolvedDir {
        path,
        followed: false,
    })
}
