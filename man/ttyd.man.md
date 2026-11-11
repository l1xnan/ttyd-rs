ttyd 1 "September 2016" ttyd "User Manual"
==================================================

# NAME
  ttyd - Share your terminal over the web

# SYNOPSIS
  **ttyd** [options] \<command\> [\<arguments...\>]

# DESCRIPTION
  ttyd is a command-line tool for sharing terminal over the web that runs in *nix and windows systems, with the following features:

  - Rust backend built on [Tokio](https://tokio.rs) and [Axum](https://github.com/tokio-rs/axum)
  - Fully-featured terminal based on Xterm.js with CJK (Chinese, Japanese, Korean) and IME support
  - Graphical ZMODEM integration with lrzsz support
  - Sixel image output support
  - TLS and mutual TLS support based on [rustls](https://github.com/rustls/rustls)
  - Run any custom command with options
  - Web login with optional 30-day "remember me", Basic authentication, and reverse-proxy header authentication
  - Resumable sessions: reloading a tab reattaches to the same PTY with recent output replayed
  - Cross platform: Linux, macOS, and Windows (ConPTY). On Windows, `-s` does not deliver a POSIX signal and there is no process group; the child is terminated instead

# OPTIONS
  -p, --port <port>
      Port to listen (default: 7681, use `0` for random port)

  -i, --interface <interface>
      Network interface to bind (eg: eth0), or UNIX domain socket path (eg: /var/run/ttyd.sock)

  -U, --socket-owner
      User owner of the UNIX domain socket file, when enabled (eg: user:group)

  -c, --credential USER[:PASSWORD]
      Credential for web login and Basic authentication (format: username:password)

  --credential-file <path>
      Read username:password from a file and remove one trailing newline. TTYD_CREDENTIAL uses the same format and is removed from the environment. Mutually exclusive with --credential, TTYD_CREDENTIAL, and --random-credential

  --random-credential
      Generate a ttyd:<password> login and print it to stderr. Mutually exclusive with --credential, --credential-file, and TTYD_CREDENTIAL

  -H, --auth-header <name>
      HTTP Header name for auth proxy, this will configure ttyd to let a HTTP reverse proxy handle authentication

  -u, --uid <uid>
      User id to run with

  -g, --gid <gid>
      Group id to run with

  -s, --signal <signal string>
      Signal to send to the command when exit it (default: 1, SIGHUP). On Windows the signal is not delivered and there is no process group; the child is terminated instead

  -w, --cwd <path>
      Working directory to be set for the child program

  -a, --url-arg
      Allow client to send command line arguments in URL (eg: http://localhost:7681?arg=foo&arg=bar)

  -W, --writable
      Allow clients to write to the TTY (readonly by default)

  -t, --client-option <key=value>
      Send option to client (format: key=value), repeat to add more options, see **CLIENT OPTIONS** for details

  -T, --terminal-type
      Terminal type to report, default: xterm-256color

  -O, --check-origin
      Do not allow websocket connection from different origin

  -m, --max-clients
      Maximum clients to support (default: 0, no limit)

  -o, --once
      Accept only one client and exit on disconnection

  -q, --exit-no-conn
      Exit on all clients disconnection

  -B, --browser
      Open terminal with the default system browser

  -I, --index <index file>
      Custom index.html path
  
  -b, --base-path
      Expected base path for requests coming from a reverse proxy (eg: /mounted/here, max length: 128)

  -P, --ping-interval
      Websocket ping interval(sec) (default: 5)

  -f, --srv-buf-size
      Maximum bytes read from the PTY at once, a larger value may improve throughput (default: 4096)

  --session-timeout <seconds>
      Seconds to keep a detached session alive (default: 30, 0 disables persistence)

  --session-buffer-size <bytes>
      Bytes of output retained for session replay (default: 4194304)

  --history-limit <count>
      Ended sessions to keep for read-only replay (default: 20, 0 disables history)

  --http-transfer
      Enable the HTTP file transfer endpoints. Requires `-W`.

  --http-transfer-dir <dir>
      Upload destination when the shell cwd cannot be followed (Windows, macOS, probe failure, or `--no-http-follow-cwd`). Defaults to `-w` / the process cwd.

  --http-transfer-root <dir>
      Restrict every file operation to this canonicalized directory tree. By default any shell cwd may be followed.

  --http-transfer-max-upload <bytes>
      Maximum size of one uploaded file (default: 67108864).

  --http-transfer-session-quota <bytes>
      Approximate per-directory quota; `0` disables the check (default: 268435456).

  --no-http-follow-cwd
      Always use --http-transfer-dir instead of following the shell cwd.

  -6, --ipv6
      Enable IPv6 support

  -S, --ssl
      Enable SSL

  -C, --ssl-cert <cert path>
      SSL certificate file path

  -K, --ssl-key <key path>
      SSL key file path

  -A, --ssl-ca <ca path>
      SSL CA file path for client certificate verification

  -d, --debug <level>
      Set log level (default: 7)

  -v, --version
      Print the version and exit

  -h, --help
      Print this text and exit

# CLIENT OPTIONS
ttyd has a mechanism to pass server side command-line arguments to the browser page which is called **client options**:

```bash
-t, --client-option     Send option to client (format: key=value), repeat to add more options
```

## Basic usage

- `-t rendererType=webgl`: use the `webgl` renderer for xterm.js (default: `webgl`, falls back to `dom`; `canvas` is deprecated and also uses `dom`)
- `-t disableLeaveAlert=true`: disable the leave page alert
- `-t disableResizeOverlay=true`: disable the terminal resize overlay
- `-t disableReconnect=true`: prevent the terminal from reconnecting on connection error/close
- `-t enableZmodem=true`: enable [ZMODEM](https://en.wikipedia.org/wiki/ZMODEM) / [lrzsz](https://ohse.de/uwe/software/lrzsz.html) file transfer support
- `-t enableTrzsz=true`: enable [trzsz](https://trzsz.github.io) file transfer support
- `-t enableSixel=true`: enable [Sixel](https://en.wikipedia.org/wiki/Sixel) image output support ([Usage](https://saitoha.github.io/libsixel/))
- `-t closeOnDisconnect=true`: close the terminal on disconnection, this will disable reconnect
- `-t titleFixed=hello`: set a fixed title for the browser window
- `-t fontSize=20`: change the font size of the terminal
- `-t unicodeVersion=11`: set xterm unicode support level (default: 11, use 6 to disable unicode addon)
- `-t trzszDragInitTimeout=3000`: set the timeout in milliseconds for initializing drag and drop files to upload. (default: 3000) 

## Advanced usage

You can use the client option to change all the settings of xterm defined in [ITerminalOptions](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/), examples:

- `-t cursorStyle=bar`: set cursor style to `bar`
- `-t lineHeight=1.5`: set line-height to `1.5`
- `-t 'theme={"background": "green"}'`: set background color to `green`

to try the example options above, run:

```bash
ttyd -t cursorStyle=bar -t lineHeight=1.5 -t 'theme={"background": "green"}' bash
```

# AUTHENTICATION
  Use `-c username:password` to enable the built-in web login page. The same credential also continues to work with HTTP Basic authentication:

```bash
ttyd -c user:pass bash
```

  `--credential`, `--credential-file`, and `TTYD_CREDENTIAL` are mutually exclusive with each other and with `--random-credential`. `--credential-file` reads `username:password` and removes one trailing newline. On Unix, ttyd warns when that file is readable by the group or by others. `TTYD_CREDENTIAL` uses the same format and is removed from the environment before the command starts. `--random-credential` signs in as `ttyd` with a generated password and prints `ttyd login: ttyd:<password>` to stderr once. A random password changes on every start, so remembered logins from the previous process stop working.

  The built-in login page is shown when authentication is required. "Keep me signed in" is checked by default and keeps the login for 30 days in the current browser. When unchecked, the login uses a session cookie and expires after 12 hours or when the browser closes.

  Remembered logins use an HMAC-signed, `HttpOnly` cookie. They survive a ttyd restart as long as the `-c` credential is unchanged; changing the credential invalidates existing remembered logins. Logout clears the cookie in the current browser; because sessions are stateless, a copied cookie remains valid until it expires.

  The `-H name` option delegates authentication to a reverse proxy and disables the local login page. A custom page passed with `-I` keeps its existing behavior and is served only after authentication. Browser requests to `/token` and `/ws` use the login cookie automatically; API clients can still use `curl -u user:pass`.

  With `-b /mounted/here`, the login, logout, token, and WebSocket routes and the cookie `Path` are scoped under `/mounted/here`. When TLS terminates at a reverse proxy, send `X-Forwarded-Proto: https` so the cookie is marked `Secure`.

# SESSION PERSISTENCE
  By default a detached PTY is kept for 30 seconds. Reloading the page reattaches to the same shell, editor, or running command, and up to 4 MiB of recent output is replayed into the terminal. The session id is stored in `sessionStorage`, so each tab has its own session and opening a new tab starts a fresh command.

  `--session-timeout <seconds>` changes how long a detached session is kept. `0` disables persistence and terminates the command immediately after the last client disconnects. `--session-buffer-size <bytes>` changes the in-memory replay buffer size.

  Replayed output is sent with frame `5` when the client advertises `"replayFrames": true` in the handshake, and with frame `0` otherwise for compatibility with older clients. The browser renders frame `5` verbatim, so a reconnect never feeds already-consumed bytes into ZMODEM or trzsz detection again.

  Add `?sessionTimeout=N` to the page URL to override the timeout for that tab (maximum 3600 seconds). The override cannot re-enable persistence when the server was started with `--session-timeout 0`. `-q` / `--exit-no-conn` and `-o` / `--once` keep their existing semantics and may exit before a refreshed page can reconnect.

# SESSION HISTORY
  Ended sessions are kept in memory for read-only replay. When a session exits, expires, or is deleted, ttyd copies its id, owner, command, exit code, end time, and current replay buffer into a history table before reclaiming the PTY. The PTY is not retained, so a history entry can only be replayed read-only and cannot be reattached as the original shell. The oldest record is dropped when the limit is exceeded, and history disappears when the process restarts. Stored output is bounded by `--session-buffer-size`.

  `--history-limit <count>` sets how many ended sessions are kept (default: 20). `0` disables history.

  A history replay opens `/ws` with the normal handshake JSON plus `"attachOnly": true`. If the id exists, the server replays the stored output frames and then sends frame `4` with `{"readonly":true,"exitCode":N}`; afterwards it discards input and creates no PTY. If the id is not in history, the connection closes without starting a shell. A normal reconnect does not send `attachOnly`, and an expired or archived id keeps today's behavior of starting a new session.

  The session API is served under the base path set by `-b`:

  - `GET /sessions` returns only the current user's running sessions and history. It requires authentication (`-c`, `--credential-file`, `TTYD_CREDENTIAL`, `--random-credential`, or `-H`); when no authentication is configured it returns `404` so session ids are not exposed. With `-c` the credential is shared, so every holder sees the same list.
  - `GET /sessions/{id}` returns metadata only, without the replay body. Without authentication, knowing the id is enough, like connecting to `/ws` by id. With authentication the session must belong to the current user, otherwise `403`.
  - `DELETE /sessions/{id}` kills and archives a running session, or deletes a history record. With authentication it must belong to the current user, otherwise `403`. It returns `204` on success and `404` when the id is missing.

  Timestamps are Unix epoch milliseconds (`endedAt`). Killed or expired sessions record exit code `-1`. The browser session panel shows Running and History entries and only appears when `GET /sessions` is available, that is when authentication is configured.

  With `--http-transfer -W` two more routes are served under the same base path (`POST /sessions/{id}/files?name=` and `GET /sessions/{id}/download?path=`); see **HTTP file transfer** below.

# FILE TRANSFER AND SIXEL
  ZMODEM, trzsz, and Sixel are off until a `-t` client option turns them on. File transfer and the probe reply used by `img2sixel` / `lsix` both have to be written back to the PTY, so these examples include `-W`. Install each program in the environment of the command ttyd starts, then try the commands by hand. The HTTP file transfer path below is built into ttyd and needs nothing installed remotely.

## HTTP file transfer
  Enable it with `--http-transfer -W`; it is off by default and works over plain HTTP:

```bash
ttyd --http-transfer -W bash
ttyd --http-transfer -W --http-transfer-dir /srv/uploads bash
```

  **Upload**: click the tab bar "Upload" button or drop files onto the terminal. The dialog shows the destination before the native file picker opens. On Linux the destination follows the shell cwd through `/proc/<pid>/cwd`; when that is unavailable (Windows, macOS, ConPTY, probe failure, or `--no-http-follow-cwd`) it uses `--http-transfer-dir <dir>`, then `-w` / the process cwd.

  **Download**: click the tab bar "Download" button, type a server file path (absolute, or relative to the destination) and press Download. Terminal input is never intercepted — `ttyd-*` is not a command.

  Two routes are served under the base path set by `-b`, both requiring `X-TTYD-Transfer: 1` and bound to a live session id and its owner: `POST /sessions/{id}/files?name=<file>` uploads a raw `application/octet-stream` body (`409` on an existing name, `413` over the size limit); `GET /sessions/{id}/download?path=<path>` downloads any file. Symlinks, directories and paths outside `--http-transfer-root` are rejected (`403`). Without `--http-transfer` the routes return `404`; without `-W` they return `403`. Existing names are never overwritten; there is no resume or chunked concurrency. Without a root, any file readable by the ttyd process can be downloaded — use authentication on untrusted networks.

  ZMODEM requires [lrzsz](https://ohse.de/uwe/software/lrzsz.html) (`sz` and `rz`):

```bash
ttyd -W -t enableZmodem=true bash
```

  Run `sz file` to download a file in the browser. Run `rz` and choose files to upload. Ctrl+C, or Cancel in the dialog, restores terminal input.

  [trzsz](https://trzsz.github.io) (`trz` and `tsz`):

```bash
ttyd -W -t enableTrzsz=true bash
```

  `trz` uploads from the browser and `tsz file` downloads a file. Dropping files onto the terminal also uploads them; ttyd starts `trz` and waits `-t trzszDragInitTimeout` milliseconds (default 3000) for the server. ZMODEM and trzsz can both be enabled. ZMODEM still works when no trzsz transfer is in progress.

  The File System Access API used by trzsz only exists on HTTPS or `localhost`. On a plain HTTP address, such as a LAN IP, ttyd substitutes a native file picker: uploads still work, directory picks use `webkitdirectory`, and `tsz` downloads every file separately instead of writing into a chosen folder. Use `-S -C <cert> -K <key>` or an HTTPS reverse proxy for the full behaviour.

  Input frames are capped at 256 KiB by the server, so the browser limits a trzsz data chunk to 96 KiB before encoding. Raising `-f` / `--srv-buf-size` does not change that limit; it only controls how much the PTY delivers per read.

  Sixel, for [img2sixel](https://saitoha.github.io/libsixel) and [lsix](https://github.com/hackerb9/lsix):

```bash
ttyd -W -t enableSixel=true bash
```

  `img2sixel image.png` draws an image. Use a larger `-f` (for example `-f 65536`) for a large image. With Sixel enabled, the primary DA reply (`CSI c`) includes parameter `4`. The secondary DA reply (`CSI > c`) is unchanged.

  ConPTY on Windows does not pass these binary protocols through unchanged; use them on Linux or macOS. On Windows, ttyd sends `isWindows=true`. If the command is a POSIX shell, add `-t isWindows=false`.

# EXAMPLES
  ttyd starts web server at port 7681 by default, you can use the -p option to change it, the command will be started with arguments as options. For example, run:
  
```  
ttyd -p 8080 bash -x
```

  Then open http://localhost:8080 with a browser, you will get a bash shell with debug mode enabled. More examples:

  - If you want to login with your system accounts on the web browser, run `ttyd login`.
  - You can even run a non-shell command like vim, try: `ttyd vim`, the web browser will show you a vim editor.
  - Sharing single process with multiple clients: `ttyd tmux new -A -s ttyd vim`, run `tmux new -A -s ttyd` to connect to the tmux session from terminal.

# SSL how-to
  Generate SSL CA and self signed server/client certificates:

```
# CA certificate (FQDN must be different from server/client)
openssl genrsa -out ca.key 2048
openssl req -new -x509 -days 365 -key ca.key -subj "/C=CN/ST=GD/L=SZ/O=Acme, Inc./CN=Acme Root CA" -out ca.crt

# server certificate (for multiple domains, change subjectAltName to: DNS:example.com,DNS:www.example.com)
openssl req -newkey rsa:2048 -nodes -keyout server.key -subj "/C=CN/ST=GD/L=SZ/O=Acme, Inc./CN=localhost" -out server.csr
openssl x509 -sha256 -req -extfile <(printf "subjectAltName=DNS:localhost") -days 365 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt

# client certificate (the p12/pem format may be useful for some clients)
openssl req -newkey rsa:2048 -nodes -keyout client.key -subj "/C=CN/ST=GD/L=SZ/O=Acme, Inc./CN=client" -out client.csr
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt
openssl pkcs12 -export -clcerts -in client.crt -inkey client.key -out client.p12
openssl pkcs12 -in client.p12 -out client.pem -clcerts
```

  Then start ttyd:

```
ttyd --ssl --ssl-cert server.crt --ssl-key server.key --ssl-ca ca.crt bash
```

  You may want to test the client certificate verification with *curl*(1):

```
curl --insecure --cert client.p12[:password] -v https://localhost:7681
```

  If you don't want to enable client certificate verification, remove the `--ssl-ca` option.

# Docker and ttyd
  Docker containers are jailed environments which are more secure, this is useful for protecting the host system, you may use ttyd with docker like this:

  - Sharing single docker container with multiple clients: docker run -it --rm -p 7681:7681 tsl0922/ttyd.
  - Creating new docker container for each client: ttyd docker run -it --rm ubuntu.

# Nginx reverse proxy

Sample config to proxy ttyd under the `/ttyd` path:

```nginx
location ~ ^/ttyd(.*)$ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:7681/$1;
}
```

# AUTHOR
  Shuanglei Tao \<tsl0922@gmail.com\> Visit https://github.com/tsl0922/ttyd to get more information and report bugs.
