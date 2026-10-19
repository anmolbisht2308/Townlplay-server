# Reel kit

Tools for making TownPlay Instagram Reels without camera footage.

- `chat-template.html`: animated group-chat Reel (1080×1920). Edit the caption, header and the `S` message list; `render(t)` draws frame t.
- `capture.mjs`: `node capture.mjs <html> <outDir> <fps> <seconds>` renders PNG frames (needs `playwright-core` and Chromium).
- `music.mp3`: original background track (AI-generated, so posts set Instagram's AI label).
- Encode: frames + music at ~30% volume + message pops → H.264 1080×1920 30 fps, AAC 48 kHz, `-movflags +faststart`.

Finished Reels and covers live in `../instagram/`.
