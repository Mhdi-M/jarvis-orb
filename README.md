# Jarvis

A terminal assistant for Windows, backed by your local Hermes Agent. Type
`jarvis` in any terminal and you get a chat with a live sidebar showing the
model you are using, how many tokens the turn cost, and what your machine is
doing — while Jarvis opens apps, reads sites, runs commands, keeps reminders and
remembers what you told it.

The monitoring notch is a separate tool: see `jarvis-notch`.

## Install

```bash
npm install            # first time only (no runtime dependencies beyond Hermes)
```

Put the launcher on your PATH (already done on this machine):

```cmd
echo node ".\cli\jarvis.js" %%* > %USERPROFILE%\bin\jarvis.cmd
```

## Use

```bash
jarvis                          # interactive session
jarvis "what is 42*7"           # one question, print the answer, exit
jarvis --frame                  # render one frame and exit (layout debugging)
```

`jarvis` needs a real terminal window for its interface; in a pipe it tells you
so instead of hanging.

### Keys

| key | action |
| --- | --- |
| Enter | send (queues if an answer is still streaming) |
| Esc | stop the answer / clear the line |
| Ctrl+C | stop the answer, then exit |
| ↑ / ↓ | walk your history |
| Ctrl+L | redraw |
| Ctrl+E | jump to end of line |

### Commands

| command | what it does |
| --- | --- |
| `/help` | the list |
| `/model [name]` | show or set the model (applies to the next new session) |
| `/agent [cloud\|local\|provider]` | where answers come from |
| `/new` | fresh conversation, new agent session |
| `/clear` | wipe the transcript (memory is kept) |
| `/tokens` | turn and session token usage |
| `/hw` | CPU / RAM / GPU / disk snapshot |
| `/sys` | OS, cores, node version, uptime |
| `/open <app\|url>` | launch an app or open a site |
| `/run <cmd>` | run a shell command |
| `/read <url> [and summarize it]` | fetch a page, optionally answer from it |
| `/ls [dir]` / `/cat <file>` | look around the filesystem |
| `/remind <in 10 min\|at 18:30\|tomorrow 9> <text>` | reminder |
| `/reminders [clear]` | list or clear |
| `/note <text>` / `/notes [clear]` | quick notes |
| `/memory` · `/forget <text>` | what it knows about you |
| `/tabs` · `/tab <n>` · `/chrome` | list Chrome tabs, read one, launch CDP Chrome |
| `/messages [n]` | recent notifications from every app on the PC |
| `/msg <app>` | read an open WhatsApp / Telegram / X / LinkedIn tab |
| `/find <term>` | deep search the notification history |
| `/summarize [term]` | summarise the last search or the recent messages |
| `/skill save <name>` | write a skill from what you just did |
| `/skills` · `/skill show|rm <name>` | manage self-written skills |
| `/profile` | what Jarvis learned about your style |
| `/summary` · `/sessions` | rolling session summary (local model) and notes on disk |
| `/remember <fact>` · `/recall [term]` | store and search what it knows about you |
| `/models` · `/local on\|off` | local Ollama models, answer from them only |
| `/skill auto [name]` | let the local model write the skill |
| `/notch` | start the monitoring notch |
| `/quit` | leave |

### Plain-language shortcuts

These never touch the model — they answer in milliseconds:

```
open notepad            open notepad
open github.com         open github.com
run ipconfig /all       run the command, print its output
read example.com        fetch the page text
read example.com and summarize it
remind me in 10 min to stretch
timer 5 min
note: buy milk
```

Everything else is a normal question to the agent.

## The sidebar

While the session runs, the right column tracks:

- **MODEL / PROVIDER** — what will answer the next question
- **AGENT** — idle or working
- **SESSION** — the current Hermes session id
- **TOKENS** — turn input/output, session totals, and how large the replayed
  context has grown
- **HARDWARE** — CPU, RAM, GPU temperature, disk, refreshed every 2 s
- **reminders / memory / uptime**

## Local model (Ollama)

Jarvis keeps a local model warm and uses it for everything that does not need the
big one — nothing leaves the machine and it costs nothing:

| job | how |
| --- | --- |
| session summary | every 6 exchanges the conversation is compressed into a few bullet lines, stored in `data/sessions/` and injected as "session so far" |
| learning facts | after each answer the local model extracts durable preferences ("User deploys with pnpm…") and writes them to memory |
| skill drafting | `/skill auto` turns what you just did into numbered steps, saved under `data/skills/` and injected when the same work comes up |
| offline answers | `/local on` answers from Ollama alone, no network |

Model: `qwen2.5:1.5b` by default (`JARVIS_OLLAMA_MODEL` to change). The first call
loads it (~19 s); after that a short answer takes 0.2–0.3 s, and the CLI warms it
at startup. Embeddings are not used: this Ollama server runs without
`--embeddings`, so recall is keyword + recency scoring.

## How it talks to Hermes

`hermes-bridge.js` spawns the CLI per message:

```
hermes chat -q "<prompt>" --format stream-json                    # first message
hermes --resume <id> chat -q "<prompt>" --format stream-json      # after that
```

`--format stream-json` streams token deltas, so text appears as it is generated.
The session id and token counts come back in the result event.

Two things keep it responsive:

- **fast profile** for short, non-action questions on a new session
  (`--max-turns 4 --reasoning minimal`)
- **context recycling** — a resumed session replays its transcript, so a
  41k-token session answered in ~13 s where a fresh one took ~5 s. Past 25k
  input tokens the bridge starts a new session, keeping continuity through
  `data/memory.json`.
- **paused-session recovery** — if a turn was cut off (crash, kill), the next
  message discards the stuck turn and retries instead of refusing to answer.

## Data

`data/` holds facts, notes and reminders as plain JSON and never leaves the
machine. The memory layer refuses to store anything that looks like a password,
token, key or card number. `data/`, `session.json` and logs are git-ignored.

## Tests

```bash
npm test        # 126 unit tests
npm run stress  # throughput + memory churn
```

## Files

| file | role |
| --- | --- |
| `cli/jarvis.js` | the whole terminal UI: layout, input, streaming, commands |
| `hermes-bridge.js` | spawns Hermes, streams deltas, recycles context, recovers paused sessions |
| `lib/intent.mjs` | recognises `open` / `run` / `read` phrasing |
| `lib/reminders.mjs` | parses "remind me …" / "timer …" / "note: …" |
| `lib/memory.js` | what Jarvis remembers about you |
| `lib/*` | cpu sampler, monitor, guard, profile, dashboard helpers |
| `tests/` | unit tests |
