# One-paste install via Claude Code

Hand this file to a friend. They open **Claude Code** (in any
directory, doesn't matter which), paste the block between the
`---SNIP---` markers, and CC will clone, install and launch the
widget for them. No terminal commands to memorise.

The block is idempotent — re-pasting it later upgrades the widget
to the latest `main` and skips already-done steps.

---

```
---SNIP---
Install + run the claude-usage-widget on this machine.

Repo: https://github.com/kimbet/claude-usage-widget

Steps (be terse, just do it; only ask if something genuinely blocks you):

1. Verify Node.js 22+ is on PATH (`node --version`). If not present, stop
   and tell me to install Node 22+ from https://nodejs.org/ first.

2. Verify Claude Code is logged in (`~/.claude/.credentials.json` exists
   and contains `claudeAiOauth.accessToken`). If not, stop and tell me
   to run Claude Code at least once and complete login.

3. Pick install directory:
     - Windows: C:\repos\claude-usage-widget
     - macOS/Linux: ~/claude-usage-widget
   If it doesn't exist, `git clone https://github.com/kimbet/claude-usage-widget.git <dir>`.
   If it does exist, `cd <dir> && git pull --ff-only` (upgrade).

4. `cd` into the directory and run `npm install` (idempotent — npm
   skips already-installed deps).

5. Launch the widget detached so it survives this CC session:
     - Windows: open a new process via PowerShell:
         Start-Process -FilePath "<dir>\node_modules\electron\dist\electron.exe" -ArgumentList "." -WorkingDirectory "<dir>"
     - macOS/Linux: `nohup npm start >/dev/null 2>&1 &`

6. (Windows only, optional but recommended) Create autostart shortcut
   if not already present at
   "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Claude Usage Widget.lnk":
   Use the PowerShell `WScript.Shell` COM object — target
   `<dir>\node_modules\electron\dist\electron.exe`, args `.`,
   working dir `<dir>`. Also drop the same shortcut on the Desktop
   for manual launches.

7. Report back: install dir, whether the widget window appeared,
   autostart status. One short paragraph, no celebration.

If any step fails, surface the actual error message verbatim — don't
paraphrase, don't retry blindly.
---SNIP---
```

## What the widget does, in one line

Always-on-top window showing your live 5-hour and 7-day Claude
subscription quota (all logged-in accounts) with reset countdown, a
4-hour throughput sparkline, and today's totals. All local; one API
call per account per minute to `api.anthropic.com`.

## If the friend isn't using Claude Code yet

Then they can't paste this — there's no CC to paste into. Send them
the README instead:
https://github.com/kimbet/claude-usage-widget#readme — manual
clone + `start.bat` (Windows) or `npm start` (macOS/Linux).
