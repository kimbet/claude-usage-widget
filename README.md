# claude-usage-widget

Always-on-top floating widget for Windows showing Claude Code and Codex
subscription usage. Each provider has its own quota bars and reset countdowns.
Claude's local token activity is also shown in the chart and daily totals.

```
┌─ Claude + Codex ────────────────┐
│ Claude Code · haupt            │
│ 5h  █████░░░░░  50%     2h30m  │
│ 7d  ██░░░░░░░░  20%      110h  │
│ Codex · pro                    │
│ 5h  ███░░░░░░░  30%       4h  │
│ 7d  █░░░░░░░░░  10%      120h  │
│ Claude · last 4h               │
│ Claude today: 2.8M     220 msg  │
└────────────────────────────────┘
```

## What it shows

- **Claude subscription quota** — live 5-hour and 7-day window utilisation
  with reset countdown, fetched once a minute from Anthropic's
  `/api/oauth/usage` endpoint (same source as Claude Code's `/usage`
  slash command). Auth via the OAuth token in
  each configured account's `.credentials.json`. Account configuration is
  read from `C:\repos\IP-Tagebuch\config\accounts.json`, with `~/.claude`
  as the fallback.
- **Codex subscription quota** — consumed percentage, reset countdown and
  elapsed-time bar, refreshed independently every minute. The window lengths
  and additional limit groups come from Codex, rather than assuming 5h/7d.
  Missing login/limits are shown explicitly. Transient failures retain the
  last successful values with a visible stale notice.
- **4-hour throughput sparkline** — tokens-per-minute in 5-min
  buckets across every project. Y-axis capped at the 95th-percentile
  rate so a single session-start cache_creation spike doesn't
  flatten the rest of the chart.
- **Claude today totals** — input + output + cache creation (excluding cache
  reads), summed across every project's JSONL from local-time midnight.

## Codex setup

The Codex CLI must be installed and signed in with the ChatGPT account whose
subscription limits you want to see. The widget uses the existing Codex login
(and `CODEX_HOME` if set); it does not request a separate API key. API-key-only
accounts do not expose ChatGPT subscription limits.

Windows npm installations and native executables on PATH are detected.
For a different installation, set `CODEX_BIN` to the native Codex executable's
absolute path before launching the widget.

Each refresh starts a hidden, short-lived `codex app-server --listen stdio://`
process and calls only `initialize`, `account/read` and `account/rateLimits/read`.
The process is stopped after the result or a 25-second timeout, and on widget
exit. It opens no chat and sends no model request. Existing Codex sessions are
not stopped. Protocol: [official app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Run

Easiest path on Windows — clone, then **double-click `start.bat`**.
First run installs the dependencies (~30 s), every subsequent
double-click just launches the widget (no console window, no `npm`
command needed).

```sh
git clone https://github.com/kimbet/claude-usage-widget.git
cd claude-usage-widget
start.bat
```

Equivalent for terminal users / macOS / Linux:

```sh
npm install
npm start
```

Right-click the widget for a context menu (toggle always-on-top,
reload, DevTools, quit). Drag the header to move; window position
persists in `~/.claude-usage-widget.json`.

## Autostart on Windows (optional)

Run this PowerShell snippet from the repo root. It creates a desktop
shortcut for manual launch and a Startup-folder shortcut that fires
the widget at every Windows login — no CMD window, just the widget.

```powershell
$repo   = (Resolve-Path .).Path
$target = "$repo\node_modules\electron\dist\electron.exe"
$wsh    = New-Object -ComObject WScript.Shell

foreach ($dst in @(
    [Environment]::GetFolderPath('Desktop'),
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
)) {
    $lnk = $wsh.CreateShortcut("$dst\Claude Usage Widget.lnk")
    $lnk.TargetPath        = $target
    $lnk.Arguments         = "."
    $lnk.WorkingDirectory  = $repo
    $lnk.IconLocation      = $target
    $lnk.Save()
}
```

To disable autostart later, delete
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Claude Usage Widget.lnk`.

## Sharing with a friend

Claude activity comes from the local Claude profile. Claude Code and Node.js
22+ are required; install and sign into Codex to enable the Codex section.

For a friend on Windows:

```sh
git clone https://github.com/kimbet/claude-usage-widget.git
cd claude-usage-widget
```

Then **double-click `start.bat`** — it installs deps on first run and
starts the widget. No terminal knowledge required after the clone.

The widget shows their sessions, not yours — `~/.claude/` is per-user.
For autostart, run the PowerShell snippet above from the repo root.

On macOS/Linux the parser logic is the same; `npm start` works there
too, though the path-mangling convention (see `mangleCwd` in
`src/parser.js`) was verified on Windows only — adjust if Claude Code's
folder layout differs on those OSes.

## Data sources

- `~/.claude/sessions/<pid>.json` — Claude Code's live process
  registry. Has `pid`, `sessionId`, `cwd`, `status` (`"busy"`/`"idle"`),
  `name`, `updatedAt`.
- `~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl` — per-session
  transcript. Each `type: "assistant"` line carries `message.usage`
  with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, and `message.model`.
- `~/.claude/.credentials.json` — OAuth access token, used solely as
  `Authorization: Bearer …` against `https://api.anthropic.com/api/oauth/usage`
  (same endpoint Claude Code's own `/usage` command hits). The
  response carries the 5-hour and 7-day window utilisation.

- Codex's local app-server reads the current account and fetches its limits
  from OpenAI. Credentials are managed by Codex and never passed to the
  widget renderer. Only normalized quota data reaches the display.

The widget fetches provider quotas once per minute. Claude OAuth credentials
may be renewed and saved by `quota.js`; Codex handles its own authentication.
Local conversation contents are not uploaded by the widget.

## Architecture

- `main.js` — Electron main process. One frameless, transparent,
  always-on-top BrowserWindow. Position/size persisted across
  restarts. Registers an IPC handler for the right-click context
  menu.
- `preload.js` — exposes a sandboxed `window.widget` API to the
  renderer with `scan()` (single snapshot) and `openContextMenu()`.
- `src/parser.js` — all data work: lists active sessions, reads
  each session's JSONL tail-first, computes context size + 15-min
  rate. Pure Node, no Electron dependency — usable from any script.
- `src/quota.js` — Anthropic OAuth usage endpoint client. Reads the
  CC OAuth token, calls `/api/oauth/usage`, flattens the response
  into `fiveHour` / `sevenDay` / etc.
- `src/codex-quota.js` — Codex app-server client, run in the main process.
  Resolves the installed executable, fetches limits and disposes its child.
- `src/renderer.js` — polls `window.widget.scan()` every 2 seconds
  and re-renders the DOM. No virtual DOM, no framework; the data
  volume is tiny.
- `src/index.html` + `src/styles.css` — the UI. Dark glass look
  via `backdrop-filter`.

## Tuning

- Refresh interval: `src/renderer.js` line `setInterval(refresh, 2000)`.
- "Active" stale-window: `src/parser.js` `ACTIVE_WINDOW_MS`.
- Throughput window: `src/parser.js` `THROUGHPUT_WINDOW_MS`.
- Per-model context cap: `src/parser.js` `CONTEXT_LIMITS` map. Default
  for unknown models is 200k.
