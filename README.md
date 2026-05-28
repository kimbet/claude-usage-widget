# claude-usage-widget

Always-on-top floating widget for Windows that shows live status,
context utilisation and 15-minute throughput of every active Claude
Code session on the machine.

```
┌─ Claude Code Usage ─────────────┐
│ ● wine        busy              │
│   ████████░░  195k / 1M  (20%)  │
│   17.2k tok/min · last 15m      │
│                                 │
│ ● around      idle 3m           │
│   █░░░░░░░░░  89k / 1M   (9%)   │
│   0 tok/min                     │
│                                 │
│ Today: 2.8M tok      220 msg    │
└─────────────────────────────────┘
```

## What it shows

- **One row per active session.** "Active" = the CLI's process is
  still alive and the registry file in `~/.claude/sessions/<pid>.json`
  has been updated within the last 10 minutes.
- **busy / idle** indicator — green dot busy, amber dot idle (with
  age since last heartbeat).
- **Context bar + percentage** — `input + cache_read + cache_creation`
  of the most recent assistant message in the session's JSONL,
  divided by the model's known context limit. Bar tints amber at
  ≥70% and red at ≥90%.
- **Tokens per minute over the last 15 minutes** — "new work" only
  (input + output + cache_creation, **not** cache_read), because
  cache_read replays of the conversation dominate raw counts by
  10–100× and make every session look like 600k tok/min.
- **Today totals** — same "new work" definition, summed across
  every project's JSONL, from local-time midnight.

## Run

```sh
npm install
npm start
```

Right-click the widget for a context menu (toggle always-on-top,
reload, DevTools, quit). Drag the header to move; window position
persists in `~/.claude-usage-widget.json`.

## Data sources (read-only)

- `~/.claude/sessions/<pid>.json` — Claude Code's live process
  registry. Has `pid`, `sessionId`, `cwd`, `status` (`"busy"`/`"idle"`),
  `name`, `updatedAt`.
- `~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl` — per-session
  transcript. Each `type: "assistant"` line carries `message.usage`
  with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, and `message.model`.

Nothing leaves the machine. No API calls, no telemetry.

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
