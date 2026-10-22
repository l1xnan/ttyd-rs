![backend](https://github.com/tsl0922/ttyd/workflows/backend/badge.svg)
![frontend](https://github.com/tsl0922/ttyd/workflows/frontend/badge.svg)
[![GitHub Releases](https://img.shields.io/github/downloads/tsl0922/ttyd/total)](https://github.com/tsl0922/ttyd/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/tsl0922/ttyd)](https://hub.docker.com/r/tsl0922/ttyd)
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
- Basic authentication and reverse-proxy header authentication
- IPv4, IPv6, TCP and UNIX domain sockets
- Cross platform: Linux, macOS, and Windows (ConPTY). On Windows, `-s` does not deliver a POSIX signal and there is no process group; the child is terminated instead

# Installation

## Install on macOS

- Install with [Homebrew](http://brew.sh): `brew install ttyd`
- Install with [MacPorts](https://www.macports.org): `sudo port install ttyd`

## Install on Linux

- Install on Debian/Ubuntu: `sudo apt install ttyd`
- Install the snap: `sudo snap install ttyd --classic`
- Install on OpenWrt: `opkg install ttyd`
- Install on Gentoo: clone the [repo](https://bitbucket.org/mgpagano/ttyd/src/master) and follow the directions [here](https://wiki.gentoo.org/wiki/Custom_repository#Creating_a_local_repository).
- Install with [Homebrew](https://docs.brew.sh/Homebrew-on-Linux) : `brew install ttyd`
- Precompiled static binaries: download from the [releases](https://github.com/tsl0922/ttyd/releases) page

## Install on Windows

- Binary version (recommended): download from the [releases](https://github.com/tsl0922/ttyd/releases) page
- Install with [WinGet](https://github.com/microsoft/winget-cli): `winget install tsl0922.ttyd`
- Install with [Scoop](https://scoop.sh/#/apps?q=ttyd&s=2&d=1&o=true): `scoop install ttyd`
- Build from source using the instructions below

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
    -c, --credential        Credential for basic authentication (format: username:password)
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

## Browser Support

Modern browsers, See [Browser Support](https://github.com/xtermjs/xterm.js#browser-support).

## Alternatives

* [Wetty](https://github.com/krishnasrinivas/wetty): [Node](https://nodejs.org) based web terminal (SSH/login)
* [GoTTY](https://github.com/yudai/gotty): [Go](https://golang.org) based web terminal
