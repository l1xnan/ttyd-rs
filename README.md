[![backend](https://github.com/l1xnan/ttyd-rs/actions/workflows/backend.yml/badge.svg)](https://github.com/l1xnan/ttyd-rs/actions/workflows/backend.yml)
[![frontend](https://github.com/l1xnan/ttyd-rs/actions/workflows/frontend.yml/badge.svg)](https://github.com/l1xnan/ttyd-rs/actions/workflows/frontend.yml)
[![GitHub Releases](https://img.shields.io/github/downloads/l1xnan/ttyd-rs/total)](https://github.com/l1xnan/ttyd-rs/releases)
[![License](https://img.shields.io/github/license/l1xnan/ttyd-rs)](https://github.com/l1xnan/ttyd-rs/blob/main/LICENSE)

English | [简体中文](README.zh.md)

# ttyd - Share your terminal over the web

ttyd is a simple command-line tool for sharing terminal over the web.

![screenshot](screenshot.gif)

# Features

- Rust backend built on [Tokio](https://tokio.rs) and [Axum](https://github.com/tokio-rs/axum), with a single-file [xterm.js](https://xtermjs.org) frontend
- Fully-featured terminal with [CJK](https://en.wikipedia.org/wiki/CJK_characters) and IME support
- [ZMODEM](https://en.wikipedia.org/wiki/ZMODEM) ([lrzsz](https://ohse.de/uwe/software/lrzsz.html)) / [trzsz](https://trzsz.github.io) file transfer support, see [File transfer and Sixel](#file-transfer-and-sixel)
- [Sixel](https://en.wikipedia.org/wiki/Sixel) image output support ([img2sixel](https://saitoha.github.io/libsixel) / [lsix](https://github.com/hackerb9/lsix)), see [File transfer and Sixel](#file-transfer-and-sixel)
- TLS and mutual TLS support based on [rustls](https://github.com/rustls/rustls)
- Run any custom command with options
- Web login with optional 30-day "remember me", Basic authentication, and reverse-proxy header authentication
- Resumable sessions: reloading a tab reattaches to the same PTY with recent output replayed
- Session history: ended sessions are kept in memory for read-only replay, see [Session persistence](#session-persistence)
- IPv4, IPv6, TCP and UNIX domain sockets
- Cross platform: Linux, macOS, and Windows (ConPTY). On Windows, `-s` does not deliver a POSIX signal and there is no process group; the child is terminated instead

# Installation

Prebuilt binaries are distributed only through this project's
[GitHub Releases](https://github.com/l1xnan/ttyd-rs/releases) page. Each release
asset is a single executable, not an archive.

| Asset | Platform | Architecture | When to use |
| --- | --- | --- | --- |
| `ttyd.x86_64` | Linux | x86_64 | Most 64-bit PCs, servers, and VMs, including x86_64 WSL |
| `ttyd.aarch64` | Linux | ARM64 | 64-bit ARM systems, such as Raspberry Pi 3/4/5 with a 64-bit OS |
| `ttyd.armhf` | Linux | ARMv7 hard-float | 32-bit ARM systems, such as Raspberry Pi 2/3/4 with a 32-bit OS |
| `ttyd.i686` | Linux | 32-bit x86 | Older 32-bit x86 systems; use `ttyd.x86_64` on 64-bit x86 |
| `ttyd.macos-x86_64` | macOS | Intel x86_64 | Intel-based Macs |
| `ttyd.macos-arm64` | macOS | Apple Silicon | Apple Silicon (M-series) Macs |
| `ttyd.win32.exe` | Windows | x86_64 | 64-bit Windows 10/11 |

The Linux binaries are statically linked against musl, so they do not depend on
the host's glibc version. `ttyd.armhf` requires an ARMv7 CPU with hardware
floating-point support and does not run on ARMv6 devices such as Raspberry Pi 1
or Zero.

Download the file for your platform and put it on your `PATH` as `ttyd`
(`ttyd.exe` on Windows). For example, on Linux or macOS:

```sh
chmod +x ttyd.x86_64
sudo mv ttyd.x86_64 /usr/local/bin/ttyd
```

Replace the filename in the example with the asset you downloaded. On Windows,
rename `ttyd.win32.exe` to `ttyd.exe` and move it to a directory on your `PATH`.

If macOS blocks the unsigned binary, allow it in **System Settings > Privacy &
Security**, or remove the quarantine attribute:

```sh
xattr -d com.apple.quarantine ttyd
```

`SHA256SUMS` is provided on the release page for verifying downloaded files. No
package-manager packages are currently provided for this project.

On Windows, ttyd starts the command in a ConPTY. `-s` / `--signal` does not deliver that signal, and there is no process group; when the session ends, the child is terminated.

## Build from source

The frontend is embedded into the Rust binary at compile time, so build it first.

Prerequisites:

- Rust 1.88 or newer (`rustup` recommended)
- Node.js 22.12 or newer
- pnpm 12 (`corepack enable` is sufficient)
- A C compiler for the TLS dependency (`build-essential` on Debian/Ubuntu, Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows)

```sh
pnpm --dir html install --frozen-lockfile
pnpm --dir html run check
pnpm --dir html run build
cargo build --release --manifest-path rust/Cargo.toml
```

The binary is written to `rust/target/release/ttyd` (or `ttyd.exe` on Windows).

For development, run `cargo run --manifest-path rust/Cargo.toml -- -W bash` after building the frontend once. When changing frontend sources, use the Vite development workflow described in [html/README.md](html/README.md).

# Usage

## Command-line Options

```
USAGE:
    ttyd [options] <command> [<arguments...>]

OPTIONS:
    -p, --port              Port to listen (default: 7681, use `0` for random port)
    -i, --interface         Network interface to bind (eg: eth0), or UNIX domain socket path (eg: /var/run/ttyd.sock)
    -U, --socket-owner      User owner of the UNIX domain socket file, when enabled (eg: user:group)
    -c, --credential        Credential for web login and Basic authentication (format: username:password)
        --credential-file   Read username:password from a file. TTYD_CREDENTIAL uses the same format and is removed from the environment
        --random-credential Generate a ttyd:<password> login and print it to stderr. Mutually exclusive with --credential, --credential-file, and TTYD_CREDENTIAL
    -H, --auth-header       HTTP Header name for auth proxy, this will configure ttyd to let a HTTP reverse proxy handle authentication
    -u, --uid               User id to run with
    -g, --gid               Group id to run with
    -s, --signal            Signal to send to the command when exit it (default: 1, SIGHUP). On Windows the child is terminated instead
    -w, --cwd               Working directory to be set for the child program
    -a, --url-arg           Allow client to send command line arguments in URL (eg: http://localhost:7681?arg=foo&arg=bar)
    -W, --writable          Allow clients to write to the TTY (readonly by default)
    -t, --client-option     Send option to client (format: key=value), repeat to add more options
    -T, --terminal-type     Terminal type to report, default: xterm-256color
    -O, --check-origin      Do not allow websocket connection from different origin
    -m, --max-clients       Maximum clients to support (default: 0, no limit)
    -o, --once              Accept only one client and exit on disconnection
    -q, --exit-no-conn      Exit on all clients disconnection
    -B, --browser           Open terminal with the default system browser
    -I, --index             Custom index.html path
    -b, --base-path         Expected base path for requests coming from a reverse proxy (eg: /mounted/here, max length: 128)
    -P, --ping-interval     Websocket ping interval(sec) (default: 5)
    -f, --srv-buf-size      Maximum bytes read from the PTY at once, a larger value may improve throughput (default: 4096)
        --session-timeout      Seconds to keep a detached session alive (default: 30, 0 disables persistence)
        --session-buffer-size  Bytes of output retained for session replay (default: 4194304)
        --history-limit        Ended sessions to keep for read-only replay (default: 20, 0 disables history)
    -6, --ipv6              Enable IPv6 support
    -S, --ssl               Enable SSL
    -C, --ssl-cert          SSL certificate file path
    -K, --ssl-key           SSL key file path
    -A, --ssl-ca            SSL CA file path for client certificate verification
    -d, --debug             Set log level (default: 7)
    -v, --version           Print the version and exit
    -h, --help              Print this text and exit
```

Read the example usage on the [upstream ttyd wiki](https://github.com/tsl0922/ttyd/wiki/Example-Usage).

## Authentication

Use `-c username:password` to enable the built-in web login page. The same
credential also continues to work with HTTP Basic authentication:

```sh
ttyd -c user:pass bash
```

`--credential`, `--credential-file`, and the `TTYD_CREDENTIAL` environment
variable are mutually exclusive, and each one is also mutually exclusive with
`--random-credential`. `--credential-file` reads `username:password` from a
file and removes a single trailing newline. On Unix, ttyd warns when that file
is readable by the group or by others. `TTYD_CREDENTIAL` uses the same format
and is removed from the environment before the command starts.
`--random-credential` signs in as `ttyd` with a generated password and prints
`ttyd login: ttyd:<password>` to stderr once. A random password changes on
every start, so remembered logins from the previous process stop working.

- The built-in login page is shown when authentication is required. "Keep me
  signed in" is checked by default and keeps the login for 30 days in the
  current browser. When unchecked, the login uses a session cookie and expires
  after 12 hours or when the browser closes.
- Remembered logins use an HMAC-signed, `HttpOnly` cookie. They survive a ttyd
  restart as long as the `-c` credential is unchanged; changing the credential
  invalidates existing remembered logins. Logout clears the cookie in the
  current browser; because sessions are stateless, a copied cookie remains
  valid until it expires.
- `-H name` delegates authentication to a reverse proxy and disables the local
  login page. A custom page passed with `-I` keeps its existing behavior and is
  served only after authentication.
- Browser requests to `/token` and `/ws` use the login cookie automatically.
  API clients can still use `curl -u user:pass`.
- With `-b /mounted/here`, the login, logout, token, and WebSocket routes and
  the cookie `Path` are scoped under `/mounted/here`. When TLS terminates at a
  reverse proxy, send `X-Forwarded-Proto: https` so the cookie is marked
  `Secure`.

## Session persistence

By default a detached PTY is kept for 30 seconds. Reloading the page reattaches
to the same shell, editor, or running command, and up to 4 MiB of recent output
is replayed into the terminal. The session id is stored in `sessionStorage`, so
each tab has its own session and opening a new tab starts a fresh command.

- `--session-timeout <seconds>` changes how long a detached session is kept.
  `0` disables persistence and terminates the command immediately after the last
  client disconnects.
- `--session-buffer-size <bytes>` changes the in-memory replay buffer size.
- Add `?sessionTimeout=N` to the page URL to override the timeout for that tab
  (maximum 3600 seconds). The override cannot re-enable persistence when the
  server was started with `--session-timeout 0`.
- `-q` / `--exit-no-conn` and `-o` / `--once` keep their existing semantics and
  may exit before a refreshed page can reconnect.

Ended sessions are also kept for read-only replay. When a session exits,
expires, or is deleted, ttyd copies its id, owner, command, exit code, end time,
and current replay buffer into an in-memory history table before reclaiming the
PTY. The PTY itself is not retained, so a history entry can only be replayed
read-only and cannot be reattached as the original shell. The oldest record is
dropped when the limit is exceeded, and history disappears when the process
restarts. Stored output is the same replay buffer, still bounded by
`--session-buffer-size`.

- `--history-limit <count>` sets how many ended sessions are kept (default: 20).
  `0` disables history.
- A history replay opens `/ws` with the normal handshake JSON plus
  `"attachOnly": true`. If the id exists, the server replays the stored output
  frames and then sends frame `4` with `{"readonly":true,"exitCode":N}`;
  afterwards it discards input and creates no PTY. If the id is not in history,
  the connection closes without starting a shell. A normal reconnect does not
  send `attachOnly`, and an expired or archived id keeps today's behavior of
  starting a new session.
- The session panel lists Running (running sessions not opened on this page;
  click to attach) and History (ended sessions; read-only replay, delete
  record). It only appears when `GET /sessions` is available, that is when
  authentication is configured. The page's own tab title prefers the locally
  remembered shell title; server list entries use the launch command.

Session API routes are served under the base path set by `-b`:

- `GET /sessions` returns only the current user's running sessions and history.
  It requires authentication (`-c`, `--credential-file`, `TTYD_CREDENTIAL`,
  `--random-credential`, or `-H`). When no authentication is configured it
  returns `404` so session ids are not exposed. With `-c` the credential is
  shared, so every holder sees the same list.
- `GET /sessions/{id}` returns metadata only, without the replay body. Without
  authentication, knowing the id is enough, like connecting to `/ws` by id.
  With authentication the session must belong to the current user, otherwise
  `403`.
- `DELETE /sessions/{id}` kills and archives a running session, or deletes a
  history record. With authentication it must belong to the current user,
  otherwise `403`. It returns `204` on success and `404` when the id is missing.
- Timestamps are Unix epoch milliseconds (`endedAt`). Killed or expired
  sessions record exit code `-1`.

## File transfer and Sixel

ZMODEM, trzsz, and Sixel are off until a `-t` client option turns them on.
File transfer, and the probe reply that `img2sixel` / `lsix` use to decide
whether the terminal supports Sixel, both have to be written back to the PTY,
so the examples below include `-W`. A read-only session can still display
Sixel that is already in the output, but those tools treat a missing probe
reply as "no Sixel support".

Install each program in the environment of the command ttyd starts. After it
is installed, try the commands below by hand. Continuous integration does not
install `lrzsz`, `trzsz`, or `img2sixel`.

### ZMODEM

Install [lrzsz](https://ohse.de/uwe/software/lrzsz.html) (`sz` and `rz`) in that
environment:

```sh
ttyd -W -t enableZmodem=true bash
```

- Run `sz file` in the web terminal to download that file in the browser.
- Run `rz`, then choose the files to upload. Press Ctrl+C while ttyd is waiting
  for a choice, or use Cancel in the dialog; either one restores terminal input.
- More than one file can be selected at a time.

### trzsz

Install [trzsz](https://trzsz.github.io) (`trz` and `tsz`) in that environment:

```sh
ttyd -W -t enableTrzsz=true bash
```

- `trz` uploads from the browser, and `tsz file` downloads a file to the browser.
- Dropping files onto the terminal also uploads them. ttyd then starts `trz` in
  the terminal and waits `-t trzszDragInitTimeout` milliseconds for the server
  to respond. The default is 3000.
- ZMODEM can be enabled at the same time with
  `-t enableZmodem=true -t enableTrzsz=true`. ZMODEM still works when no trzsz
  transfer is in progress.

### Sixel

```sh
ttyd -W -t enableSixel=true bash
```

With [libsixel](https://saitoha.github.io/libsixel) installed, `img2sixel image.png`
draws an image. [lsix](https://github.com/hackerb9/lsix) lists the images in
the current directory. For a large image, raise the PTY read size, for example
`-f 65536`.

With Sixel enabled, the primary device-attributes reply (`CSI c`) includes
parameter `4`, which is what `img2sixel` and `lsix` look for. The secondary
reply (`CSI > c`) stays the one xterm.js already sends.

ConPTY on Windows does not pass the binary bytes used by ZMODEM, trzsz, and
Sixel through unchanged, so use these features on Linux or macOS. On Windows,
ttyd sends `isWindows=true` to the browser and trzsz treats newlines as a
Windows shell. If the command is actually a POSIX shell, such as Git Bash, add
`-t isWindows=false`.

## Browser Support

Modern browsers, See [Browser Support](https://github.com/xtermjs/xterm.js#browser-support).

## Alternatives

* [Wetty](https://github.com/krishnasrinivas/wetty): [Node](https://nodejs.org) based web terminal (SSH/login)
* [GoTTY](https://github.com/yudai/gotty): [Go](https://golang.org) based web terminal
