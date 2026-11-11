use std::ffi::OsString;
use std::path::PathBuf;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug)]
pub struct Endpoints {
    pub ws: String,
    pub index: String,
    pub token: String,
    pub login: String,
    pub logout: String,
    pub sessions: String,
    pub parent: String,
    /// `POST` uploads one file (raw body).
    pub files_upload: String,
    /// `GET` downloads any path (`?path=`, absolute or relative to the destination).
    pub file_download: String,
}

impl Endpoints {
    pub fn from_base_path(base_path: Option<&str>) -> Self {
        let base = base_path.unwrap_or("").trim_end_matches('/');
        if base.is_empty() {
            return Self {
                ws: "/ws".to_owned(),
                index: "/".to_owned(),
                token: "/token".to_owned(),
                login: "/login".to_owned(),
                logout: "/logout".to_owned(),
                sessions: "/sessions".to_owned(),
                parent: String::new(),
                files_upload: "/sessions/{id}/files".to_owned(),
                file_download: "/sessions/{id}/download".to_owned(),
            };
        }

        Self {
            ws: format!("{base}/ws"),
            index: format!("{base}/"),
            token: format!("{base}/token"),
            login: format!("{base}/login"),
            logout: format!("{base}/logout"),
            sessions: format!("{base}/sessions"),
            parent: base.to_owned(),
            files_upload: format!("{base}/sessions/{{id}}/files"),
            file_download: format!("{base}/sessions/{{id}}/download"),
        }
    }

    /// Path of one session resource, for example `/sessions/<id>`.
    pub fn session(&self, id: &str) -> String {
        format!("{}/{}", self.sessions, id)
    }

    pub fn cookie_path(&self) -> &str {
        if self.parent.is_empty() {
            "/"
        } else {
            &self.parent
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub interface: Option<String>,
    pub socket_owner: Option<String>,
    pub credential: Option<String>,
    pub username: Option<String>,
    /// Plain `username:password` printed once when `--random-credential` is set.
    pub login_announcement: Option<String>,
    pub auth_header: Option<String>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub signal: i32,
    pub signal_name: String,
    pub cwd: Option<PathBuf>,
    pub endpoints: Endpoints,
    pub ping_interval: u64,
    pub serv_buf_size: usize,
    pub session_timeout: u64,
    pub session_buffer_size: usize,
    pub history_limit: usize,
    pub ipv6: bool,
    pub ssl: bool,
    pub ssl_cert: Option<PathBuf>,
    pub ssl_key: Option<PathBuf>,
    pub ssl_ca: Option<PathBuf>,
    pub url_arg: bool,
    pub writable: bool,
    pub check_origin: bool,
    pub max_clients: usize,
    pub once: bool,
    pub exit_no_conn: bool,
    pub browser: bool,
    pub debug_level: i32,
    pub terminal_type: String,
    pub index: Option<PathBuf>,
    pub prefs_json: String,
    pub command: Vec<OsString>,
    pub command_string: String,
    /// Enable the HTTP file transfer endpoints. Disabled by default; `-W` is
    /// additionally required for every request.
    pub http_transfer: bool,
    /// Optional whitelist: `Some(dir)` restricts all file operations to that
    /// canonicalized tree. `None` allows any path the server user can access.
    pub http_transfer_root: Option<PathBuf>,
    /// Upload destination when the shell cwd cannot be followed (Windows,
    /// macOS, probe failure, or `--no-http-follow-cwd`). Falls back to `-w` /
    /// the process cwd when unset.
    pub http_transfer_dir: Option<PathBuf>,
    /// Maximum size of a single uploaded file, in bytes.
    pub http_transfer_max_upload: usize,
    /// Approximate per-directory quota, in bytes. `0` disables the check.
    pub http_transfer_session_quota: usize,
    /// Follow the shell cwd via `/proc/<pid>/cwd` on Linux. When false (or
    /// unsupported) uploads use `http_transfer_dir` / `-w` / the process cwd.
    pub http_transfer_follow_cwd: bool,
}

impl Config {
    pub fn is_unix_socket(&self) -> bool {
        self.interface
            .as_deref()
            .is_some_and(|path| path.ends_with(".sock") || path.ends_with(".socket"))
    }
}

#[cfg(not(unix))]
const WINDOWS_SIGNALS: &[(i32, &str)] = &[
    // SIGHUP and SIGKILL are accepted so the documented default and common names
    // still parse. Windows terminates the process instead of delivering them.
    (1, "SIGHUP"),
    (2, "SIGINT"),
    (4, "SIGILL"),
    (8, "SIGFPE"),
    (9, "SIGKILL"),
    (11, "SIGSEGV"),
    (15, "SIGTERM"),
    (21, "SIGBREAK"),
    (22, "SIGABRT"),
];

pub fn signal_names() -> &'static [(i32, &'static str)] {
    #[cfg(unix)]
    {
        use std::sync::OnceLock;
        static NAMES: OnceLock<Vec<(i32, &'static str)>> = OnceLock::new();
        NAMES.get_or_init(unix_signal_names).as_slice()
    }
    #[cfg(not(unix))]
    WINDOWS_SIGNALS
}

#[cfg(unix)]
fn unix_signal_names() -> Vec<(i32, &'static str)> {
    macro_rules! sig {
        ($($name:ident),* $(,)?) => {
            vec![$((libc::$name, stringify!($name))),*]
        };
    }

    let mut names = sig![
        SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGTRAP, SIGABRT, SIGFPE, SIGKILL, SIGBUS, SIGSEGV,
        SIGSYS, SIGPIPE, SIGALRM, SIGTERM, SIGURG, SIGSTOP, SIGTSTP, SIGCONT, SIGCHLD, SIGTTIN,
        SIGTTOU, SIGUSR1, SIGUSR2, SIGXCPU, SIGXFSZ, SIGVTALRM, SIGPROF, SIGWINCH, SIGIO,
    ];

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        names.push((libc::SIGSTKFLT, "SIGSTKFLT"));
        names.push((libc::SIGPWR, "SIGPWR"));
    }

    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd",
    ))]
    {
        names.push((libc::SIGEMT, "SIGEMT"));
        names.push((libc::SIGINFO, "SIGINFO"));
    }

    names
}

