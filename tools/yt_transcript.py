"""Fetch a YouTube transcript. Prints one JSON object.

    python yt_transcript.py <url-or-id>

Uses youtube-transcript-api when the video has captions; exits non-zero with a
short reason when it does not (private, age-gated, no captions, blocked).
"""
import json
import re
import sys


def video_id(value: str) -> str:
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})", value or "")
    return m.group(1) if m else (value or "").strip()


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: yt_transcript.py <url>"}))
        return 2
    vid = video_id(sys.argv[1])
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "youtube-transcript-api missing: %s" % e}))
        return 3

    api = YouTubeTranscriptApi()
    try:
        if hasattr(api, "fetch"):
            fetched = api.fetch(vid, languages=["en", "en-US", "en-GB"])
            text = " ".join(getattr(s, "text", "") for s in fetched)
            lang = getattr(fetched, "language_code", "en")
        else:  # older releases
            data = api.get_transcript(vid, languages=["en", "en-US", "en-GB"])
            text = " ".join(x.get("text", "") for x in data)
            lang = "en"
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        return 1

    text = " ".join(text.split())
    print(json.dumps({"ok": True, "id": vid, "lang": lang, "chars": len(text), "text": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
