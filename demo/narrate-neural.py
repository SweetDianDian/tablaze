#!/usr/bin/env python3
"""Generate and validate narration with the Microsoft Edge neural TTS service.

Install edge-tts==7.2.8 in a virtual environment. Supply an FFmpeg executable
with --ffmpeg or put it on PATH. This script sends only each narration text to
the online service. It never plays audio and does not open a browser.

The input is an array of {index, id, text}. Voice and speaking rate are selected
explicitly by CLI arguments, so legacy macOS voice/rate fields are ignored.
An optional demo report checks both the next narration start and presentation
hold budgets. Without a timing report, this also supports new recordings.
"""

import argparse
import array
import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import wave
from datetime import datetime, timezone

EDGE_TTS_VERSION = "7.2.8"
SERVICE = "Microsoft Edge online neural TTS"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def timing_budgets(report, rows, margin, hold_offset):
    if report is None:
        return {}
    previous = report.get("video_encoding", {}).get("narration", [])
    holds = report.get("presentation_holds", [])
    if not previous:
        raise ValueError("Timing report has no video_encoding.narration entries")
    ids = [row["id"] for row in rows]
    if ids != [row["id"] for row in previous]:
        raise ValueError("Script and timing report IDs must match in order")
    if holds and len(holds) != len(previous):
        raise ValueError("Presentation holds and narration must have equal lengths")
    video_end = report.get("video", {}).get("duration_seconds")
    if video_end is None:
        raise ValueError("Timing report is missing video.duration_seconds")
    budgets = {}
    for i, row in enumerate(previous):
        start = float(row["start_seconds"])
        end = float(previous[i + 1]["start_seconds"]) if i + 1 < len(previous) else float(video_end)
        limit = end - start - margin
        item = {"start_seconds": start, "next_start_or_end_seconds": end}
        if holds:
            hold_available = float(holds[i]["duration_ms"]) / 1000 - hold_offset
            item["hold_available_seconds"] = hold_available
            limit = min(limit, hold_available - margin)
        if limit <= 0:
            raise ValueError("Nonpositive narration budget for " + row["id"])
        item["max_duration_seconds"] = round(limit, 6)
        budgets[row["id"]] = item
    return budgets


