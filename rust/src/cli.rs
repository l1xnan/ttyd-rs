use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;

use crate::config::{signal_name, signal_number, Config, Endpoints, VERSION};

pub enum Action {
    Help,
    Version,
    Run(Box<Config>),
}

pub fn parse_args() -> Result<Action> {
    parse_args_from(std::env::args_os().skip(1), take_env_credential()?)
}

fn parse_args_from(
    args: impl IntoIterator<Item = impl Into<OsString>>,
    env_credential: Option<String>,
) -> Result<Action> {
    let args: Vec<OsString> = args.into_iter().map(Into::into).collect();
    if args.is_empty() {
        return Ok(Action::Help);
    }

    let mut port = 7681u16;
    let mut interface: Option<String> = None;
    let mut socket_owner: Option<String> = None;
    let mut credential: Option<String> = None;
    let mut credential_file: Option<PathBuf> = None;
    let mut random_credential = false;
    let mut auth_header: Option<String> = None;
    let mut uid = None;
    let mut gid = None;
    let mut signal = 1i32;
    let mut cwd: Option<PathBuf> = None;
    let mut index: Option<PathBuf> = None;
    let mut base_path: Option<String> = None;
    let mut ping_interval = 5u64;
    let mut serv_buf_size = 4096usize;
    let mut session_timeout = 30u64;
    let mut session_buffer_size = crate::pty::DEFAULT_OUTPUT_BUFFER_LIMIT;
    let mut history_limit = 20usize;
    let mut ipv6 = false;
    let mut ssl = false;
    let mut ssl_cert: Option<PathBuf> = None;
    let mut ssl_key: Option<PathBuf> = None;
    let mut ssl_ca: Option<PathBuf> = None;
    let mut url_arg = false;
    let mut writable = false;
    let mut check_origin = false;
    let mut max_clients = 0usize;
    let mut once = false;
    let mut exit_no_conn = false;
    let mut browser = false;
    let mut debug_level = 7i32;
    let mut terminal_type = "xterm-256color".to_owned();

    let mut prefs = serde_json::Map::new();
    #[cfg(windows)]
    prefs.insert("isWindows".to_owned(), serde_json::Value::Bool(true));

    let mut i = 0usize;
    while i < args.len() {
        let raw = args[i].to_string_lossy().into_owned();
        if raw == "--" {
            i += 1;
            break;
        }
        if raw == "-" || !raw.starts_with('-') {
            break;
        }

        if let Some(option) = raw.strip_prefix("--") {
            let (name, inline) = match option.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (option, None),
            };

            let mut take_value = |name: &str| -> Result<String> {
                if let Some(value) = inline.clone() {
                    return Ok(value);
                }
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| anyhow!("option '--{name}' requires an argument"))?;
                Ok(value.to_string_lossy().into_owned())
            };

            match name {
                "help" => return Ok(Action::Help),
                "version" => return Ok(Action::Version),
                "port" => set_port(&mut port, &take_value(name)?)?,
                "interface" => interface = Some(take_value(name)?),
                "socket-owner" => socket_owner = Some(take_value(name)?),
                "credential" => credential = Some(encode_credential(&take_value(name)?)?),
                "credential-file" => credential_file = Some(PathBuf::from(take_value(name)?)),
                "random-credential" => random_credential = true,
                "auth-header" => auth_header = Some(take_value(name)?.to_ascii_lowercase()),
                "uid" => uid = Some(parse_u32("uid", &take_value(name)?)?),
                "gid" => gid = Some(parse_u32("gid", &take_value(name)?)?),
                "signal" => set_signal(&mut signal, &take_value(name)?)?,
                "cwd" => cwd = Some(PathBuf::from(take_value(name)?)),
                "index" => index = Some(parse_index(&take_value(name)?)?),
                "base-path" => base_path = Some(take_value(name)?),
                "ping-interval" => {
                    ping_interval = parse_unsigned("ping-interval", &take_value(name)?)? as u64
                }
                "srv-buf-size" => {
                    serv_buf_size = parse_unsigned("srv-buf-size", &take_value(name)?)?
                }
                "session-timeout" => {
                    session_timeout = parse_unsigned("session-timeout", &take_value(name)?)? as u64
                }
                "session-buffer-size" => {
                    session_buffer_size = parse_unsigned("session-buffer-size", &take_value(name)?)?
                }
                "history-limit" => {
                    history_limit = parse_unsigned("history-limit", &take_value(name)?)?
                }
                "ipv6" => ipv6 = true,
                "ssl" => ssl = true,
                "ssl-cert" => ssl_cert = Some(PathBuf::from(take_value(name)?)),
                "ssl-key" => ssl_key = Some(PathBuf::from(take_value(name)?)),
                "ssl-ca" => ssl_ca = Some(PathBuf::from(take_value(name)?)),
                "url-arg" => url_arg = true,
                "writable" => writable = true,
                "check-origin" => check_origin = true,
                "max-clients" => max_clients = parse_unsigned("max-clients", &take_value(name)?)?,
                "once" => once = true,
                "exit-no-conn" => exit_no_conn = true,
                "browser" => browser = true,
                "debug" => debug_level = parse_int("debug", &take_value(name)?)?,
                "terminal-type" => terminal_type = truncate(&take_value(name)?, 29),
                "client-option" => add_client_option(&mut prefs, &take_value(name)?)?,
                _ => bail!("unknown option '--{name}'"),
            }
            i += 1;
            continue;
        }

        let chars = raw[1..].char_indices();
        for (offset, flag) in chars {
            let rest = &raw[1 + offset + flag.len_utf8()..];
            let mut take_value = |name: &str| -> Result<String> {
                if !rest.is_empty() {
                    return Ok(rest.to_owned());
                }
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| anyhow!("option '-{name}' requires an argument"))?;
                Ok(value.to_string_lossy().into_owned())
            };

            match flag {
                'h' => return Ok(Action::Help),
                'v' => return Ok(Action::Version),
                'p' => {
                    set_port(&mut port, &take_value("p")?)?;
                    break;
                }
                'i' => {
                    interface = Some(take_value("i")?);
                    break;
                }
                'U' => {
                    socket_owner = Some(take_value("U")?);
                    break;
                }
                'c' => {
                    credential = Some(encode_credential(&take_value("c")?)?);
                    break;
                }
                'H' => {
                    auth_header = Some(take_value("H")?.to_ascii_lowercase());
                    break;
                }
                'u' => {
                    uid = Some(parse_u32("uid", &take_value("u")?)?);
                    break;
                }
                'g' => {
                    gid = Some(parse_u32("gid", &take_value("g")?)?);
                    break;
                }
                's' => {
                    set_signal(&mut signal, &take_value("s")?)?;
                    break;
                }
                'w' => {
                    cwd = Some(PathBuf::from(take_value("w")?));
                    break;
                }
                'I' => {
                    index = Some(parse_index(&take_value("I")?)?);
                    break;
                }
                'b' => {
                    base_path = Some(take_value("b")?);
                    break;
                }
                'P' => {
                    ping_interval = parse_unsigned("ping-interval", &take_value("P")?)? as u64;
                    break;
                }
                'f' => {
                    serv_buf_size = parse_unsigned("srv-buf-size", &take_value("f")?)?;
                    break;
                }
                '6' => ipv6 = true,
                'S' => ssl = true,
                'C' => {
                    ssl_cert = Some(PathBuf::from(take_value("C")?));
                    break;
                }
                'K' => {
                    ssl_key = Some(PathBuf::from(take_value("K")?));
                    break;
                }
                'A' => {
                    ssl_ca = Some(PathBuf::from(take_value("A")?));
                    break;
                }
                'a' => url_arg = true,
                'W' => writable = true,
                'O' => check_origin = true,
                'm' => {
                    max_clients = parse_unsigned("max-clients", &take_value("m")?)?;
                    break;
                }
                'o' => once = true,
                'q' => exit_no_conn = true,
                'B' => browser = true,
                'd' => {
                    debug_level = parse_int("debug", &take_value("d")?)?;
                    break;
                }
                'T' => {
                    terminal_type = truncate(&take_value("T")?, 29);
                    break;
                }
                't' => {
                    add_client_option(&mut prefs, &take_value("t")?)?;
                    break;
                }
                _ => bail!("unknown option '-{flag}'"),
            }
        }
        i += 1;
    }

    if let Some(path) = &base_path {
        let trimmed = path.trim_end_matches('/');
        if !trimmed.is_empty() && !trimmed.starts_with('/') {
            bail!("invalid base-path: must start with '/'");
        }
        if trimmed.len() > 128 {
            bail!("invalid base-path: maximum length is 128");
        }
    }

    let command = args[i..].to_vec();
    if command.is_empty() {
        bail!("missing start command");
    }

    let command_string = command
        .iter()
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");

    if ssl {
        let cert = ssl_cert
            .as_ref()
            .ok_or_else(|| anyhow!("--ssl requires --ssl-cert"))?;
        let key = ssl_key
            .as_ref()
            .ok_or_else(|| anyhow!("--ssl requires --ssl-key"))?;
        if !cert.is_file() {
            bail!("SSL certificate file not found: {}", cert.display());
        }
        if !key.is_file() {
            bail!("SSL private key file not found: {}", key.display());
        }
        if ssl_ca.as_ref().is_some_and(|path| !path.is_file()) {
            bail!(
                "SSL CA file not found: {}",
                ssl_ca.as_ref().expect("checked").display()
            );
        }
    }

    if interface
        .as_deref()
        .is_some_and(|path| path.ends_with(".sock") || path.ends_with(".socket"))
        && ssl
    {
        bail!("SSL is not supported with a UNIX domain socket");
    }

    let prefs_json = serde_json::to_string(&serde_json::Value::Object(prefs))?;
    let resolved = resolve_credential(
        credential,
        credential_file.as_deref(),
        env_credential.as_deref(),
        random_credential,
    )?;

    Ok(Action::Run(Box::new(Config {
        port,
        interface,
        socket_owner,
        credential: resolved.credential,
        username: resolved.username,
        login_announcement: resolved.announcement,
        auth_header,
        uid,
        gid,
        signal,
        signal_name: signal_name(signal),
        cwd,
        endpoints: Endpoints::from_base_path(base_path.as_deref()),
        ping_interval,
        serv_buf_size: if serv_buf_size == 0 {
            4096
        } else {
            serv_buf_size
        },
        session_timeout,
        session_buffer_size: if session_buffer_size == 0 {
            crate::pty::DEFAULT_OUTPUT_BUFFER_LIMIT
        } else {
            session_buffer_size
        },
        history_limit,
        ipv6,
        ssl,
        ssl_cert,
        ssl_key,
        ssl_ca,
        url_arg,
        writable,
        check_origin,
        max_clients,
        once,
        exit_no_conn,
        browser,
        debug_level,
        terminal_type,
        index,
        prefs_json,
        command,
        command_string,
    })))
}

