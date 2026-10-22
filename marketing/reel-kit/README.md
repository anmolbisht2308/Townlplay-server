# Reel kit

Makes TownPlay Instagram Reels (1080×1920, 30 fps, H.264 + AAC) from scripts in `../content/plan.json`.

```
cd marketing/reel-kit
npm install                               # playwright-core
pip install numpy pillow imageio-ffmpeg   # once
python3 make_reel.py d05 --preview        # contact sheet of a few frames
python3 make_reel.py d05                  # -> ../instagram/reel-d05.mp4 + reel-d05-cover.jpg
```

- `reel.html`: the four formats (`chat`, `list`, `versus`, `pitch`). Timing comes from text length, so
  every line stays on screen long enough to read.
- `render.mjs`: renders a spec to PNG frames with Chromium (`CHROMIUM_PATH`, default `/opt/pw-browsers/chromium`).
- `make_reel.py`: frames + background music (`music.mp3`, original AI-generated track, so posts set the
  Instagram AI label) + message/tick sounds → MP4 and cover.
- `../content/build_plan.py` generated the first 28 entries; edit `plan.json` directly after that.

Older one-off templates: `chat-template.html`, `chat-concert.html`, `capture.mjs`.
