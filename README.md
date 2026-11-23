# Jarvis

A transparent desktop assistant for Windows: a borderless terminal that talks to
your local Hermes Agent, plus a macOS-style monitoring notch at the top of the
screen. Everything Hermes can do — terminal, files, browser, web, reminders,
memory — happens behind that terminal.

## Run it

```bash
npm install                                    # first time only
./node_modules/electron/dist/electron.exe .    # foreground, with console
```

or double-click **Start Jarvis.vbs** (no console window).

Ctrl+Alt+J summons/hides the window, Ctrl+E quits. The tray icon has
*New conversation*, *Recenter* and *Quit*. On first launch it registers itself
to start at login (`orb.config.json` → `startAtLogin`).

## What it does

**Terminal chat.** A transparent, borderless, monospace surface. Your lines are
dim steel-blue, answers are bright silver and stream in as the model produces
them. Esc stops an answer mid-flight; a question typed while one is still
running is queued and answered next.

**Fast local path.** These never touch the model — they answer in tens of
milliseconds:

| you type | it does |
| --- | --- |
| `open notepad` / `open calc` | launches the app |
| `open github.com` | opens the site in your browser |
| `run ipconfig` | runs the shell command, prints its output |
| `read example.com` | fetches the page and shows the text (~2 s) |
| `read example.com and summarize it` | fetches, then answers from that page |
| `remind me in 10 min to call mom` | reminder that fires a notch notification |
| `timer 5 min` | countdown timer |
| `note: buy milk` | saves a quick note |

Everything else goes to the agent.

**Memory.** Facts, notes, reminders and a writing-style profile live in `data/`
as plain JSON on this machine. It learns from "remember that …", "my name is …",
"I prefer …", and injects whatever is relevant into the next prompt.

**The notch.** A separate always-on-top window at the top-centre: clock, world
clocks (`+ zone` adds Tehran/London/Milan/New York/Tokyo…), weather, system
stats, a music player whose bars follow the real audio signal, and clipboard
history. It hides whenever the main window is on screen.

**Dashboard.** Hardware only — CPU/RAM/GPU rings, meters and a live sensor log.

## Commands

| command | result |
| --- | --- |
| `/dashboard` `/hardware` `/settings` | open that panel |
| `/attach` | send a file for Jarvis to read |
| `/voice` | read the last answer aloud |
| `/reminders` `/notes` | list what is scheduled / saved |
| `/clr` (`/clear`) | wipe the transcript **and** the agent session |
| `/new` | start a fresh conversation |
| `/help` | the list above |

## How it talks to Hermes

`hermes-bridge.js` spawns the CLI per message:

```
hermes chat -q "<prompt>" --format stream-json                     # first message
hermes --resume <session-id> chat -q "<prompt>" --format stream-json
```

`--format stream-json` gives token deltas, so text appears while it is being
generated instead of afterwards. The session id arrives in the result event and
is stored in `session.json`.

Two latency controls:

- **Fast profile** for short, non-action questions on a *new* session
  (`--max-turns 4 --reasoning minimal`). Resume pins the launch policy, so those
  flags are only used when a session is created.
- **Context recycling** — a resumed session replays its whole transcript, so a
  41k-token session answered in ~13 s where a fresh one took ~5 s. Past 25k
  input tokens the bridge starts a fresh session, keeping continuity through
  `data/memory.json` and the profile.

## Config — `orb.config.json`

| Key | Meaning |
| --- | --- |
| `startAtLogin` | register Jarvis in Windows startup |
| `startHidden` | stay off-screen until summoned |
| `autoHideSeconds` | hide after this long idle (0 = never) |
| `uiScale` | 0.7 – 1.6 |
| `briefOnStart` | speak first with a briefing after launch |
| `briefEveryHours` | minimum gap between briefings |
| `theme` | accent colour, orb size, panel opacity |

## Files

| File | Role |
| --- | --- |
| `main.js` | Electron main: windows, transparency, tray, notch, reminders, IPC |
| `preload.js` | the only surface exposed to the page (`window.jarvis`) |
| `index.html` / `renderer.mjs` | the terminal UI and three.js orb |
| `notch.html` / `notch.mjs` | the monitoring capsule |
| `hermes-bridge.js` | spawns the Hermes CLI, streams and parses its output |
| `lib/` | testable modules: intent, reminders, memory, dashboard, timezones, drag, cpu, monitor, media, notify, guard, profile |
| `tests/` | 126 unit tests (`npm test`) |
| `vendor/three.*.js` | three.js r187 (both `three.module.js` and `three.core.js`) |
| `tools/` | dev helpers for inspecting and driving the live window over CDP |

## Privacy

`data/` (facts, notes, reminders, profile, calendar), `session.json` and the logs
are git-ignored and never leave this machine. The memory layer refuses to store
anything that looks like a password, token, key or card number.

## Tests

```bash
npm test        # 126 unit tests
npm run stress  # throughput + memory-churn checks
```

## Known sharp edges

- **The UI is served over `app://`, not `file://`.** `file://` blocks ES-module
  imports, which silently kills the renderer with no visible error — call
  `protocol.handle('app', …)` at startup or every window loads blank.
- **three.js r187 ships two files.** `three.module.js` imports `three.core.js`;
  copy both into `vendor/` or the import fails with `ERR_UNEXPECTED`.
- **No `AdditiveBlending` on the main sphere.** With a transparent Electron
  window, additive blending writes alpha=1 and turns the orb into a dark disc.
- **The window is click-through until the cursor is over an element with class
  `hit`.** That is `setIgnoreMouseEvents(true, {forward:true})` plus hover
  detection in the renderer; nothing behind the window gets blocked.
- **Don't paint a translucent overlay across the window.** A 3%-alpha scanline
  texture over the whole frame makes the "transparent" window read as a grey box
  with edges.
