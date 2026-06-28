---
name: animation-to-mp4
description: >-
  Render a claude.ai/design timeline animation (the Stage/Sprite runtime in
  animations.jsx plus a scene .jsx, usually wired up through a .dc.html) to a
  real .mp4 video file, with any procedural Web Audio soundtrack baked into the
  audio track. Use this whenever someone wants to convert, export, render, or
  "save as mp4/video/movie" a design-canvas animation, motion-graphics film,
  promo, explainer, or animated scene built on the Stage/Sprite engine, and
  ESPECIALLY when the animation has sound that needs to come along, because the
  canvas's own Share -> Export -> Video drops Web Audio. Trigger on phrases like
  "convert this animation to mp4", "export the promo as a video", "render the
  film with the sound", or "turn the .dc.html into a movie".
---

# Animation to MP4

Turn a Stage/Sprite timeline animation into a self-contained `.mp4`, soundtrack
included.

## Why this exists

These animations run in a browser: `animations.jsx` defines a `Stage` that draws
the scene into an `<svg><foreignObject>` and advances a playhead, and the scene
`.jsx` reads that playhead to position everything. The canvas can export video by
serializing the SVG frame by frame, but that fast path only carries audio from a
`VideoSprite`. A procedural soundtrack built with the Web Audio API (oscillators,
gains, an `AudioContext`) plays live but is invisible to the SVG export, so the
exported clip comes out silent.

This skill renders the picture and the sound on two faithful paths and muxes them:

- **Video**: drive the Stage's own seek protocol frame by frame in headless
  Chrome (one pinned frame per screenshot), so every frame matches the live
  preview exactly.
- **Audio**: play the timeline once in real time and tap the `AudioContext`
  output, capturing whatever the soundtrack actually produces. This works for any
  Web Audio score regardless of how it is built.
- **Mux**: `ffmpeg` joins the PNG frames and the captured audio into H.264 + AAC.

## Prerequisites

- **Node** and **ffmpeg** on PATH.
- A **Chrome/Chromium** the script can find: it checks
  `PUPPETEER_EXECUTABLE_PATH`, then the puppeteer download cache, then a system
  Chrome/Edge. If none is found it prints how to fix it.
- One-time dependency install. The script lives in `scripts/`; if `node_modules`
  is missing there, run it once:

  ```
  cd <this-skill>/scripts && npm install
  ```

  (`render.mjs` also offers to do this for you and stops with a clear message if
  it cannot.)

## Inputs you need to identify

Point the renderer at the animation. Two shapes are common:

1. A **`.dc.html`** file. It names the import order and the global component, e.g.
   `<x-import component-from-global-scope="HopFoPromo" from="./animations.jsx ./hopfo-promo.jsx">`.
   Pass the `.dc.html` and the renderer reads the rest.
2. A **directory** holding `animations.jsx` plus one scene `.jsx`. The renderer
   loads `animations.jsx` first (the runtime), then the scene, and mounts the
   component the scene assigns to `window` (`window.MyScene = MyScene`).

If the project lives in a claude.ai/design project rather than on disk, pull the
files down first with the `claude_design` / DesignSync MCP (`get_file` each of
`animations.jsx`, the scene `.jsx`, and the `.dc.html`) into a local folder, then
render that folder.

### Picking the right file when there are several HTML documents

A design project routinely holds more than one `.dc.html` (a dashboard, a card,
an NFT mock, and the promo, say) and only one of them is the animation you want
to render. Do not guess. When the target directory contains more than one
`.html`/`.dc.html`, ask the user which document is the animation with
`AskUserQuestion` (one option per HTML file, labelled by filename), then pass the
chosen file directly as `--input`. The renderer enforces the same rule: handed a
directory with multiple HTML files it stops and lists them rather than picking
one, so always resolve the choice first and pass the specific file.

## Run it

```
node <this-skill>/scripts/render.mjs --input <dir-or-.dc.html> --out <path.mp4>
```

Useful flags (all optional):

- `--component <Name>` global component to mount, if auto-detection misses it.
- `--fps <n>` frames per second (default 30). The Stage's own `fps` prop is the
  right value; the renderer tries to read it from the scene and falls back to 30.
- `--audio auto|off` default `auto` (capture if the scene makes any sound).
- `--scale <n>` device pixel ratio, e.g. `2` for a crisp 2x render (default 1).
- `--crf <n>` x264 quality, lower is better/bigger (default 18).
- `--keep` leave the temp work dir (frames, captured audio) for inspection.

The renderer auto-detects width, height, and duration from the mounted Stage, so
you do not pass those. It prints a summary at the end (dimensions, fps, duration,
whether audio was captured, output path and size).

## After rendering

Verify before declaring success, because a foreignObject capture or an audio tap
can fail quietly:

- `ffprobe -of default=noprint_wrappers=1 -show_entries format=duration:stream=codec_type,codec_name,width,height <out.mp4>`
  confirms the duration, an `h264` video stream at the right size, and an `aac`
  audio stream if sound was expected.
- Read one mid-timeline frame the script can dump (`--keep`) to confirm it is not
  black. A black frame is a capture artifact, not a render bug; see
  `references/runtime-internals.md`.
- If audio was expected, `ffmpeg -i <out.mp4> -af volumedetect -f null -` should
  report a real `mean_volume`, not `-inf dB`.

## When the soundtrack must be exact

Real-time capture is general but rides on wall-clock playback. When a score is a
pure deterministic function of the timeline (a fixed event list scheduled off the
playhead) you can re-render it sample-accurate and glitch-free with an
`OfflineAudioContext` instead. That path is scene-specific (you mirror the
scene's own audio graph), so reach for it only when you need maximum fidelity.
`references/runtime-internals.md` documents the Stage seek protocol, the export
data-attributes, the audio-tap technique, and a worked offline-render example.
