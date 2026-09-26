# Agent Note: The desktop shell is an Electron window over a supervised dsh web host

Status: implemented

English | [中文](2026-09-02-desktop-electron-shell.zh.md)

## Problem

The Harness GUI exists only as a browser page served by `dsh --profile web`: a person who wants a Codex/OpenCode-style desktop application must open a terminal, start the host, and keep a browser tab alive. The web client, the host API, sessions, workspaces, approvals, and Windows execution (pwsh stack plus ACL confinement) are all already built and tested, so a second, native client plane would re-implement the entire product surface for no capability gain.

## Decision

`apps/desktop` (`@deepseek-ai/dsh-desktop`) is an Electron main process plus one unprivileged window over the unchanged web composition. It adds no client plugin, no wire method, and no composition row; it reuses the shipped `dsh web` host as the entire backend.

The main process owns a `HostSupervisor` with closed semantics: at most one host per app; a configured non-zero port is probed with a real `host.describe` call and adopted when healthy (a bound port alone proves nothing — another process may own it); otherwise the host is spawned with `--host 127.0.0.1 --port 0` so every launch gets a private OS-assigned port, and readiness is `host.describe` succeeding after the `dsh web:` URL line publishes the port. Ownership decides exit behavior: `stop()` kills only a spawned child (process tree, `taskkill /T /F` on Windows), never a host the person started outside the app.

Launch resolution is shell-free: executable plus argv, always. The default launch is this workspace's `@deepseek-ai/dsh` CLI under the current executable (`ELECTRON_RUN_AS_NODE=1` under Electron); a `DSH_DESKTOP_BIN` override is shaped per platform, and the Windows arm refuses the extensionless POSIX shim an npm install leaves beside `dsh.cmd`, wrapping `.cmd`/`.bat` through `cmd /D /S /C` instead. A host that exits or times out before readiness fails with the captured child output, preferring the loader's inner `failed to import loader entry …` line over the `cordis:include` wrapper.

The renderer stays unprivileged: no Node integration, context isolation, sandbox on, all window-open attempts denied, and navigation fenced to the host origin. The `/api` loopback trust fence remains the only authority the page needs; the preload bridge stays absent until a capability actually requires one.

## Alternatives considered

- **Tauri**: rejected for v1 — no Rust toolchain in this repository, a Node sidecar would still be required to run the harness host, and the shell would need a second IPC integration for the two WebSocket event streams. The `packages/host/webserver/README.md` seam (Electron loads dist over `file://` with an IPC fetch bridge) is deliberately not taken yet either: it would require a new carrier for unary RPC, both downlink streams, and dynamic client-plugin bundle delivery, all of which loopback HTTP already provides.
- **A native client plane (new windowing over `ctx.typertGateway`)**: rejected — it duplicates the browser roster, slot system, and transport with no new capability, against the capability-seam rule that roles split only when they evolve independently.
- **Per-workspace hosts**: rejected — the host is a process singleton with cross-session surfaces (subagent registry, token meter, plugin inventory); one host per app matches the composition's own shape.

External prior art validated the adopt/spawn-plus-describe pattern over the published host: the [desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui) project's `dsh` engine (`dsh-host-rpc`) ships the same supervisor semantics.

## Consequences

- The desktop surface is as strong as the web surface on every platform the host supports, including the Windows pwsh/ACL execution chain, with zero duplication of client code.
- Unit suites pin the supervisor lifecycle (adopt, spawn, URL-line port discovery, exit/timeout diagnostics, kill-only-spawned, concurrent ensure sharing) without processes; `tests/host-boot.e2e.ts` boots the real composition from source through the supervisor and self-skips on a checkout without the built frontend dist, matching the keyless e2e lane's self-skip contract.
- Packaging is a portable directory, not an installer: `scripts/build-exe-for-desktop.ts` deploys the `@deepseek-ai/dsh-desktop-runtime` closure (a dependency-only root that, like `python/sdk-runtime`, supplies every peer pnpm deploy leaves uninstalled) and wraps the SHA-256-verified Electron runtime around it, and the `Desktop exe` workflow builds the win32-x64 artifact on a Windows runner with a packaged-launch smoke — the renamed executable, running as Node, boots the deployed `dsh --profile web` host. The local lane proves the same mechanism on Linux. Installer, code signing, and auto-update remain deferred: the exe is unsigned and SmartScreen will warn.
- The desktop window loads the host's full readiness URL, so the per-launch token query the host publishes (browser-session auth) reaches the page. An adopted host cannot: its token line went to its own launcher's stdout, so the adopted path loads a token-less URL and the browser session rides the page's unauthenticated fallback.
- Electron's binary-download postinstall stays denied in `pnpm-workspace.yaml` `allowBuilds` (the packaging pipeline downloads the runtime zip itself, checksum-verified; gates never launch the shell, and a developer who wants to run it locally approves builds to fetch the binary).
- The Windows `.cmd` override arm is pinned by unit tests only; the packaging lane exercises the default executable launch, not the `DSH_DESKTOP_BIN` override.
- The loopback fence is reachability, not authentication — hostile-local-process resistance needs a per-launch capability token or named-pipe transport before it can be claimed.
