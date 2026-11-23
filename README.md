# Jarvis orb

A floating orb at the top of the screen that talks to your local Hermes Agent.
Click it, type, press Enter. Everything Hermes can do — terminal, files, browser,
email, cron, skills, memory — happens behind that orb.

## Run it

```bash
# foreground, with a console for debugging
./node_modules/electron/dist/electron.exe .

# or double-click "Start Jarvis.vbs" (no console window)
```

It registers itself to start at login on first launch (`orb.config.json` →
`startAtLogin`). Ctrl+Alt+J toggles focus. Tray icon → right-click for
*New conversation*, *Recenter*, *Quit*.

## Controls

| Action | Result |
| --- | --- |
| Click orb | opens the ask panel |
| Drag orb | moves the window |
| Enter | sends the prompt |
| Esc | closes the panel |
| Ctrl+Alt+J | focus / unfocus the orb |

## How it talks to Hermes

`hermes-bridge.js` spawns:

```
hermes.exe chat -q "<prompt>"                    # first message
hermes.exe --resume <session-id> chat -q "<prompt>"   # every message after
```

The session id is scraped from the CLI footer and stored in `session.json`, so the
orb keeps one continuous conversation. "New conversation" deletes that file.

## Config — `orb.config.json`

| Key | Meaning |
| --- | --- |
| `startAtLogin` | register the orb in Windows startup |
| `briefOnStart` | speak first with a briefing after launch |
| `briefEveryHours` | minimum gap between briefings (default 8) |
| `briefPrompt` | the prompt used for the briefing |

## Files

| File | Role |
| --- | --- |
| `main.js` | Electron main: window, transparency, drag, tray, login item, briefing |
| `preload.js` | the only bridge exposed to the page (`window.jarvis`) |
| `index.html` | layout + styling |
| `renderer.mjs` | three.js orb + all interaction logic |
| `hermes-bridge.js` | spawns the Hermes CLI, parses its output |
| `vendor/three.*.js` | three.js r187 (both `three.module.js` and `three.core.js`) |
| `tools/cdp.mjs`, `tools/watch.mjs` | dev helpers for inspecting the live window |

## Known sharp edges

- **The UI is served over `app://`, not `file://`.** `file://` blocks ES-module
  imports, which silently kills the renderer with no visible error.
- **three.js r187 ships two files.** `three.module.js` imports `three.core.js`;
  copy both into `vendor/` or the import fails with `ERR_UNEXPECTED`.
- **No `AdditiveBlending` on the main sphere.** With a transparent Electron
  window, additive blending writes alpha=1 and turns the orb into a dark disc.
- **The window is click-through until the cursor is over the orb.** That is
  `setIgnoreMouseEvents(true, {forward:true})` plus hover detection in the
  renderer; nothing behind the orb gets blocked.