fn set_port(port: &mut u16, value: &str) -> Result<()> {
    let number = parse_int("port", value)?;
    if !(0..=65535).contains(&number) {
        bail!("invalid port: {value}");
    }
    *port = number as u16;
    Ok(())
}

fn set_signal(signal: &mut i32, value: &str) -> Result<()> {
    *signal = signal_number(value).ok_or_else(|| anyhow!("invalid signal: {value}"))?;
    Ok(())
}

fn encode_credential(value: &str) -> Result<String> {
    if !value.contains(':') {
        bail!("invalid credential, format: username:password");
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(value.as_bytes()))
}

const CREDENTIAL_FILE_LIMIT: usize = 4096;
const CREDENTIAL_ENV: &str = "TTYD_CREDENTIAL";

struct ResolvedCredential {
    credential: Option<String>,
    username: Option<String>,
    announcement: Option<String>,
}

fn take_env_credential() -> Result<Option<String>> {
    match std::env::var(CREDENTIAL_ENV) {
        Ok(value) => {
            std::env::remove_var(CREDENTIAL_ENV);
            if value.is_empty() {
                bail!("TTYD_CREDENTIAL is empty");
            }
            Ok(Some(value))
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            std::env::remove_var(CREDENTIAL_ENV);
            bail!("TTYD_CREDENTIAL is not valid Unicode");
        }
    }
}