def decode_and_measure(ffmpeg, source, destination):
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(source), "-map_metadata", "-1", "-ac", "1", "-ar", "24000",
        "-c:a", "pcm_s16le", "-fflags", "+bitexact", str(destination),
    ], check=True, capture_output=True, timeout=60)
    with wave.open(str(destination), "rb") as reader:
        frames, frequency = reader.getnframes(), reader.getframerate()
        channels, width = reader.getnchannels(), reader.getsampwidth()
        pcm = reader.readframes(frames)
    if channels != 1 or width != 2 or not pcm:
        raise ValueError("Decoded audio is empty or not mono 16-bit PCM")
    samples = array.array("h", pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(value) for value in samples)
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    nonzero = sum(value != 0 for value in samples) / len(samples)
    if peak <= 100 or rms <= 25 or nonzero < 0.1:
        raise ValueError("Decoded audio failed the non-silence check")
    return {
        "duration_seconds": round(frames / frequency, 6),
        "decoded_frames": frames, "sample_rate": frequency,
        "channels": channels, "sample_width_bytes": width,
        "peak": peak, "peak_dbfs": round(20 * math.log10(peak / 32768), 3),
        "rms": round(rms, 3), "rms_dbfs": round(20 * math.log10(rms / 32768), 3),
        "nonzero_ratio": round(nonzero, 6),
        "clipped_sample_ratio": round(sum(abs(value) >= 32767 for value in samples) / len(samples), 8),
        "decoded_pcm_sha256": hashlib.sha256(pcm).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--script", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--voice", default="en-US-AndrewMultilingualNeural")
    parser.add_argument("--rate", default="-3%", help="Use --rate=-3%% for negative values")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"))
    parser.add_argument("--timing-report", type=Path)
    parser.add_argument("--margin", type=float, default=0.4)
    parser.add_argument("--hold-offset", type=float, default=0.25)
    parser.add_argument("--reuse", action="store_true", help="Reuse audio only when text, voice, rate and TTS version match")
    args = parser.parse_args()
    version = importlib.metadata.version("edge-tts")
    if version != EDGE_TTS_VERSION:
        raise ValueError("Install edge-tts==" + EDGE_TTS_VERSION + "; found " + version)
    if not re.fullmatch(r"[+-]\d+%", args.rate):
        raise ValueError("Rate must look like +0% or -3%")
    if args.margin < 0 or args.hold_offset < 0:
        raise ValueError("Timing margin and hold offset cannot be negative")
    rows = json.loads(args.script.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("Script must be a nonempty JSON array")
    ids = set()
    for i, row in enumerate(rows):
        if row.get("index", i) != i or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", row.get("id", "")):
            raise ValueError("Each row needs an ordered index and safe lowercase ID")
        if row["id"] in ids or not isinstance(row.get("text"), str) or not row["text"].strip():
            raise ValueError("IDs must be unique and text must be nonempty")
        ids.add(row["id"])
    report = json.loads(args.timing_report.read_text(encoding="utf-8")) if args.timing_report else None
    budgets = timing_budgets(report, rows, args.margin, args.hold_offset)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    import edge_tts
    voices = asyncio.run(edge_tts.list_voices(proxy=args.proxy))
    selected = next((voice for voice in voices if voice["ShortName"] == args.voice), None)
    if selected is None:
        raise ValueError("Requested voice is absent from the live voice catalog")
    write_json(out / "voice-live.json", selected)
    manifest, measurements, errors = [], [], []
    for i, row in enumerate(rows):
        stem = "{:02d}-{}".format(i + 1, row["id"])
        txt, mp3, wav = (out / (stem + suffix) for suffix in (".txt", ".mp3", ".wav"))
        receipt = out / (stem + ".synthesis.json")
        request = {"text": row["text"], "voice": args.voice, "rate": args.rate, "edge_tts_version": version}
        cached = args.reuse and mp3.is_file() and receipt.is_file() and json.loads(receipt.read_text(encoding="utf-8")) == request
        txt.write_text(row["text"] + "\n", encoding="utf-8")
        if not cached:
            command = [sys.executable, "-m", "edge_tts", "--voice", args.voice, "--rate=" + args.rate,
                       "--file", str(txt), "--write-media", str(mp3), "--write-subtitles", str(out / (stem + ".srt"))]
            if args.proxy:
                command.extend(["--proxy", args.proxy])
            subprocess.run(command, check=True, capture_output=True, timeout=120)
            write_json(receipt, request)
        measure = decode_and_measure(args.ffmpeg, mp3, wav)
        duration = measure["duration_seconds"]
        item = {
            "index": i, "id": row["id"], "text": row["text"], "voice": args.voice,
            "language": selected.get("Locale"),
            "gender": selected.get("Gender"), "rate": args.rate, "file": str(wav),
            "duration_seconds": duration, "sha256": sha256(wav),
            "service": SERVICE, "synthesis": SERVICE, "edge_tts_version": version,
            "source_file": str(mp3), "source_sha256": sha256(mp3),
        }
        if isinstance(row.get("text_zh"), str):
            item["text_zh"] = row["text_zh"]
        if row["id"] in budgets:
            budget = budgets[row["id"]]
            item.update(budget)
            item["remaining_before_next_seconds"] = round(budget["next_start_or_end_seconds"] - budget["start_seconds"] - duration, 6)
            if "hold_available_seconds" in budget:
                item["remaining_in_hold_seconds"] = round(budget["hold_available_seconds"] - duration, 6)
            item["timing_passed"] = duration <= budget["max_duration_seconds"]
            if not item["timing_passed"]:
                errors.append(row["id"] + " exceeds its audio budget; shorten the script rather than accelerating it")
        manifest.append(item)
        measurements.append({"index": i, "id": row["id"], "file": str(wav), **measure})
        print("{:02d} {}: {:.3f}s, RMS {:.1f}dBFS{}".format(i + 1, row["id"], duration, measure["rms_dbfs"],
              ", remaining in hold {:.3f}s".format(item["remaining_in_hold_seconds"]) if "remaining_in_hold_seconds" in item else ""), flush=True)
    write_json(out / "narration.json", manifest)
    write_json(out / "validation.json", measurements)
    ffmpeg_version = subprocess.run([args.ffmpeg, "-version"], check=True, capture_output=True, text=True).stdout.splitlines()[0]
    write_json(out / "generation.json", {
        "service": SERVICE, "edge_tts_version": version, "python_version": sys.version.split()[0],
        "ffmpeg_version": ffmpeg_version, "voice": selected, "rate": args.rate,
        "generated_at": datetime.now(timezone.utc).isoformat(), "proxy_configured": bool(args.proxy),
        "script_sha256": sha256(args.script), "timing_report_sha256": sha256(args.timing_report) if args.timing_report else None,
        "margin_seconds": args.margin, "hold_offset_seconds": args.hold_offset,
        "segments": len(manifest), "total_audio_seconds": round(sum(row["duration_seconds"] for row in manifest), 6),
        "validation_passed": not errors, "errors": errors,
    })
    if errors:
        raise ValueError("; ".join(errors))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Do not print command arguments: they may contain proxy credentials.
        print("Narration subprocess failed with exit code {}".format(error.returncode), file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        # TimeoutExpired includes command arguments, which may contain credentials.
        print("Narration subprocess exceeded its time limit", file=sys.stderr)
        sys.exit(1)
