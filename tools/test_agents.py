"""Exercise the agent capabilities end to end and print a verdict table.

  A  specialist loads a skill by itself
  B  vision specialist sees the screen (one hop, no manager detour)
  C  hands specialist runs a shell command
  D  B + C in parallel (what a supervisor fan-out does) vs the sum of both
  E  three Jarvis instances in parallel, isolated sessions
  F  manager alone (baseline for the same style of question)
"""
import json, os, subprocess, time, threading
from concurrent.futures import ThreadPoolExecutor

HERMES = r"C:\Users\you\AppData\Local\hermes\hermes-agent\.hermes\bin\hermes.exe"
CLI = r".\cli\jarvis.js"
CWD = r"."
SHOT = r"C:\Users\you\AppData\Local\Temp\jarvis-eye.png"

results = []


def run_hermes(args, timeout=240):
    t0 = time.time()
    p = subprocess.run([HERMES] + args, capture_output=True, cwd=CWD, timeout=timeout)
    out = p.stdout.decode("utf-8", "replace").strip()
    return round(time.time() - t0, 1), out


def run_jarvis(prompt, session=None, timeout=240):
    args = ["node", CLI]
    if session:
        args += ["--session", session]
    args.append(prompt)
    t0 = time.time()
    p = subprocess.run(args, capture_output=True, cwd=CWD, timeout=timeout)
    out = p.stdout.decode("utf-8", "replace").strip()
    return round(time.time() - t0, 1), out


def record(name, ok, secs, note, skip=None):
    results.append((name, ok, secs, note, skip))
    tag = "SKIP" if skip else ("PASS" if ok else "FAIL")
    print("  %-42s %s  %5.1fs  %s" % (name, tag, secs, note[:70]))


def classify(out):
    low = out.lower()
    if "rate limit" in low or "quota" in low or "503" in low or "unavailable" in low:
        return "skip"
    return None


print("A. sub-agent loads a skill by itself")
t, out = run_hermes(["-z", "Use skill_view to open the skill named 'hermes-agent' and reply with only its first heading line."])
record("skill load in a child", "Hermes Agent" in out, t, out.splitlines()[-1] if out else "no output")

print("\nB. vision specialist (one hop)")
t_b, out_b = run_hermes(["-z", "Call vision_analyze exactly once on this image path: " + SHOT +
                         " - then answer in one sentence: what is on screen?", "-m", "gemini-3.6-flash",
                         "--provider", "gemini", "-t", "vision"])
bad = any(k in out_b.lower() for k in ("cannot be found", "not found", "does not exist", "error"))
visual = any(k in out_b.lower() for k in ("screen", "window", "terminal", "app", "desktop", "clock", "jarvis"))
skipped_b = classify(out_b)
record("eyes: describe the screen", len(out_b) > 20 and not bad and visual, t_b,
       out_b.replace("\n", " "), skip=skipped_b)

print("\nC. hands specialist (one shell command)")
t_c, out_c = run_hermes(["-z", "Run exactly one shell command: df -h /c . Then reply with only the free-space figure in one short line."])
record("hands: run a command", "G" in out_c or "%" in out_c, t_c, out_c.replace("\n", " ")[:70])

print("\nD. fan-out: B and C in parallel")
t0 = time.time()
with ThreadPoolExecutor(max_workers=2) as ex:
    fb = ex.submit(run_hermes, ["-z", "Call vision_analyze exactly once on this image path: " + SHOT +
                                " - then answer in one sentence: what is on screen?", "-m", "gemini-3.6-flash",
                                "--provider", "gemini", "-t", "vision"])
    fc = ex.submit(run_hermes, ["-z", "Run exactly one shell command: df -h /c . Then reply with only the free-space figure in one short line."])
    rb, rc = fb.result(), fc.result()
wall = round(time.time() - t0, 1)
seq = round(t_b + t_c, 1)
saved = round(seq - wall, 1)
record("parallel fan-out beats sequential", wall < seq, wall,
       "sequential would be %.1fs, saved %.1fs" % (seq, saved))

print("\nE. three Jarvis instances in parallel, separate sessions")
prompts = [("p1", "what is 21*2? just the number"),
           ("p2", "what is 22*2? just the number"),
           ("p3", "what is 23*2? just the number")]
with ThreadPoolExecutor(max_workers=3) as ex:
    futs = {name: ex.submit(run_jarvis, q, name) for name, q in prompts}
    got = {name: f.result() for name, f in futs.items()}
answers = {}
for name, (secs, out) in got.items():
    nums = [w for w in out.replace("\n", " ").split() if w.strip(".").isdigit()]
    answers[name] = nums[-1] if nums else "?"
expect = {"p1": "42", "p2": "44", "p3": "46"}
ok = all(answers[k] == expect[k] for k in expect)
sess_files = sorted(os.listdir(os.path.join(CWD, "data", "sessions"))) if os.path.isdir(os.path.join(CWD, "data", "sessions")) else []
ids = set()
for name in expect:
    f = os.path.join(CWD, "data", "sessions", name + ".json")
    if os.path.exists(f):
        try:
            ids.add(json.load(open(f))["sessionId"])
        except Exception:
            pass
record("3 parallel instances stay isolated", ok and len(ids) == 3,
       max(v[0] for v in got.values()), "answers %s, %d distinct sessions" % (answers, len(ids)))

print("\nF. manager alone, same style of question (baseline)")
t_f, out_f = run_jarvis("what is 24*2? just the number", "baseline")
record("manager alone answers", out_f.rstrip().endswith("48"), t_f, out_f.splitlines()[-1][:70] if out_f else "")

print("\n" + "=" * 78)
passed = sum(1 for r in results if r[1])
print("RESULT: %d/%d pass" % (passed, len(results)))
for name, ok, secs, note in results:
    print("  [%s] %-42s %5.1fs" % ("x" if ok else " ", name, secs))