fn resolve_credential(
    encoded_flag: Option<String>,
    file: Option<&Path>,
    env_value: Option<&str>,
    random: bool,
) -> Result<ResolvedCredential> {
    let sources = encoded_flag.is_some() as u8
        + file.is_some() as u8
        + env_value.is_some() as u8
        + u8::from(random);
    if sources > 1 {
        bail!(
            "--credential, --credential-file, TTYD_CREDENTIAL, and --random-credential are mutually exclusive"
        );
    }

    if let Some(encoded) = encoded_flag {
        let username = username_from_encoded(&encoded)?;
        return Ok(ResolvedCredential {
            credential: Some(encoded),
            username: Some(username),
            announcement: None,
        });
    }
    if let Some(path) = file {
        return finish_raw_credential(read_credential_file(path)?, None);
    }
    if let Some(raw) = env_value {
        return finish_raw_credential(raw.to_owned(), None);
    }
    if random {
        let raw = generate_random_credential()?;
        return finish_raw_credential(raw.clone(), Some(raw));
    }
    Ok(ResolvedCredential {
        credential: None,
        username: None,
        announcement: None,
    })
}

fn finish_raw_credential(raw: String, announcement: Option<String>) -> Result<ResolvedCredential> {
    let username = username_from_raw(&raw)?;
    Ok(ResolvedCredential {
        credential: Some(encode_credential(&raw)?),
        username: Some(username),
        announcement,
    })
}

