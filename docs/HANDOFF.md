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

1. **Vision-path ground truth** — `lib/visionact.js` exists (UIA first, vision
   fallback). Unmeasured: how accurate the vision coordinates are. Target a
   control whose box UIA reports, ask vision for it, compare centres.
2. **Pairing flow in the gateway** — currently token-only. Add one-time codes:
   client requests, user runs `/serve approve <code>`.
3. **`/reflect`** — distil `data/team-lessons.json` into a preferences file that
   is injected into agent prompts (the "gets better with use" loop).
4. **paper-orchestra wiring** — deps installing into `~/venvs/main`. Then either
   add an agent `papers` with toolset `terminal` that drives
   `paper_writing_cli.py`, or a `/paper` command. Needs model keys before it runs.
5. **Window focus** — verified once (AppActivate -> "Meet - ..."), keep an eye on
   it after Chrome updates.

## Known traps (learned the hard way)

- Windows paths inside JS/Python strings: use forward slashes, or backslashes get
  eaten (`C:UsersSource...`).
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
