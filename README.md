# claude-usage-widget

Always-on-top floating widget for Windows that shows your live Claude
subscription quota (5-hour and 7-day windows) for **every logged-in
Claude account** on the machine, plus a 4-hour throughput sparkline
and today's token total from Claude Code's local logs.

```
┌─ Claude Code ──────── 21:04:12 ─ ⋯ ─┐
│ HAUPT                               │
│  5h  ██████░░░░   62 %       1h12m  │
│      ████░░░░░░   41 %  Zeit        │
│  7d  ███░░░░░░░   31 %       2d 3h  │
│ ACCT2                               │
│  5h  █░░░░░░░░░    8 %       4h55m  │
│  7d  ██░░░░░░░░   17 %       5d 1h  │
│ LAST 4H              PEAK 84K T/MIN │
│  ▁▂▅▃▁▁▂▇▅▂▁▃▂▁                     │
│ Today: 2.8M                220 msg  │
└─────────────────────────────────────┘
```

## What it shows

- **Subscription quota, per account** — live 5-hour and 7-day window
  utilisation with reset countdown, fetched once a minute from
  Anthropic's `/api/oauth/usage` endpoint (the same source as Claude
  Code's `/usage` slash command). Bars tint amber at ≥75 % and red
  at ≥90 %.
- **Time-elapsed bar** — a thin second bar under each quota bar
  showing how far through the current window you are by *time*. If
  the usage bar is ahead of the time bar you're burning quota faster
  than the clock; if it's behind, you have headroom.
- **4-hour throughput sparkline** — tokens per minute in 5-minute
  buckets across every project. Y-axis capped at the 95th-percentile
  rate so a single session-start cache_creation spike doesn't flatten
  the rest of the chart.
- **Today totals** — "new work" tokens (input + output +
  cache_creation, **not** cache_read) summed across every project's
  transcript, from local-time midnight.

If a quota fetch fails transiently (network blip, token refresh in
flight), the widget keeps showing that account's last good numbers
with an amber "stale" note instead of blanking the row.

## Multi-account

The widget discovers accounts automatically: it scans your home
directory for directories matching `.claude*` that contain a
`.credentials.json` (i.e. a completed Claude Code login).

Display names are derived from the directory name:

| Directory        | Shown as |
| ---------------- | -------- |
| `.claude`        | `haupt`  |
| `.claude-acct2`  | `acct2`  |
| `.claude-<name>` | `<name>` |

Order is stable: `haupt` first, the rest alphabetically.

To override discovery (different names, different order, extra or
fewer accounts), add an `accounts` array to
`~/.claude-usage-widget.json` (the same file that stores the window
position):

```json
{
  "accounts": [
    { "name": "arbeit", "configDir": "C:\\Users\\me\\.claude" },
    { "name": "privat", "configDir": "C:\\Users\\me\\.claude-acct2" }
  ]
}
```

If the file has no valid `accounts` array, discovery runs as normal.

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

The widget works on any machine that has Claude Code installed and
Node.js 22+, and it shows the quota of the accounts logged in under
*that* user — `~/.claude*` is per-user.

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

## Data sources

- `~/.claude*/.credentials.json` — one per account. The OAuth access
  token is sent as `Authorization: Bearer …` to
  `https://api.anthropic.com/api/oauth/usage`. When a token is near
  expiry (or rejected), the widget exchanges the stored refresh token
  against the same `console.anthropic.com` endpoint Claude Code
  itself uses and **writes the new token pair back atomically** into
  the same `.credentials.json` — exactly what Claude Code does on its
  own next start.
- `~/.claude/projects/<project>/<sessionId>.jsonl` — Claude Code's
  per-session transcripts (read-only). Each `type: "assistant"` line
  carries `message.usage` with token counts; the sparkline and the
  today totals are summed from these. Reads are incremental: the
  widget remembers its per-file position and only reads what was
  appended since the last poll.

Apart from the quota calls to `api.anthropic.com` /
`console.anthropic.com`, nothing leaves the machine. No telemetry.

## Architecture

- `main.js` — Electron main process. One frameless, transparent,
  always-on-top BrowserWindow; position/size persisted across
  restarts; right-click context menu.
- `preload.js` — exposes a minimal `window.widget` API to the
  sandboxed renderer.
- `src/parser.js` — reads the transcript JSONLs (tail-first,
  incremental) and computes the today totals and the throughput
  series. Pure Node, no Electron dependency.
- `src/quota.js` — account discovery + Anthropic OAuth usage client
  (fetch, token refresh, response flattening). Pure Node.
- `src/renderer.js` — polls via `window.widget` and re-renders the
  DOM. No framework; the data volume is tiny.
- `src/index.html` + `src/styles.css` — the UI. Dark glass look via
  `backdrop-filter`.

## Tests

```sh
npm test
```

Runs the unit tests (`node --test`, no dependencies) against
synthetic fixtures in a temp directory. The tests never read your
real `~/.claude*` profiles and never talk to the network.

## Tuning

Poll cadences live at the bottom of `src/renderer.js`: today totals
and sparkline every 30 s, quota every 60 s. The sparkline window and
bucket size are the `scanSeries(4, 5)` arguments (hours, minutes).
