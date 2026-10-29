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
- 支持 [ZMODEM](https://en.wikipedia.org/wiki/ZMODEM)（[lrzsz](https://ohse.de/uwe/software/lrzsz.html)）/ [trzsz](https://trzsz.github.io) 文件传输
- 支持 [Sixel](https://en.wikipedia.org/wiki/Sixel) 图像输出（[img2sixel](https://saitoha.github.io/libsixel) / [lsix](https://github.com/hackerb9/lsix)）
- 基于 [rustls](https://github.com/rustls/rustls) 的 TLS 和双向 TLS 支持
- 可运行任意自定义命令并传递参数
- Web 登录（可选 30 天“记住我”）、Basic 认证和反向代理请求头认证
- 会话可恢复：刷新标签页会重新连接同一个 PTY 并回放最近的输出
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

- 需要认证时会显示内置登录页。“记住我”默认勾选，会在当前浏览器中保持登录 30 天。取消勾选时，登录使用会话 Cookie，并在 12 小时后或浏览器关闭时失效。
- “记住我”登录使用经 HMAC 签名的 `HttpOnly` Cookie。只要 `-c` 凭据不变，ttyd 重启后登录仍然有效；更改凭据会使已有的记住登录失效。退出登录会清除当前浏览器中的 Cookie；由于会话是无状态的，已复制的 Cookie 在过期前仍然有效。
- `-H name` 会将认证交给反向代理，并禁用本地登录页。通过 `-I` 传入的自定义页面保持原有行为，仅在认证后提供。
- 浏览器对 `/token` 和 `/ws` 的请求会自动使用登录 Cookie。API 客户端仍可使用 `curl -u user:pass`。
- 使用 `-b /mounted/here` 时，登录、退出、Token 和 WebSocket 路由以及 Cookie 的 `Path` 都会限定在 `/mounted/here` 下。当 TLS 在反向代理处终止时，发送 `X-Forwarded-Proto: https`，使 Cookie 带有 `Secure` 标记。

## 会话保持

默认情况下，客户端断开后 PTY 会保留 30 秒。刷新页面会重新连接同一个 shell、编辑器或正在运行的命令，并回放最多 4 MiB 的最近输出。会话 ID 保存在 `sessionStorage` 中，因此每个标签页拥有独立会话，新开标签页会启动新命令。

- `--session-timeout <seconds>` 调整断开后保留会话的时间。设为 `0` 会禁用会话保持，并在最后一个客户端断开后立即终止命令。
- `--session-buffer-size <bytes>` 调整内存中的输出回放缓冲大小。
- 在页面 URL 后添加 `?sessionTimeout=N` 可覆盖当前标签页的超时时间（最大 3600 秒）。如果服务端以 `--session-timeout 0` 启动，该覆盖值无法重新启用会话保持。
- `-q` / `--exit-no-conn` 与 `-o` / `--once` 保持原有语义，可能在刷新后的页面重连前退出。

## 浏览器支持

支持现代浏览器，参见[浏览器支持](https://github.com/xtermjs/xterm.js#browser-support)。

## 替代方案

- [Wetty](https://github.com/krishnasrinivas/wetty)：基于 [Node.js](https://nodejs.org) 的 Web 终端（SSH/登录）
- [GoTTY](https://github.com/yudai/gotty)：基于 [Go](https://golang.org) 的 Web 终端
