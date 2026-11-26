"""Transcribe an audio/video file with faster-whisper. Prints one JSON object.

    python transcribe.py <file> [model-size]

Model sizes: tiny, base, small, medium, large-v3. Default base (about 74 MB,
CPU, int8). The model is cached under JARVIS_MODELS (default
D:/Programs/jarvis-tools/models) so it is downloaded once.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: transcribe.py <file> [model]"}))
        return 2
    path = sys.argv[1]
    size = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("JARVIS_WHISPER_MODEL", "base")
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "no such file: %s" % path}))
        return 2
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "faster-whisper missing: %s" % e}))
        return 3

    root = os.environ.get("JARVIS_MODELS", "D:/Programs/jarvis-tools/models")
    try:
        os.makedirs(root, exist_ok=True)
    except Exception:  # noqa: BLE001
        root = None
    try:
        model = WhisperModel(size, device="cpu", compute_type="int8", download_root=root)
        segments, info = model.transcribe(path, language="en", vad_filter=True, beam_size=1)
        parts = [s.text.strip() for s in segments if s.text and s.text.strip()]
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        return 1

    text = " ".join(" ".join(parts).split())
    print(json.dumps({
        "ok": True,
        "text": text,
        "chars": len(text),
        "language": getattr(info, "language", "en"),
        "duration": round(float(getattr(info, "duration", 0) or 0), 1),
        "model": size,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