fn read_credential_file(path: &Path) -> Result<String> {
    warn_if_credential_file_is_exposed(path);
    let file = std::fs::File::open(path)
        .with_context(|| format!("failed to open credential file {}", path.display()))?;
    let mut buffer = Vec::new();
    file.take(CREDENTIAL_FILE_LIMIT as u64 + 1)
        .read_to_end(&mut buffer)
        .with_context(|| format!("failed to read credential file {}", path.display()))?;
    if buffer.len() > CREDENTIAL_FILE_LIMIT {
        bail!(
            "credential file is larger than {CREDENTIAL_FILE_LIMIT} bytes: {}",
            path.display()
        );
    }
    let mut text = String::from_utf8(buffer)
        .with_context(|| format!("credential file is not valid UTF-8: {}", path.display()))?;
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    if text.is_empty() {
        bail!("credential file is empty: {}", path.display());
    }
    Ok(text)
}

fn warn_if_credential_file_is_exposed(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(metadata) = std::fs::metadata(path) else {
            return;
        };
        if metadata.permissions().mode() & 0o077 != 0 {
            eprintln!(
                "ttyd: warning: credential file is readable by group or others: {}",
                path.display()
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn username_from_raw(raw: &str) -> Result<String> {
    let (username, _) = raw
        .split_once(':')
        .ok_or_else(|| anyhow!("invalid credential, format: username:password"))?;
    if username.is_empty() {
        bail!("invalid credential, format: username:password");
    }
    Ok(username.to_owned())
}

fn username_from_encoded(encoded: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("invalid credential, format: username:password")?;
    let raw = String::from_utf8(bytes).context("invalid credential, format: username:password")?;
    username_from_raw(&raw)
}

pub(crate) fn generate_random_credential() -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};

    let mut bytes = [0u8; 18];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow!("failed to generate a login password"))?;
    let password = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    Ok(format!("ttyd:{password}"))
}

fn parse_int(name: &str, value: &str) -> Result<i32> {
    let trimmed = value.trim();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };

    let (radix, digits) = if let Some(rest) = digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))
    {
        (16, rest)
    } else if let Some(rest) = digits
        .strip_prefix("0o")
        .or_else(|| digits.strip_prefix("0O"))
    {
        (8, rest)
    } else if digits.len() > 1 && digits.starts_with('0') {
        (8, &digits[1..])
    } else {
        (10, digits)
    };

    let number = i64::from_str_radix(digits, radix)
        .with_context(|| format!("invalid value for {name}: {value}"))?;
    let number = if negative { -number } else { number };
    i32::try_from(number).with_context(|| format!("invalid value for {name}: {value}"))
}

fn parse_unsigned(name: &str, value: &str) -> Result<usize> {
    let number = parse_int(name, value)?;
    if number < 0 {
        bail!("invalid value for {name}: {value}");
    }
    Ok(number as usize)
}

fn parse_u32(name: &str, value: &str) -> Result<u32> {
    let number = parse_int(name, value)?;
    if number < 0 {
        bail!("invalid value for {name}: {value}");
    }
    Ok(number as u32)
}

