# CLAUDE.md — claude-usage-widget

Always-on-top-Electron-Widget für Windows: Abo-Quota (5h-/7d-Fenster) aller
lokal eingeloggten Claude-Konten live vom Anthropic-OAuth-Endpoint, dazu
Durchsatz-Sparkline und Tages-Token-Summen aus den lokalen Claude-Code-
Transkripten. Kein Framework, einzige Dependency ist `electron`.

## NIE unbeaufsichtigt gegen echte Profile starten

`npm start` ist KEIN harmloser Smoke-Test: `src/quota.js` refresht ablaufende
OAuth-Tokens und schreibt das neue Token-Paar zurück in die
`.credentials.json` **jedes entdeckten Kontos** (`~/.claude`,
`~/.claude-acct2`, …) — wie Claude Code selbst, aber für alle Konten auf
einmal. Ein „kurz mal starten" rotiert also real Credentials; parallel
laufende Sessions anderer Konten können dabei ihre Anmeldung verlieren. Die
App startet nur der Besitzer (`start.bat` / `npm start`).

Verhalten prüfen ausschliesslich mit `npm test` (`node --test`): die Tests
bauen synthetische Fixtures in einem Temp-Verzeichnis, lesen nie echte
`~/.claude*`-Profile und reden nie mit dem Netz. Das ist eine Invariante —
neue Tests nach demselben Muster.

## Konten-Discovery und die geteilte Override-Datei

Discovery (`src/quota.js`): Home-Verzeichnis nach `.claude*`-Ordnern mit
`.credentials.json` scannen. Anzeigenamen: `.claude` → `haupt`,
`.claude-<name>` → `<name>`; Reihenfolge `haupt` zuerst, Rest alphabetisch.
Override über ein `accounts`-Array in `~/.claude-usage-widget.json`.

Dieselbe Datei speichert auch die Fensterposition (`main.js`). `saveState()`
merged deshalb jeden Patch über den frisch gelesenen Bestand
(`{ ...loadState(), ...patch }`) — beim Erweitern der Persistenz dieses
Muster beibehalten und die Datei **nie blind überschreiben**, sonst löscht
ein simples Fensterverschieben das `accounts`-Override des Benutzers (oder
umgekehrt).

## Sonstiges

- `src/parser.js` liest die Transkript-JSONLs inkrementell (gemerkte
  per-File-Position, tail-first) — die Poll-Kosten hängen genau daran;
  Änderungen mit den Parser-Fixtures absichern.
- „Today"-Summe = input + output + cache_creation, bewusst **ohne**
  cache_read.
- Ein fehlgeschlagener Quota-Fetch blankt die Zeile nicht: letzter guter
  Wert bleibt stehen, mit „stale"-Hinweis.
- Poll-Kadenzen stehen unten in `src/renderer.js` (30 s Totals/Sparkline,
  60 s Quota); Sparkline-Fenster/Bucket sind die `scanSeries(4, 5)`-Argumente.
