# Agent Note: 桌面外壳是承载受监管 dsh web 宿主的 Electron 窗口

Status: implemented

[English](2026-09-02-desktop-electron-shell.md) | 中文

## Problem

Harness 的 GUI 目前只是 `dsh --profile web` 服务的一个浏览器页面：想要 Codex/OpenCode 式桌面应用的人必须打开终端、启动宿主、再维持一个浏览器标签页。Web 客户端、宿主 API、会话、工作区、审批，以及 Windows 执行链（pwsh 技术栈加 ACL 限制）都已建成并通过测试，再造一个原生客户端平面等于为零能力增益重写整个产品面。

## Decision

`apps/desktop`（`@deepseek-ai/dsh-desktop`）是一个 Electron 主进程加一个无特权窗口，承载未改动的 web 组合。它不新增客户端插件、不新增 wire 方法、不新增组合行；整个后端就是已发布的 `dsh web` 宿主。

主进程拥有一个语义封闭的 `HostSupervisor`：每个应用至多一个宿主；配置了非零端口时先用真实的 `host.describe` 调用探测并在健康时收养（端口可绑定本身证明不了什么——可能是别的进程占着）；否则以 `--host 127.0.0.1 --port 0` 拉起宿主，让每次启动都拿到系统私配端口，就绪判据是 `dsh web:` URL 行发布端口之后 `host.describe` 成功。所有权决定退出行为：`stop()` 只终止自己拉起的子进程（连进程树一起，Windows 上用 `taskkill /T /F`），绝不杀用户在应用外启动的宿主。

启动解析无 shell：一律可执行文件加 argv。默认启动是以当前可执行文件运行本工作区的 `@deepseek-ai/dsh` CLI（Electron 下设 `ELECTRON_RUN_AS_NODE=1`）；`DSH_DESKTOP_BIN` 覆盖值按平台整形，Windows 分支拒绝 npm 安装在 `dsh.cmd` 旁留下的无扩展名 POSIX shim，`.cmd`/`.bat` 改经 `cmd /D /S /C` 包装执行。宿主在就绪前退出或超时的失败会携带捕获的子进程输出，并优先展示 loader 内层的 `failed to import loader entry …` 行而非 `cordis:include` 包装行。

渲染进程保持无特权：无 Node 集成、上下文隔离、沙箱开启、所有开窗尝试一律拒绝、导航被限制在宿主源内。`/api` 回环信任栅栏仍是页面需要的唯一授权；preload 桥保持缺席，直到某个能力真正需要它。

## Alternatives considered

- **Tauri**：v1 不采用——本仓库没有 Rust 工具链，运行 harness 宿主仍需 Node 边车，且外壳要为两条 WebSocket 事件流做第二套 IPC 集成。`packages/host/webserver/README.md` 预留的缝（Electron 以 `file://` 加载 dist 并走 IPC fetch 桥）同样暂不启用：它要求为单次 RPC、两条下行流和动态客户端插件包分发各造新载体，而回环 HTTP 已全部提供。
- **原生客户端平面（在 `ctx.typertGateway` 上新建窗口层）**：不采用——它复制浏览器花名册、slot 系统和传输层却无新能力，违背能力缝"角色只在独立演进时才拆分"的规则。
- **按工作区各起宿主**：不采用——宿主是带跨会话面（subagent 注册表、token 计量、插件清单）的进程单例；每应用一个宿主才匹配组合自身的形状。

外部先例验证了"收养/拉起 + describe 探测"模式在已发布宿主上可行：[desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui) 项目的 `dsh` 引擎（`dsh-host-rpc`）实现了同样的监管语义。

## Consequences

- 桌面面在宿主支持的每个平台上都与 web 面同等强大，包括 Windows pwsh/ACL 执行链，且客户端代码零复制。
- 单元套件以无进程方式钉住监管器生命周期（收养、拉起、URL 行端口发现、退出/超时诊断、只杀亲生、并发 ensure 共享）；`tests/host-boot.e2e.ts` 从源码经监管器启动真实组合，在未构建前端 dist 的检出上自跳过，与免密 e2e 通道的自跳过约定一致。
- 打包产物是可移植目录而非安装器：`scripts/build-exe-for-desktop.ts` 部署 `@deepseek-ai/dsh-desktop-runtime` 闭包（与 `python/sdk-runtime` 同理的纯依赖清单根，补齐 pnpm deploy 不安装的全部 peer），并把经过 SHA-256 校验的 Electron 运行时包在外层；`Desktop exe` 工作流在 Windows runner 上构建 win32-x64 产物并做打包启动冒烟——改名后的可执行文件以 Node 模式拉起部署好的 `dsh --profile web` 宿主。本地通道在 Linux 上证明同一机制。安装器、代码签名与自动更新仍延后：exe 未签名，SmartScreen 会告警。
- 桌面窗口加载宿主发布的完整就绪 URL，让宿主发布的一次性 token 查询参数（浏览器会话认证）送达页面。收养的宿主无法做到：其 token 行打在启动者自己的 stdout 上，收养路径只能加载无 token 的 URL，浏览器会话退回页面的未认证兜底。
- Electron 的二进制下载 postinstall 在 `pnpm-workspace.yaml` 的 `allowBuilds` 中保持拒绝（打包管线自行下载运行时 zip 并校验；门禁从不启动外壳，本地想运行的开发者通过 approve-builds 获取二进制）。
- Windows `.cmd` 覆盖分支仍仅由单元测试钉住；打包通道验证的是默认可执行启动，不是 `DSH_DESKTOP_BIN` 覆盖。
- 回环栅栏是可达性策略而非认证——在补上每次启动的能力令牌或命名管道传输之前，不能宣称抗本机恶意进程。