fn parse_index(value: &str) -> Result<PathBuf> {
    let path = if let Some(rest) = value.strip_prefix("~/") {
        home_dir()
            .ok_or_else(|| anyhow!("cannot expand ~ because HOME is not set"))?
            .join(rest)
    } else {
        PathBuf::from(value)
    };

    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("Can not stat index.html: {}", path.display()))?;
    if metadata.is_dir() {
        bail!("Invalid index.html path: {}, is it a dir?", path.display());
    }
    Ok(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn truncate(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn add_client_option(
    prefs: &mut serde_json::Map<String, serde_json::Value>,
    value: &str,
) -> Result<()> {
    let (key, value) = value
        .split_once('=')
        .ok_or_else(|| anyhow!("invalid client option: {value}, format: key=value"))?;
    let value =
        serde_json::from_str(value).unwrap_or_else(|_| serde_json::Value::String(value.to_owned()));
    prefs.insert(key.to_owned(), value);
    Ok(())
}

pub fn print_help() {
    eprintln!(
        "ttyd is a tool for sharing terminal over the web\n\
\n\
USAGE:\n\
    ttyd [options] <command> [<arguments...>]\n\
\n\
VERSION:\n\
    {VERSION}\n\
\n\
OPTIONS:\n\
    -p, --port              Port to listen (default: 7681, use `0` for random port)\n\
    -i, --interface         Network interface to bind (eg: eth0), or UNIX domain socket path (eg: /var/run/ttyd.sock)\n\
    -U, --socket-owner      User owner of the UNIX domain socket file, when enabled (eg: user:group)\n\
    -c, --credential        Credential for web login and Basic authentication (format: username:password)\n\
        --credential-file   Read username:password from a file. TTYD_CREDENTIAL uses the same format and is removed from the environment\n\
        --random-credential Generate a ttyd:<password> login and print it to stderr. Mutually exclusive with --credential, --credential-file, and TTYD_CREDENTIAL\n\
    -H, --auth-header       HTTP Header name for auth proxy, this will configure ttyd to let a HTTP reverse proxy handle authentication\n\
    -u, --uid               User id to run with\n\
    -g, --gid               Group id to run with\n\
    -s, --signal            Signal to send to the command when exit it (default: 1, SIGHUP). On Windows the child is terminated instead\n\
    -w, --cwd               Working directory to be set for the child program\n\
    -a, --url-arg           Allow client to send command line arguments in URL (eg: http://localhost:7681?arg=foo&arg=bar)\n\
    -W, --writable          Allow clients to write to the TTY (readonly by default)\n\
    -t, --client-option     Send option to client (format: key=value), repeat to add more options\n\
    -T, --terminal-type     Terminal type to report, default: xterm-256color\n\
    -O, --check-origin      Do not allow websocket connection from different origin\n\
    -m, --max-clients       Maximum clients to support (default: 0, no limit)\n\
    -o, --once              Accept only one client and exit on disconnection\n\
    -q, --exit-no-conn      Exit on all clients disconnection\n\
    -B, --browser           Open terminal with the default system browser\n\
    -I, --index             Custom index.html path\n\
    -b, --base-path         Expected base path for requests coming from a reverse proxy (eg: /mounted/here, max length: 128)\n\
    -P, --ping-interval     Websocket ping interval(sec) (default: 5)\n\
    -f, --srv-buf-size      Maximum bytes read from the PTY at once, a larger value may improve throughput (default: 4096)\n\
        --session-timeout      Seconds to keep a detached session alive (default: 30, 0 disables persistence)\n\
        --session-buffer-size  Bytes of output retained for session replay (default: 4194304)\n\
        --history-limit        Ended sessions to keep for read-only replay (default: 20, 0 disables history)\n\
    -6, --ipv6              Enable IPv6 support\n\
    -S, --ssl               Enable SSL\n\
    -C, --ssl-cert          SSL certificate file path\n\
    -K, --ssl-key           SSL key file path\n\
    -A, --ssl-ca            SSL CA file path for client certificate verification\n\
    -d, --debug             Set log level (default: 7)\n\
    -v, --version           Print the version and exit\n\
    -h, --help              Print this text and exit\n\
\n\
Visit https://github.com/tsl0922/ttyd to get more information and report bugs."
    );
}

pub fn print_version() {
    println!("ttyd version {VERSION}");
}

pub fn check_cwd(cwd: &Option<PathBuf>) -> Result<()> {
    if let Some(cwd) = cwd {
        if !cwd.is_dir() {
            bail!("working directory does not exist: {}", cwd.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn parses_c_style_integers() {
        assert_eq!(parse_int("value", "42").unwrap(), 42);
        assert_eq!(parse_int("value", "+42").unwrap(), 42);
        assert_eq!(parse_int("value", "-42").unwrap(), -42);
        assert_eq!(parse_int("value", "0x1f").unwrap(), 31);
        assert_eq!(parse_int("value", "0X1F").unwrap(), 31);
        assert_eq!(parse_int("value", "0o17").unwrap(), 15);
        assert_eq!(parse_int("value", "017").unwrap(), 15);
        assert_eq!(parse_int("value", "0").unwrap(), 0);
        assert!(parse_int("value", "08").is_err());
        assert!(parse_int("value", "abc").is_err());
        assert!(parse_unsigned("value", "-1").is_err());
    }

    #[test]
    fn validates_ports() {
        let mut port = 0;
        set_port(&mut port, "7681").unwrap();
        assert_eq!(port, 7681);
        assert!(set_port(&mut port, "65536").is_err());
        assert!(set_port(&mut port, "-1").is_err());
    }

    #[test]
    fn encodes_basic_credentials() {
        assert_eq!(encode_credential("user:pass").unwrap(), "dXNlcjpwYXNz");
        assert!(encode_credential("user").is_err());
    }

    #[test]
    fn truncates_terminal_type_on_utf8_boundary() {
        assert_eq!(truncate("xterm-256color", 29), "xterm-256color");
        assert_eq!(truncate("你好世界", 4), "你");
        assert_eq!(truncate("abc", 0), "");
    }

    #[test]
    fn parses_client_options_as_json_values() {
        let mut prefs = serde_json::Map::new();
        add_client_option(&mut prefs, "fontSize=16").unwrap();
        add_client_option(&mut prefs, "theme=light").unwrap();
        add_client_option(&mut prefs, "cursorBlink=true").unwrap();
        add_client_option(&mut prefs, "renderer={\"type\":\"canvas\"}").unwrap();
        assert_eq!(prefs["fontSize"], serde_json::json!(16));
        assert_eq!(prefs["theme"], serde_json::json!("light"));
        assert_eq!(prefs["cursorBlink"], serde_json::json!(true));
        assert_eq!(prefs["renderer"], serde_json::json!({"type": "canvas"}));
        assert!(add_client_option(&mut prefs, "missing-equals").is_err());
    }

    #[test]
    fn parses_transfer_client_options() {
        let action = parse_args_from(
            [
                "-W",
                "-t",
                "enableZmodem=true",
                "-t",
                "enableTrzsz=true",
                "-t",
                "enableSixel=true",
                "-t",
                "trzszDragInitTimeout=1500",
                "bash",
            ],
            None,
        )
        .unwrap();
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert!(config.writable);
        let prefs: serde_json::Value = serde_json::from_str(&config.prefs_json).unwrap();
        assert_eq!(prefs["enableZmodem"], true);
        assert_eq!(prefs["enableTrzsz"], true);
        assert_eq!(prefs["enableSixel"], true);
        assert_eq!(prefs["trzszDragInitTimeout"], 1500);
    }

    #[test]
    fn parses_history_limit() {
        let action = parse_args_from(["true"], None).unwrap();
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert_eq!(config.history_limit, 20);

        let action = parse_args_from(["--history-limit", "0", "true"], None).unwrap();
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert_eq!(config.history_limit, 0);

        let action = parse_args_from(["--history-limit=7", "true"], None).unwrap();
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert_eq!(config.history_limit, 7);

        assert!(parse_args_from(["--history-limit", "-1", "true"], None).is_err());
    }

    #[test]
    fn maps_signal_names() {
        assert_eq!(signal_number("SIGHUP"), Some(1));
        assert_eq!(signal_number("HUP"), Some(1));
        assert_eq!(signal_number("15"), Some(15));
        assert_eq!(signal_number("SIGTERM"), Some(15));
        assert_eq!(signal_name(15), "SIGTERM");
        assert!(signal_number("not-a-signal").is_none());
    }

    #[test]
    fn credential_flag_sets_the_username() {
        let action = parse_args_from(["-c", "user:pass", "true"], None).unwrap();
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert_eq!(config.username.as_deref(), Some("user"));
        assert_eq!(
            config.credential.as_deref(),
            Some(encode_credential("user:pass").unwrap().as_str())
        );
        assert!(config.login_announcement.is_none());
    }

    #[test]
    fn rejects_multiple_credential_sources() {
        let Err(error) = parse_args_from(["-c", "user:pass", "--random-credential", "true"], None)
        else {
            panic!("expected mutually exclusive credentials to fail");
        };
        let error = error.to_string();
        assert!(error.contains("mutually exclusive"), "{error}");

        let path = credential_temp_path("overlap");
        std::fs::write(&path, "alice:secret\n").unwrap();
        let Err(error) = parse_args_from(
            [
                OsString::from("--credential-file"),
                path.as_os_str().to_os_string(),
                OsString::from("--random-credential"),
                OsString::from("true"),
            ],
            Some("bob:secret".to_owned()),
        ) else {
            panic!("expected mutually exclusive credentials to fail");
        };
        let error = error.to_string();
        let _ = std::fs::remove_file(&path);
        assert!(error.contains("mutually exclusive"), "{error}");
    }

    #[test]
    fn reads_a_credential_file_and_strips_one_newline() {
        let path = credential_temp_path("file");
        std::fs::write(&path, "alice:secret\r\n").unwrap();
        let action = parse_args_from(
            [
                OsString::from("--credential-file"),
                path.as_os_str().to_os_string(),
                OsString::from("true"),
            ],
            None,
        )
        .unwrap();
        let _ = std::fs::remove_file(&path);
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert_eq!(config.username.as_deref(), Some("alice"));
        assert_eq!(
            config.credential.as_deref(),
            Some(encode_credential("alice:secret").unwrap().as_str())
        );
        assert!(config.login_announcement.is_none());
    }

    #[test]
    fn rejects_an_empty_or_oversized_credential_file() {
        let empty = credential_temp_path("empty");
        std::fs::write(&empty, "\n").unwrap();
        let Err(error) = parse_args_from(
            [
                OsString::from("--credential-file"),
                empty.as_os_str().to_os_string(),
                OsString::from("true"),
            ],
            None,
        ) else {
            panic!("expected an empty credential file to fail");
        };
        let error = error.to_string();
        let _ = std::fs::remove_file(&empty);
        assert!(error.contains("empty"), "{error}");

        let large = credential_temp_path("large");
        std::fs::write(&large, vec![b'a'; CREDENTIAL_FILE_LIMIT + 1]).unwrap();
        let Err(error) = parse_args_from(
            [
                OsString::from("--credential-file"),
                large.as_os_str().to_os_string(),
                OsString::from("true"),
            ],
            None,
        ) else {
            panic!("expected an oversized credential file to fail");
        };
        let error = error.to_string();
        let _ = std::fs::remove_file(&large);
        assert!(error.contains("larger than"), "{error}");
    }

    #[test]
    fn resolves_an_environment_credential() {
        let resolved = resolve_credential(None, None, Some("bob:from-env"), false).unwrap();
        assert_eq!(resolved.username.as_deref(), Some("bob"));
        assert_eq!(
            resolved.credential.as_deref(),
            Some(encode_credential("bob:from-env").unwrap().as_str())
        );
        assert!(resolved.announcement.is_none());
    }

    #[test]
    fn take_env_credential_removes_the_variable() {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var(CREDENTIAL_ENV, "user:from-env");
        let value = take_env_credential().unwrap();
        assert!(std::env::var_os(CREDENTIAL_ENV).is_none());
        assert_eq!(value.as_deref(), Some("user:from-env"));

        std::env::set_var(CREDENTIAL_ENV, "");
        let error = take_env_credential().unwrap_err().to_string();
        assert!(std::env::var_os(CREDENTIAL_ENV).is_none());
        assert!(error.contains("empty"), "{error}");
    }

    #[test]
    fn random_credential_uses_a_fixed_username_and_is_announced() {
        let action = parse_args_from(["--random-credential", "true"], None).unwrap();
        let Action::Run(config) = action else {
            panic!("expected a running configuration");
        };
        assert_eq!(config.username.as_deref(), Some("ttyd"));
        let announcement = config.login_announcement.expect("announcement");
        let password = announcement.strip_prefix("ttyd:").expect("ttyd username");
        assert_eq!(password.len(), 24);
        assert!(password
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        assert_eq!(
            config.credential.as_deref(),
            Some(encode_credential(&announcement).unwrap().as_str())
        );
    }

    fn credential_temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ttyd-credential-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }
}
