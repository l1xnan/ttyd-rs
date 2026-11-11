[![backend](https://github.com/l1xnan/ttyd-rs/actions/workflows/backend.yml/badge.svg)](https://github.com/l1xnan/ttyd-rs/actions/workflows/backend.yml)
[![frontend](https://github.com/l1xnan/ttyd-rs/actions/workflows/frontend.yml/badge.svg)](https://github.com/l1xnan/ttyd-rs/actions/workflows/frontend.yml)
[![GitHub Releases](https://img.shields.io/github/downloads/l1xnan/ttyd-rs/total)](https://github.com/l1xnan/ttyd-rs/releases)
[![License](https://img.shields.io/github/license/l1xnan/ttyd-rs)](https://github.com/l1xnan/ttyd-rs/blob/main/LICENSE)

[English](README.md) | 简体中文

# ttyd - 在 Web 上共享你的终端

ttyd 是一个简单的命令行工具，可通过 Web 共享终端。

![截图](screenshot.gif)

# 特性

- 基于 [Tokio](https://tokio.rs) 和 [Axum](https://github.com/tokio-rs/axum) 的 Rust 后端，以及单文件 [xterm.js](https://xtermjs.org) 前端
- 功能完整的终端，支持 [CJK](https://en.wikipedia.org/wiki/CJK_characters) 和输入法（IME）
- 支持 [ZMODEM](https://en.wikipedia.org/wiki/ZMODEM)（[lrzsz](https://ohse.de/uwe/software/lrzsz.html)）/ [trzsz](https://trzsz.github.io) 文件传输，见[文件传输与 Sixel](#文件传输与-sixel)
- 内置 HTTP 文件传输（标签栏「Upload」「Download」按钮），远端**无需**安装 `lrzsz` 或 `trzsz`，见[文件传输与 Sixel](#文件传输与-sixel)
- 支持 [Sixel](https://en.wikipedia.org/wiki/Sixel) 图像输出（[img2sixel](https://saitoha.github.io/libsixel) / [lsix](https://github.com/hackerb9/lsix)），见[文件传输与 Sixel](#文件传输与-sixel)
- 基于 [rustls](https://github.com/rustls/rustls) 的 TLS 和双向 TLS 支持
- 可运行任意自定义命令并传递参数
- Web 登录（可选 30 天“记住我”）、Basic 认证和反向代理请求头认证
- 会话可恢复：刷新标签页会重新连接同一个 PTY 并回放最近的输出
- 会话历史：已结束的会话保留在内存中，可只读回放和删除，见[会话保持](#会话保持)
- 支持 IPv4、IPv6、TCP 和 UNIX 域套接字
- 跨平台：Linux、macOS 和 Windows（ConPTY）。在 Windows 上，`-s` 不会传递 POSIX 信号，也不存在进程组；此时会直接终止子进程

# 安装

预编译二进制文件仅通过本项目的
[GitHub Releases](https://github.com/l1xnan/ttyd-rs/releases) 页面分发。每个发布文件都是可直接运行的二进制，不是压缩包。

| 文件 | 平台 | 架构 | 适用情况 |
| --- | --- | --- | --- |
| `ttyd.x86_64` | Linux | x86_64 | 绝大多数 64 位 PC、服务器和虚拟机，包括 x86_64 WSL |
| `ttyd.aarch64` | Linux | ARM64 | 64 位 ARM 系统，如安装 64 位系统的树莓派 3/4/5 |
| `ttyd.armhf` | Linux | ARMv7 硬浮点 | 32 位 ARM 系统，如安装 32 位系统的树莓派 2/3/4 |
| `ttyd.i686` | Linux | 32 位 x86 | 较旧的 32 位 x86 系统；64 位 x86 请使用 `ttyd.x86_64` |
| `ttyd.macos-x86_64` | macOS | Intel x86_64 | Intel 芯片 Mac |
| `ttyd.macos-arm64` | macOS | Apple Silicon | Apple Silicon（M 系列）芯片 Mac |
| `ttyd.win32.exe` | Windows | x86_64 | 64 位 Windows 10/11 |

Linux 二进制使用 musl 静态链接，不依赖宿主机的 glibc 版本。`ttyd.armhf` 需要支持硬件浮点的 ARMv7 CPU，无法在树莓派 1、Zero 等 ARMv6 设备上运行。

下载对应文件后，将其放到 `PATH` 中并命名为 `ttyd`（Windows 上为 `ttyd.exe`）。例如在 Linux 或 macOS 上：

```sh
chmod +x ttyd.x86_64
sudo mv ttyd.x86_64 /usr/local/bin/ttyd
```

请把示例中的文件名替换为你实际下载的文件。Windows 上可将 `ttyd.win32.exe` 重命名为 `ttyd.exe`，然后移动到 `PATH` 中的某个目录。

如果 macOS 阻止运行未签名的二进制，可在**系统设置 > 隐私与安全性**中允许，或移除隔离属性：

```sh
xattr -d com.apple.quarantine ttyd
```

发布页面同时提供 `SHA256SUMS`，可用于校验下载文件的完整性。本项目目前不提供包管理器安装方式。

在 Windows 上，ttyd 会在 ConPTY 中启动命令。`-s` / `--signal` 不会传递该信号，也不存在进程组；会话结束时，子进程会被终止。

## 从源码构建

前端会在编译时嵌入 Rust 二进制文件，因此请先构建前端。

前置条件：

- Rust 1.88 或更高版本（推荐使用 `rustup`）
- Node.js 22.12 或更高版本
- pnpm 12（执行 `corepack enable` 即可）
- TLS 依赖所需的 C 编译器（Debian/Ubuntu 上为 `build-essential`，macOS 上为 Xcode Command Line Tools，Windows 上为 Visual Studio Build Tools）

```sh
pnpm --dir html install --frozen-lockfile
pnpm --dir html run check
pnpm --dir html run build
cargo build --release --manifest-path rust/Cargo.toml
```

二进制文件会生成到 `rust/target/release/ttyd`（Windows 上为 `ttyd.exe`）。

开发时，请先构建一次前端，然后运行 `cargo run --manifest-path rust/Cargo.toml -- -W bash`。修改前端源码时，请使用 [html/README.md](html/README.md) 中描述的 Vite 开发流程。

# 用法

## 命令行选项

```text
用法：
    ttyd [options] <command> [<arguments...>]

选项：
    -p, --port              监听端口（默认：7681，使用 `0` 表示随机端口）
    -i, --interface         要绑定的网络接口（例如 eth0），或 UNIX 域套接字路径（例如 /var/run/ttyd.sock）
    -U, --socket-owner      UNIX 域套接字文件的所属用户（例如 user:group）
    -c, --credential        Web 登录和 Basic 认证使用的凭据（格式：username:password）
        --credential-file   从文件读取 username:password。TTYD_CREDENTIAL 使用相同格式，读取后会从环境变量中删除
        --random-credential 生成 ttyd:<password> 登录口令并打印到 stderr。与 --credential、--credential-file、TTYD_CREDENTIAL 互斥
    -H, --auth-header       用于认证代理的 HTTP 请求头名称；配置后由 HTTP 反向代理处理认证
    -u, --uid               运行所使用的用户 ID
    -g, --gid               运行所使用的用户组 ID
    -s, --signal            退出时发送给命令的信号（默认：1，SIGHUP）。在 Windows 上会直接终止子进程
    -w, --cwd               为子程序设置的工作目录
    -a, --url-arg           允许客户端通过 URL 发送命令行参数（例如 http://localhost:7681?arg=foo&arg=bar）
    -W, --writable          允许客户端向 TTY 写入（默认只读）
    -t, --client-option     向客户端发送选项（格式：key=value），可重复使用以添加更多选项
    -T, --terminal-type     报告的终端类型，默认：xterm-256color
    -O, --check-origin      禁止来自不同源的 WebSocket 连接
    -m, --max-clients       支持的最大客户端数（默认：0，不限制）
    -o, --once              只接受一个客户端，并在断开连接后退出
    -q, --exit-no-conn      所有客户端断开连接后退出
    -B, --browser           使用系统默认浏览器打开终端
    -I, --index             自定义 index.html 路径
    -b, --base-path         反向代理请求使用的预期基础路径（例如 /mounted/here，最大长度：128）
    -P, --ping-interval     WebSocket ping 间隔（秒，默认：5）
    -f, --srv-buf-size      一次从 PTY 读取的最大字节数；较大的值可能提高吞吐量（默认：4096）
        --session-timeout      分离后保留会话的秒数（默认：30，0 表示禁用会话保持）
        --session-buffer-size  用于会话回放的输出缓冲字节数（默认：4194304）
        --history-limit        保留多少个已结束会话用于只读回放（默认：20，0 表示禁用历史）
        --http-transfer     启用 HTTP 文件传输（需要 -W）
        --http-transfer-dir           无法跟随 shell cwd 时的上传落点（默认：-w / 进程 cwd）
        --http-transfer-root          可选白名单：把所有文件操作限制在该目录内
        --http-transfer-max-upload    单个上传文件的最大字节数（默认：67108864）
        --http-transfer-session-quota 每目录近似配额（字节），0 表示不限制（默认：268435456）
        --no-http-follow-cwd  始终使用 --http-transfer-dir，不跟随 shell 的 cwd
    -6, --ipv6              启用 IPv6 支持
    -S, --ssl               启用 SSL
    -C, --ssl-cert          SSL 证书文件路径
    -K, --ssl-key           SSL 私钥文件路径
    -A, --ssl-ca            用于验证客户端证书的 SSL CA 文件路径
    -d, --debug             设置日志级别（默认：7）
    -v, --version           打印版本并退出
    -h, --help              打印帮助信息并退出
```

在[上游 ttyd wiki](https://github.com/tsl0922/ttyd/wiki/Example-Usage)中阅读示例用法。

## 认证

使用 `-c username:password` 启用内置 Web 登录页。同一凭据仍可用于 HTTP Basic 认证：

```sh
ttyd -c user:pass bash
```

`--credential`、`--credential-file` 和 `TTYD_CREDENTIAL` 互相排斥，它们也都不能和 `--random-credential` 一起使用。`--credential-file` 从文件读取 `username:password`，并去掉末尾的一个换行。在 Unix 上，如果该文件对组或其他用户可读，ttyd 会给出警告。`TTYD_CREDENTIAL` 使用相同格式，并在启动子程序之前从环境变量中删除。`--random-credential` 以用户名 `ttyd` 和随机密码登录，并向 stderr 打印一次 `ttyd login: ttyd:<password>`。随机密码在每次启动时都会变化，因此上一次进程留下的记住登录会失效。

- 需要认证时会显示内置登录页。“记住我”默认勾选，会在当前浏览器中保持登录 30 天。取消勾选时，登录使用会话 Cookie，并在 12 小时后或浏览器关闭时失效。
- “记住我”登录使用经 HMAC 签名的 `HttpOnly` Cookie。只要 `-c` 凭据不变，ttyd 重启后登录仍然有效；更改凭据会使已有的记住登录失效。退出登录会清除当前浏览器中的 Cookie；由于会话是无状态的，已复制的 Cookie 在过期前仍然有效。
- `-H name` 会将认证交给反向代理，并禁用本地登录页。通过 `-I` 传入的自定义页面保持原有行为，仅在认证后提供。
- 浏览器对 `/token` 和 `/ws` 的请求会自动使用登录 Cookie。API 客户端仍可使用 `curl -u user:pass`。
- 使用 `-b /mounted/here` 时，登录、退出、Token 和 WebSocket 路由以及 Cookie 的 `Path` 都会限定在 `/mounted/here` 下。当 TLS 在反向代理处终止时，发送 `X-Forwarded-Proto: https`，使 Cookie 带有 `Secure` 标记。

## 会话保持

默认情况下，客户端断开后 PTY 会保留 30 秒。刷新页面会重新连接同一个 shell、编辑器或正在运行的命令，并回放最多 4 MiB 的最近输出。会话 ID 保存在 `sessionStorage` 中，因此每个标签页拥有独立会话，新开标签页会启动新命令。

- `--session-timeout <seconds>` 调整断开后保留会话的时间。设为 `0` 会禁用会话保持，并在最后一个客户端断开后立即终止命令。
- `--session-buffer-size <bytes>` 调整内存中的输出回放缓冲大小。
- 客户端在握手 JSON 中声明 `"replayFrames": true` 时，回放输出改用帧 `5` 发送；未声明时仍用帧 `0`，以兼容旧客户端。浏览器收到帧 `5` 会直接写入终端，不经过 ZMODEM/trzsz 解析，因此重连不会让回放里的 `trz` 提示再次弹出文件选择框。
- 在页面 URL 后添加 `?sessionTimeout=N` 可覆盖当前标签页的超时时间（最大 3600 秒）。如果服务端以 `--session-timeout 0` 启动，该覆盖值无法重新启用会话保持。
- `-q` / `--exit-no-conn` 与 `-o` / `--once` 保持原有语义，可能在刷新后的页面重连前退出。

已结束的会话也会保留，用于只读回放。会话退出、过期或被删除时，ttyd 会先把会话 ID、所属用户、命令、退出码、结束时间和当前回放缓冲复制到内存中的历史表，再回收 PTY。PTY 本身不会保留，因此历史记录只能只读回放，无法作为原来的 shell 重新接入。超过上限时会丢弃最旧的记录，历史在进程重启后消失。保存的输出就是回放缓冲，仍然受 `--session-buffer-size` 限制。

- `--history-limit <count>` 设置保留的已结束会话数量（默认：20）。设为 `0` 会禁用历史。
- 回放历史会打开 `/ws`，在正常握手 JSON 之外加上 `"attachOnly": true`。如果该 ID 存在于历史中，服务端会先回放保存的输出帧，然后发送帧 `4`，内容为 `{"readonly":true,"exitCode":N}`；之后丢弃输入，也不再创建 PTY。如果历史中没有该 ID，连接会直接关闭，不启动 shell。正常重连不会发送 `attachOnly`，过期或已归档的 ID 保持现有行为，即启动新会话。
- 会话面板分为“运行中”（未在本页打开的正在运行的会话，点击可接入）和“历史”（已结束的会话，可只读回放或删除记录）。只有在 `GET /sessions` 可用时才会显示该面板，也就是配置了认证时。本页自己的标签页标题优先使用本地记住的 shell 标题，面板中的服务端条目显示启动命令。

会话 API 路由位于 `-b` 设置的基础路径下：

- `GET /sessions` 仅返回当前用户正在运行的会话和历史记录。只有配置了认证（`-c`、`--credential-file`、`TTYD_CREDENTIAL`、`--random-credential` 或 `-H`）时才可用；未配置认证时返回 `404`，以免暴露会话 ID。使用 `-c` 时凭据是共享的，持有该凭据的人看到同一个列表。
- `GET /sessions/{id}` 只返回元数据，不含回放内容。未配置认证时，知道 ID 即可访问，与按 ID 连接 `/ws` 相同；配置了认证时，会话必须属于当前用户，否则返回 `403`。
- `DELETE /sessions/{id}` 会终止并归档正在运行的会话，或删除一条历史记录。配置了认证时会话必须属于当前用户，否则返回 `403`。成功返回 `204`，ID 不存在时返回 `404`。
- API 中的时间戳是 Unix 毫秒时间戳（`endedAt`）。被终止或过期的会话记录退出码 `-1`。

启用 `--http-transfer -W` 后，同一基础路径下还会多出两个路由（都要求 `X-TTYD-Transfer: 1` 头，并绑定会话 ID 与所属用户）：

- `POST /sessions/{id}/files?name=<文件>` 以 `application/octet-stream` 原始请求体上传单个文件。同名返回 `409`，超过 `--http-transfer-max-upload` 返回 `413`。
- `GET /sessions/{id}/download?path=<路径>` 下载绝对路径或相对落点的任意文件。符号链接和目录会被拒绝；超出 `--http-transfer-root` 返回 `403`。

未加 `--http-transfer` 时这些路由返回 `404`；未加 `-W` 时返回 `403`。

## 文件传输与 Sixel

ZMODEM、trzsz 和 Sixel 默认关闭，用 `-t` 客户端选项打开。文件传输，以及 `img2sixel` / `lsix` 用来判断终端是否支持 Sixel 的探测应答，都要从浏览器写回 PTY，所以下面的示例都带 `-W`。只读会话仍然可以显示已经输出的 Sixel，但探测应答发不出去时，这两个工具会认为终端不支持 Sixel。

对应的命令需要装在**运行 ttyd 所启动的那个程序**所在的环境里。装好之后可以按下面的命令手工试一次。持续集成不会安装 `lrzsz`、`trzsz` 或 `img2sixel`。下面的 HTTP 文件传输是例外：它内置于 ttyd，远端不需要安装任何东西。

### HTTP 文件传输

这条通路**不依赖远端任何程序**——不需要 `trz`、`tsz`、`rz`、`sz`，也不需要辅助脚本，普通 HTTP 下即可使用。默认关闭，并且同样需要 `-W`：

```sh
ttyd --http-transfer -W bash
ttyd --http-transfer -W --http-transfer-dir D:/uploads bash   # Windows / macOS
```

- **上传**：点标签栏「Upload」按钮，或把文件拖进终端。对话框会先显示上传落点，再弹出系统文件选择框，上传过程带进度条。
- **上传落点**：Linux 下通过 `/proc/<pid>/cwd` 跟随 shell 当前目录，`cd` 会改变落点；无法跟随时（Windows、macOS、ConPTY、探测失败或加了 `--no-http-follow-cwd`）使用 `--http-transfer-dir <目录>`；未配置则用 `-w` / 进程 cwd。落点会在上传前显示。
- **下载**：点标签栏「Download」按钮，输入服务器文件路径（绝对路径，或相对上传落点的路径），点 Download 即可。
- `--http-transfer-root <目录>` 是可选白名单，同时约束上传和下载，越界返回 `403`。不加时，ttyd 进程能读的任意文件都可下载；不受信任的网络请加 `-c` 或 `-H`。
- 同名返回 `409`，超过 `--http-transfer-max-upload` 返回 `413`。不覆盖、不断点续传、不并发分块。
- 请求绑定运行中的会话 ID 和所属用户。终端输入不会被拦截，`ttyd-*` 不是命令。

### ZMODEM

在该环境中安装 [lrzsz](https://ohse.de/uwe/software/lrzsz.html)（提供 `sz` 和 `rz`）：

```sh
ttyd -W -t enableZmodem=true bash
```

- 在网页终端里执行 `sz 文件`，浏览器会下载该文件。
- 执行 `rz` 后选择要上传的文件。等待选择时可以按 Ctrl+C，也可以在对话框里点取消；取消后终端恢复输入。
- 一次可以选择多个文件。

### trzsz

在该环境中安装 [trzsz](https://trzsz.github.io)（提供 `trz` 和 `tsz`）：

```sh
ttyd -W -t enableTrzsz=true bash
```

- `trz` 从浏览器上传文件，`tsz 文件` 把文件下载到浏览器。
- 把文件拖进终端也会上传。拖放之后 ttyd 会在终端里启动 `trz`，并在 `-t trzszDragInitTimeout` 毫秒内等待服务端响应，默认 3000。
- 可以和 ZMODEM 一起打开：`-t enableZmodem=true -t enableTrzsz=true`。没有 trzsz 传输在进行时，ZMODEM 仍然可用。
- trzsz 依赖浏览器的 File System Access API，而该 API 只在 HTTPS 或 `localhost` 下可用。用普通 HTTP 地址（例如局域网 IP）访问时，ttyd 会退化成原生文件选择框：上传照常可用，选目录走 `webkitdirectory`，`tsz` 下载则变成每个文件单独触发一次浏览器下载，而不是写进你指定的目录。需要完整行为请开启 TLS（`-S -C <证书> -K <私钥>`）或放到 HTTPS 反向代理后面。
- 服务端单帧输入上限为 256 KiB，因此浏览器会把 trzsz 的数据分块限制在 96 KiB（编码前）。调大 `-f` / `--srv-buf-size` 不会改变该上限，它只控制 PTY 每次读取的字节数。

### Sixel

```sh
ttyd -W -t enableSixel=true bash
```

安装 [libsixel](https://saitoha.github.io/libsixel) 之后，用 `img2sixel 图片.png` 显示图片，或用 [lsix](https://github.com/hackerb9/lsix) 列出当前目录里的图片。图片较大时可以加大一次从 PTY 读取的字节数，例如 `-f 65536`。

打开 Sixel 后，终端对 Primary DA（`CSI c`）的应答会带上参数 `4`，`img2sixel` 和 `lsix` 靠它识别 Sixel。Secondary DA（`CSI > c`）保持 xterm.js 原来的应答。

Windows 上的 ConPTY 不会原样转发 ZMODEM、trzsz 和 Sixel 使用的二进制数据，这些功能应在 Linux 或 macOS 上使用。ttyd 在 Windows 上会向浏览器发送 `isWindows=true`，trzsz 会按 Windows shell 处理换行。如果实际启动的是 POSIX shell（例如 Git Bash），再加上 `-t isWindows=false`。

## 浏览器支持

支持现代浏览器，参见[浏览器支持](https://github.com/xtermjs/xterm.js#browser-support)。

## 替代方案

- [Wetty](https://github.com/krishnasrinivas/wetty)：基于 [Node.js](https://nodejs.org) 的 Web 终端（SSH/登录）
- [GoTTY](https://github.com/yudai/gotty)：基于 [Go](https://golang.org) 的 Web 终端
