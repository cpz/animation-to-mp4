# Stage/Sprite runtime internals

Background for when the renderer needs adjusting or a capture misbehaves. You do
not need to read this for a normal render.

## The runtime

`animations.jsx` puts a small timeline engine on `window`: `Stage`, `Sprite`,
`useTime`, `useTimeline`, `useSprite`, `Easing`, `interpolate`, `animate`,
`clamp`, and a few sprite primitives. A scene `.jsx` reads those globals and
returns a tree rooted at `<Stage>`.

`Stage` draws the scene into an `<svg><foreignObject>` and owns a playhead
(`time`, in seconds). Every visual is a pure function of that playhead, which is
exactly what makes deterministic frame capture possible: set the playhead, read
the frame.

Key facts the renderer leans on:

- The canvas element is `svg[data-om-exportable-video-with-duration-secs]`. The
  attribute value is the clip duration in seconds. The svg `width`/`height`
  attributes are the render dimensions.
- The Stage auto-scales the svg to the viewport with a CSS `transform: scale()`.
  For a 1:1 capture the renderer overrides that to `transform: none` and pins the
  svg to the top-left, then screenshots a `width x height` clip from `(0,0)`.
- `[data-omelette-chrome]` marks the playback bar; the renderer hides it.
- `data-om-fonts-inlined="true"` is set once the Stage has inlined `@font-face`
  rules into the svg. Worth waiting for, with a short timeout fallback.

## The seek protocol (video)

The Stage listens on the svg for a custom event and pauses + jumps the playhead:

```js
svg.dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', { detail: { time: t } }));
```

So one frame is: dispatch the seek, wait for React to commit and the compositor
to paint (a few `requestAnimationFrame` ticks is reliable), screenshot. Repeat
for `t = 0, 1/fps, 2/fps, ...`, `round(duration*fps)` frames total.

The Stage's `fps` prop is not exposed on the DOM, so the renderer reads a
`fps={N}` hint from the scene source and falls back to 30. Pass `--fps` to be
explicit.

Black frame? In headless Chrome, full-page compositor screenshots (what
puppeteer's `page.screenshot` does) rasterize `foreignObject` correctly,
including gradients, blur, and blend modes. The "captures may come back black"
warning in `animations.jsx` is about DOM-rerender screenshot tools that unwrap
the svg, not pixel capture. If you do get black frames, check that the svg
transform was actually neutralized and that fonts/network finished loading.

## The audio gap and the tap (sound)

A procedural soundtrack is a React component (often named `Soundtrack`) that
builds a Web Audio graph: `new AudioContext()`, oscillators/gains/filters,
scheduled off the shared playhead, mixed into `ctx.destination`. It plays live.

The canvas's own video export serializes the svg frame by frame and only mixes
audio from a `VideoSprite` (a real `<video>`), so a Web Audio score is silent in
that export. That is the whole reason this skill exists.

The general fix is to capture what the graph actually plays. Before any page
script runs, replace `AudioContext`/`webkitAudioContext` with a wrapper that, on
construction, splices a gain node in front of the real destination and fans it
out to a `MediaStreamAudioDestinationNode`:

```js
const Real = window.AudioContext || window.webkitAudioContext;
function Tapped() {
  const ac = new Real();
  const realDest = ac.destination;
  const tap = ac.createGain();
  const msd = ac.createMediaStreamDestination();
  tap.connect(realDest); tap.connect(msd);
  Object.defineProperty(ac, 'destination', { value: tap, configurable: true });
  window.__tapStream = msd.stream;
  if (ac.resume) ac.resume();
  return ac;
}
window.AudioContext = window.webkitAudioContext = Tapped;
```

Because a constructor that returns an object makes `new` yield that object, the
app's `new AudioContext()` transparently gets the tapped instance, and
`instanceof` still holds. Then play the timeline from `t=0` (seek to 0, dispatch
a Space keydown to start playback) while a `MediaRecorder` records
`window.__tapStream`. Launch Chrome with `--autoplay-policy=no-user-gesture-required`
so the context is allowed to run, and `--mute-audio` so nothing comes out of the
host speakers while it records.

This is real-time: an 18s film takes ~18s to capture. It is general because it
intercepts at the destination, independent of how the score is built.

## Sample-accurate audio (optional, higher fidelity)

When a score is a pure deterministic function of the timeline (a fixed list of
events scheduled at absolute times, like a `buildScore()` that returns
`{ t, fn }` entries), you can re-render it offline, sample-accurate and free of
real-time jitter, by mirroring the scene's audio graph into an
`OfflineAudioContext` and replaying the event list with `t0 = 0`:

```js
const oac = new OfflineAudioContext(2, Math.ceil(48000 * duration), 48000);
// rebuild the same master -> compressor -> destination chain, the same busses,
// the same shared noise/reverb buffers the scene's Soundtrack creates,
// then: for (const e of SCORE) e.fn(oac, busses);
const buf = await oac.startRendering();  // -> encode WAV
```

This means copying the scene's voice functions and graph construction, so it is
scene-specific rather than general. Use it when a score must be exact (no
dropouts, perfect loop point). The `--audio` flag in `render.mjs` uses the
general live tap; for the offline path, render the WAV separately and pass it to
the same ffmpeg mux step in place of the captured webm.

## The mux

```
ffmpeg -y -framerate <fps> -start_number 0 -i frames/f_%05d.png \
  -i audio.webm -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -vf "scale='trunc(iw/2)*2':'trunc(ih/2)*2'" \
  -movflags +faststart -c:a aac -b:a 192k -shortest out.mp4
```

The captured audio runs a hair longer than the picture (a small tail past the
last frame); `-shortest` trims to the exact video length. The even-dimension
scale filter keeps `yuv420p` happy for odd-sized stages. Drop the audio inputs
for a silent render.
