![backend](https://github.com/tsl0922/ttyd/workflows/backend/badge.svg)
![frontend](https://github.com/tsl0922/ttyd/workflows/frontend/badge.svg)
[![GitHub Releases](https://img.shields.io/github/downloads/l1xnan/ttyd-rs/total)](https://github.com/l1xnan/ttyd-rs/releases)
[![Packaging status](https://repology.org/badge/tiny-repos/ttyd.svg)](https://repology.org/project/ttyd/versions)
![GitHub](https://img.shields.io/github/license/tsl0922/ttyd)

# ttyd - Share your terminal over the web

ttyd is a simple command-line tool for sharing terminal over the web.

![screenshot](https://github.com/tsl0922/ttyd/raw/main/screenshot.gif)

# Features

- Rust backend built on [Tokio](https://tokio.rs) and [Axum](https://github.com/tokio-rs/axum), with a single-file [xterm.js](https://xtermjs.org) frontend
- Fully-featured terminal with [CJK](https://en.wikipedia.org/wiki/CJK_characters) and IME support
- [ZMODEM](https://en.wikipedia.org/wiki/ZMODEM) ([lrzsz](https://ohse.de/uwe/software/lrzsz.html)) / [trzsz](https://trzsz.github.io) file transfer support
- [Sixel](https://en.wikipedia.org/wiki/Sixel) image output support ([img2sixel](https://saitoha.github.io/libsixel) / [lsix](https://github.com/hackerb9/lsix))
- TLS and mutual TLS support based on [rustls](https://github.com/rustls/rustls)
- Run any custom command with options
- Web login with optional 30-day "remember me", Basic authentication, and reverse-proxy header authentication
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
    -6, --ipv6              Enable IPv6 support
    -S, --ssl               Enable SSL
    -C, --ssl-cert          SSL certificate file path
    -K, --ssl-key           SSL key file path
    -A, --ssl-ca            SSL CA file path for client certificate verification
    -d, --debug             Set log level (default: 7)
    -v, --version           Print the version and exit
    -h, --help              Print this text and exit
```

Read the example usage on the [wiki](https://github.com/tsl0922/ttyd/wiki/Example-Usage).

## Authentication

Use `-c username:password` to enable the built-in web login page. The same
credential also continues to work with HTTP Basic authentication:

```sh
ttyd -c user:pass bash
```

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

## Browser Support

Modern browsers, See [Browser Support](https://github.com/xtermjs/xterm.js#browser-support).

## Alternatives

* [Wetty](https://github.com/krishnasrinivas/wetty): [Node](https://nodejs.org) based web terminal (SSH/login)
* [GoTTY](https://github.com/yudai/gotty): [Go](https://golang.org) based web terminal
