"""Build one TownPlay Reel (1080x1920 H.264 MP4 + JPG cover) from a plan entry.

Usage:
  python3 make_reel.py <entry-id> [--out DIR] [--preview]

Reads marketing/content/plan.json, renders the entry's `spec` with render.mjs,
adds sound (background music + message/tick sounds) and writes
<out>/reel-<id>.mp4 and <out>/reel-<id>-cover.jpg (default out: marketing/instagram).
--preview renders a contact sheet of a few frames instead of the full video.

Needs: node + playwright-core (npm install in this folder), Chromium, Python with
numpy + Pillow, and ffmpeg (FFMPEG env var, or the imageio-ffmpeg package).
"""
import json
import os
import subprocess
import sys
import tempfile
import wave
import zlib
from pathlib import Path

import numpy as np

KIT = Path(__file__).resolve().parent
PLAN = KIT.parent / "content" / "plan.json"
SR = 48000
FPS = 30


def ffmpeg_bin():
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def find_entry(entry_id):
    plan = json.loads(PLAN.read_text())
    for e in plan["entries"]:
        if e["id"] == entry_id:
            return e
    sys.exit(f"entry {entry_id} not found in {PLAN}")


def render(spec, frames_dir, only=None):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(spec, f)
        spec_path = f.name
    cmd = ["node", str(KIT / "render.mjs"), spec_path, str(frames_dir), str(FPS)]
    if only:
        cmd.append(",".join(map(str, only)))
    res = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return json.loads(res.stdout.strip().splitlines()[-1])


def sfx_track(events, duration, path):
    buf = np.zeros(int(SR * (duration + 0.5)))

    def add(t, sig):
        i = int(t * SR)
        buf[i : i + len(sig)] += sig[: max(0, len(buf) - i)]

    for ev in events:
        kind, t = ev["kind"], max(0.03, ev["t"])
        if kind in ("in", "out", "tick"):
            f = {"in": 1250, "out": 900, "tick": 760}[kind]
            n = int(0.09 * SR)
            tt = np.arange(n) / SR
            amp = 0.5 if kind != "tick" else 0.35
            add(t, np.sin(2 * np.pi * (f + 400 * np.exp(-tt * 60)) * tt) * np.exp(-tt * 45) * amp)
        elif kind == "whoosh":
            n = int(0.4 * SR)
            tt = np.arange(n) / SR
            rng = np.random.default_rng(int(t * 1000))
            add(t, rng.standard_normal(n) * np.exp(-tt * 9) * 0.08)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(buf, -1, 1) * 32767).astype(np.int16).tobytes())


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    entry = find_entry(args[0])
    out_dir = Path(args[args.index("--out") + 1]) if "--out" in args else KIT.parent / "instagram"
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"reel-{entry['id']}-"))
    frames = work / "frames"

    if "--preview" in args:
        meta = render(entry["spec"], frames, only=[0])
        n = meta["frames"]
        picks = sorted({0, n // 4, n // 2, (3 * n) // 4, n - 45})
        render(entry["spec"], frames, only=picks)
        from PIL import Image

        ims = [Image.open(frames / f"f{i:04d}.png").resize((300, 533)) for i in picks]
        sheet = Image.new("RGB", (300 * len(ims), 533))
        for i, im in enumerate(ims):
            sheet.paste(im, (i * 300, 0))
        dest = out_dir / f"preview-{entry['id']}.png"
        sheet.save(dest)
        print(json.dumps({"preview": str(dest), "duration": meta["duration"]}))
        return

    meta = render(entry["spec"], frames)
    dur = meta["duration"]
    sfx = work / "sfx.wav"
    sfx_track(meta["events"], dur, sfx)
    music_start = entry["spec"].get("musicStart", zlib.crc32(entry["id"].encode()) % 50)
    mp4 = out_dir / f"reel-{entry['id']}.mp4"
    ff = ffmpeg_bin()
    fade = max(0.0, dur - 1.0)
    subprocess.run(
        [ff, "-hide_banner", "-loglevel", "error", "-y",
         "-framerate", str(FPS), "-i", str(frames / "f%04d.png"),
         "-ss", str(music_start), "-t", str(dur), "-i", str(KIT / "music.mp3"),
         "-i", str(sfx),
         "-filter_complex",
         f"[1:a]volume=0.30,afade=t=in:d=0.05,afade=t=out:st={fade}:d=1[m];"
         "[2:a]aresample=48000,pan=stereo|c0=c0|c1=c0,volume=1.6[p];"
         "[m][p]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]",
         "-map", "0:v", "-map", "[a]",
         "-c:v", "libx264", "-profile:v", "high", "-level", "4.2", "-preset", "slow", "-crf", "14",
         "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", "60",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(mp4)],
        check=True,
    )
    cover = out_dir / f"reel-{entry['id']}-cover.jpg"
    cover_at = entry["spec"].get("coverAt", max(0.0, dur - 4.2))
    subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-ss", str(cover_at), "-i", str(mp4),
                    "-frames:v", "1", "-q:v", "2", str(cover)], check=True)
    print(json.dumps({"mp4": str(mp4), "cover": str(cover), "duration": dur}))


if __name__ == "__main__":
    main()
