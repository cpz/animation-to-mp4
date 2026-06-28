# animation-to-mp4

A Claude Code skill that renders a claude.ai/design timeline animation (the
Stage/Sprite runtime in `animations.jsx` plus a scene `.jsx`, usually wired up
through a `.dc.html`) to a real `.mp4` file, with any procedural Web Audio
soundtrack baked into the audio track.

## Why

These animations run in a browser. A `Stage` draws the scene into an
`<svg><foreignObject>` and advances a playhead; the scene reads that playhead to
position everything. The canvas can export video by serializing the SVG frame by
frame, but that path only carries audio from a `VideoSprite`. A soundtrack built
with the Web Audio API plays live yet is invisible to the SVG export, so the
exported clip comes out silent.

This skill renders the picture and the sound on two faithful paths and joins
them:

- **Video** drives the Stage's own per-frame seek protocol in headless Chrome
  and screenshots each pinned frame, so every frame matches the live preview.
- **Audio** plays the timeline once in real time with a tap spliced into the
  `AudioContext` output, capturing whatever the soundtrack actually produces.
  This works for any Web Audio score regardless of how it is built.
- **Mux** uses `ffmpeg` to produce H.264 + AAC.

## Requirements

- Node 18+ and `ffmpeg` on `PATH`.
- A Chrome or Chromium the renderer can find. It checks
  `PUPPETEER_EXECUTABLE_PATH`, then the puppeteer download cache, then a system
  Chrome/Edge. If you have none, download one with
  `npx @puppeteer/browsers install chrome`.

## Install

Through the Claude Code plugin marketplace:

```
/plugin marketplace add cpz/animation-to-mp4
/plugin install animation-to-mp4@animation-to-mp4
```

Or drop the folder into your skills directory directly:

```sh
git clone https://github.com/cpz/animation-to-mp4 ~/.claude/skills/animation-to-mp4
cd ~/.claude/skills/animation-to-mp4/scripts && npm install
```

On Windows the skills directory is `%USERPROFILE%\.claude\skills`.

Either way, install the script deps once (`cd scripts && npm install`); a
marketplace clone does not carry `node_modules`.

Claude Code picks the skill up automatically and triggers it when you ask to
convert or export a design animation to video. You can also run the renderer by
hand.

## Usage

```sh
node scripts/render.mjs --input <dir-or-.dc.html> --out promo.mp4
```

Flags (all optional):

| flag | meaning |
| --- | --- |
| `--component <Name>` | global component to mount, if auto-detection misses it |
| `--quality <tier>` | `original`, `1080p`, or `4k` output resolution (default `original`) |
| `--fps <n>` | frames per second, e.g. `24` `30` `60` (default: the scene's `<Stage fps>`, else 30) |
| `--preset <name>` | output canvas: `source`, `youtube`, `x`, `stories`, `reels`, `tiktok`, `square`, `post`, `telegram`, `portrait`, or an aspect alias like `9:16` (default `source`) |
| `--audio auto\|off` | capture the soundtrack if present (default `auto`) |
| `--bg <color>` | pad colour for a reshaped canvas (default: the scene background) |
| `--scale <n>` | force capture device pixel ratio (default: derived from quality) |
| `--crf <n>` | force x264 quality, lower is better and bigger (default: from quality) |
| `--chrome <path>` | explicit Chrome/Chromium executable |
| `--keep` | leave the temp work dir (frames, captured audio) for inspection |

Width, height, and duration come from the mounted Stage, so you do not pass
those. `--quality` sets the output resolution (4k is captured at a higher pixel
ratio so it stays sharp), and `--preset` reshapes the canvas to a platform aspect
by fitting the native frame and padding with the scene background. The renderer
prints a summary when it finishes.

If the project holds more than one HTML document (common in a design project
where only one file is the animation), pass the specific animation file rather
than the directory. The renderer refuses to guess when several are present.

## Verify the output

```sh
ffprobe -of default=noprint_wrappers=1 \
  -show_entries format=duration:stream=codec_type,codec_name,width,height promo.mp4
ffmpeg -i promo.mp4 -af volumedetect -f null -   # real mean_volume, not -inf
```

## How it works in more detail

See [`references/runtime-internals.md`](references/runtime-internals.md) for the
Stage seek protocol, the export data-attributes, the audio-tap technique, and a
worked example of rendering a deterministic score offline at sample accuracy.

## License

MIT. See [LICENSE](LICENSE).