pub fn signal_number(value: &str) -> Option<i32> {
    let value = value.trim();
    if let Ok(number) = value.parse::<i32>() {
        return (number > 0).then_some(number);
    }

    let value = value.to_ascii_uppercase();
    let value = value.strip_prefix("SIG").unwrap_or(&value);
    signal_names()
        .iter()
        .find_map(|(number, name)| (name.strip_prefix("SIG") == Some(value)).then_some(*number))
}

pub fn signal_name(number: i32) -> String {
    signal_names()
        .iter()
        .find_map(|(value, name)| (*value == number).then(|| (*name).to_owned()))
        .unwrap_or_else(|| format!("SIG{number}"))
}

pub fn hostname() -> String {
    hostname::get()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "localhost".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_default_endpoints() {
        let endpoints = Endpoints::from_base_path(None);
        assert_eq!(endpoints.ws, "/ws");
        assert_eq!(endpoints.index, "/");
        assert_eq!(endpoints.token, "/token");
        assert_eq!(endpoints.login, "/login");
        assert_eq!(endpoints.logout, "/logout");
        assert_eq!(endpoints.sessions, "/sessions");
        assert_eq!(endpoints.session("abc"), "/sessions/abc");
        assert_eq!(endpoints.cookie_path(), "/");
        assert!(endpoints.parent.is_empty());
        assert_eq!(endpoints.files_upload, "/sessions/{id}/files");
        assert_eq!(endpoints.file_download, "/sessions/{id}/download");
    }

    #[test]
    fn builds_base_path_endpoints() {
        let endpoints = Endpoints::from_base_path(Some("/mounted/here/"));
        assert_eq!(endpoints.ws, "/mounted/here/ws");
        assert_eq!(endpoints.index, "/mounted/here/");
        assert_eq!(endpoints.token, "/mounted/here/token");
        assert_eq!(endpoints.login, "/mounted/here/login");
        assert_eq!(endpoints.logout, "/mounted/here/logout");
        assert_eq!(endpoints.sessions, "/mounted/here/sessions");
        assert_eq!(endpoints.session("abc"), "/mounted/here/sessions/abc");
        assert_eq!(endpoints.cookie_path(), "/mounted/here");
        assert_eq!(endpoints.parent, "/mounted/here");
        assert_eq!(endpoints.files_upload, "/mounted/here/sessions/{id}/files");
        assert_eq!(
            endpoints.file_download,
            "/mounted/here/sessions/{id}/download"
        );
    }

    #[test]
    fn resolves_signal_numbers_and_names() {
        assert_eq!(signal_number("1"), Some(1));
        assert_eq!(signal_number("SIGINT"), Some(2));
        assert_eq!(signal_number("int"), Some(2));
        assert_eq!(signal_number("0"), None);
        assert_eq!(signal_number("127"), Some(127));
        assert_eq!(signal_number("999"), Some(999));
        assert_eq!(signal_name(9), "SIGKILL");
        assert_eq!(signal_name(99), "SIG99");
    }

    #[cfg(unix)]
    #[test]
    fn unix_signal_names_match_libc() {
        assert_eq!(signal_number("SIGHUP"), Some(libc::SIGHUP));
        assert_eq!(signal_number("SIGCHLD"), Some(libc::SIGCHLD));
        assert_eq!(signal_number("SIGKILL"), Some(libc::SIGKILL));
        assert_eq!(signal_name(libc::SIGTERM), "SIGTERM");
    }

    #[test]
    fn hostname_is_never_empty() {
        assert!(!hostname().is_empty());
    }
}
