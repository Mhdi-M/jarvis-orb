# Handoff — state of Jarvis

Last updated in a long session that hit its context limit. Read this first, then
`jarvis-toolbelt` and `graphify-agent` skills.

## Verified working (do not rebuild)

| area | how to check |
|---|---|
| agent registry + failover | `/agents` then `/cascade <task>` |
| upper manager / team | `/team <task>` (plan -> parallel -> merge) |
| local brain | `/agents run local "3*3"` |
| vision (cloud + local fallback) | `/look <question>` |
| UIA app control | `/ui list chrome`, `/ui click Feishu Search` |
| browser control | `/browse <url> --click/--fill/--hover/--double-click/--scroll` |
| tabs + windows | `lib/windows.js` (tabs() / activateTab() / windows() / focusApp()) |
| system ops | `/ctl status | volume | power | lock | brightness` |
| background jobs | `/bg <task>`, `/bg list`, toast on finish |
| gateway | `/serve on` -> `/status`, `/ask`, `/bg` (token required) |
| VPN + DeepSeek | `/vpn diag` (Throne path recorded) |
| robot cursor | starts only from `/takeover`; paints (instrumented paint log) |
| brain graph | `/graph open` -> data/graph.html |

## Open items, in order

1. **Vision-path ground truth** — `lib/visionbench.js` benches UIA against the
   vision model. Last run: the bench works, but the window lookup needs the
   Chrome title on this desktop (`no window matching 'chrome'`); measure once the
   title is stable.
2. **FreeLLMAPI as a Hermes provider** — the app is installed, paired and 87
   models are visible on `127.0.0.1:31415`; the only working upstream is the
   custom DeepSeek endpoint. Hermes needs `custom_providers.freellm` added by
   hand (the agent is not allowed to edit `config.yaml`).
3. **Vision accuracy numbers** — run `/visionbench 3` with a stable Chrome
   window and record hit-rate and median px in `data/vision-accuracy.json`.
4. **NVIDIA / Google keys inside FreeLLMAPI** — the app's validator returns 403
   for both even though Hermes uses them; add Groq/Cerebras/Mistral in the app.
5. **Paper run** — `/paper check` passes; a full generation has not been run
   (needs raw materials, figures, and hours).
6. **Window focus** — verified once (AppActivate → "Meet - ..."), keep an eye on
   it after Chrome updates.

## Known traps (learned the hard way)

- Windows paths inside JS/Python strings: use forward slashes, or backslashes get
  eaten (`C:Usersyou...`).
- `stdio:'ignore'` kills a WinForms overlay; use piped stdio.
- MSYS paths passed to native tools are not translated: `D:\venvs\main`, not `/d/...`.
- pip here needs `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY` (no SOCKS support).
- `powercfg /list` hides OEM schemes (Turbo) while another plan is active — switch
  back by GUID `6fecc5ae-f350-48a5-b669-b472cb895ccf`.
- Duplicate command names: `/sys` = system info, `/ctl` = volume/power. Check
  `grep -oE "case '[a-z]+'" cli/jarvis.js` before adding a command.
- Hermes silently substitutes a fallback model for an unknown `--model`, so verify
  which model answered rather than trusting exit code 0.

## Needs user input

Google/Outlook OAuth · Notion token · Firecrawl key (have it) · server SSH ·
openllmapi key or self-host · which OpenClaw channels · TUN-mode verification.
