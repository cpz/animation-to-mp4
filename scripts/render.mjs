#!/usr/bin/env node
// Render a Stage/Sprite timeline animation to MP4, soundtrack included.
//
// Picture is captured deterministically by driving the Stage's own per-frame
// seek protocol and screenshotting each pinned frame. Sound is captured by
// playing the timeline once in real time with a tap spliced into the
// AudioContext output, so any Web Audio score comes along even though the
// canvas's SVG export would drop it. ffmpeg muxes the two.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── deps ────────────────────────────────────────────────────────────────────
let puppeteer, Babel;
try {
  puppeteer = require('puppeteer-core');
  Babel = require('@babel/standalone');
} catch {
  console.error('Dependencies are not installed. Run once:\n  cd "' + HERE + '" && npm install');
  process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────--
function parseArgs(argv) {
  const a = { fps: null, audio: 'auto', scale: null, crf: null, quality: 'original', preset: 'source', bg: null, keep: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--input' || k === '-i') { a.input = v; i++; }
    else if (k === '--out' || k === '-o') { a.out = v; i++; }
    else if (k === '--component' || k === '-c') { a.component = v; i++; }
    else if (k === '--fps') { a.fps = +v; i++; }
    else if (k === '--audio') { a.audio = v; i++; }
    else if (k === '--scale') { a.scale = +v; i++; }
    else if (k === '--crf') { a.crf = +v; i++; }
    else if (k === '--quality' || k === '-q') { a.quality = (v || '').toLowerCase(); i++; }
    else if (k === '--preset' || k === '--format') { a.preset = (v || '').toLowerCase(); i++; }
    else if (k === '--bg') { a.bg = v; i++; }
    else if (k === '--chrome') { a.chrome = v; i++; }
    else if (k === '--keep') { a.keep = true; }
    else if (k === '--help' || k === '-h') { a.help = true; }
  }
  return a;
}
const args = parseArgs(process.argv);
if (args.help || !args.input) {
  console.log('Usage: node render.mjs --input <dir-or-.dc.html> [--out out.mp4]\n' +
    '  --component <Name>  global component to mount (auto-detected otherwise)\n' +
    '  --quality <tier>    original | 1080p | 4k (default original)\n' +
    '  --fps <n>           frames per second, e.g. 24 30 60 (default: Stage fps or 30)\n' +
    '  --preset <name>     output canvas: source | youtube | x | stories | reels |\n' +
    '                      tiktok | square | post | telegram | portrait (default source)\n' +
    '  --audio auto|off    capture the soundtrack if present (default auto)\n' +
    '  --bg <color>        pad colour for a reshaped canvas (default: scene background)\n' +
    '  --scale <n>         force device pixel ratio (default: derived from quality)\n' +
    '  --crf <n>           force x264 quality, lower is better (default: from quality)\n' +
    '  --chrome <path>     explicit Chrome/Chromium executable\n' +
    '  --keep              keep the temp work dir');
  process.exit(args.help ? 0 : 1);
}

// ── output presets ──────────────────────────────────────────────────────────
// Each platform is a target width x height. A non-source preset fits the native
// frame into this shape and pads the rest with the scene's own background, since
// a fixed Stage cannot reflow its layout to a new aspect ratio. Aspect aliases
// (16:9, 9:16, 1:1, 4:5) map to the same canvases.
const PRESETS = {
  source: null,
  youtube: [1920, 1080], x: [1920, 1080], twitter: [1920, 1080], landscape: [1920, 1080], '16:9': [1920, 1080],
  stories: [1080, 1920], reels: [1080, 1920], tiktok: [1080, 1920], shorts: [1080, 1920], vertical: [1080, 1920], '9:16': [1080, 1920],
  square: [1080, 1080], post: [1080, 1080], instagram: [1080, 1080], telegram: [1080, 1080], '1:1': [1080, 1080],
  portrait: [1080, 1350], '4:5': [1080, 1350],
};
// Quality tier -> target shorter edge (null keeps the canvas as-is) and a crf.
const QUALITY_SHORT = { original: null, '1080p': 1080, '1080': 1080, hd: 1080, '4k': 2160, '2160p': 2160, uhd: 2160 };
const QUALITY_CRF = { original: 18, '1080p': 20, '1080': 20, hd: 20, '4k': 16, '2160p': 16, uhd: 16 };

if (!(args.quality in QUALITY_SHORT)) {
  console.error('Unknown --quality "' + args.quality + '". Use original, 1080p, or 4k.');
  process.exit(2);
}
if (!(args.preset in PRESETS)) {
  console.error('Unknown --preset "' + args.preset + '". Options: ' + Object.keys(PRESETS).join(', '));
  process.exit(2);
}

const evenDim = (n) => Math.max(2, Math.round(n / 2) * 2);

// Final output size from the native dimensions, the platform preset (aspect),
// and the quality tier (which scales the shorter edge to 1080 or 2160).
function targetDims(nativeW, nativeH, preset, quality) {
  const p = PRESETS[preset];
  let w = p ? p[0] : nativeW;
  let h = p ? p[1] : nativeH;
  const short = QUALITY_SHORT[quality];
  if (short) { const k = short / Math.min(w, h); w *= k; h *= k; }
  return [evenDim(w), evenDim(h)];
}

// Turn a computed CSS colour into something ffmpeg's pad filter accepts.
function rgbToFfColor(css) {
  if (!css) return null;
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i);
  if (!m) return null;
  if (m[4] !== undefined && +m[4] === 0) return null;
  const hex = (n) => (+n).toString(16).padStart(2, '0');
  return '0x' + hex(m[1]) + hex(m[2]) + hex(m[3]);
}

// ── locate the scene files ────────────────────────────────────────────────--
// Accept either a .dc.html (which names the import order + component) or a dir
// holding animations.jsx plus one scene .jsx.
function resolveProject(input) {
  const abs = path.resolve(input);
  const stat = fs.statSync(abs);
  let dir, order = null, component = args.component;

  if (stat.isFile() && /\.html?$/i.test(abs)) {
    dir = path.dirname(abs);
    const html = fs.readFileSync(abs, 'utf8');
    const imp = html.match(/component-from-global-scope="([^"]+)"[^>]*from="([^"]+)"/i)
      || html.match(/from="([^"]+)"[^>]*component-from-global-scope="([^"]+)"/i);
    if (imp) {
      // normalize: capture component + from-list regardless of attribute order
      const comp = html.match(/component-from-global-scope="([^"]+)"/i);
      const from = html.match(/from="([^"]+)"/i);
      if (comp && !component) component = comp[1];
      if (from) order = from[1].trim().split(/\s+/).map((f) => path.resolve(dir, f));
    }
  } else if (stat.isDirectory()) {
    dir = abs;
    // A design project can hold several HTML documents (only one is the
    // animation). Don't guess: use the lone .dc.html / .html if there is one,
    // otherwise stop and let the caller name it.
    const htmls = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f));
    const dc = htmls.filter((f) => /\.dc\.html$/i.test(f));
    const candidates = dc.length ? dc : htmls;
    if (candidates.length > 1) {
      const e = new Error('Multiple HTML files in ' + dir + ':\n  ' + candidates.join('\n  ') +
        '\nName the animation explicitly, e.g. --input "' + path.join(dir, candidates[0]) + '"');
      e.code = 'AMBIGUOUS_HTML';
      throw e;
    }
    if (candidates.length === 1) return resolveProject(path.join(dir, candidates[0]));
    // no HTML in the dir: fall through to scanning .jsx files directly
  } else {
    throw new Error('input must be a directory or a .dc.html file');
  }

  if (!order) {
    const jsx = fs.readdirSync(dir).filter((f) => /\.jsx$/i.test(f)).map((f) => path.join(dir, f));
    // runtime (defines Stage) first, then the scenes
    const runtime = jsx.filter((f) => /\bStage\b/.test(fs.readFileSync(f, 'utf8')) && /Object\.assign\(window/.test(fs.readFileSync(f, 'utf8')));
    const scenes = jsx.filter((f) => !runtime.includes(f));
    order = [...runtime, ...scenes];
  }
  if (!order.length) throw new Error('no .jsx files found to render');

  // component: from --component, the .dc.html, or a `window.X = X` in the scenes
  if (!component) {
    for (const f of order) {
      const src = fs.readFileSync(f, 'utf8');
      const m = [...src.matchAll(/window\.(\w+)\s*=\s*\1\b/g)];
      // prefer a component whose definition mounts a <Stage
      const staged = m.find((x) => new RegExp('function\\s+' + x[1] + '[\\s\\S]*?<Stage').test(src));
      if (staged) { component = staged[1]; break; }
      if (m.length && !component) component = m[m.length - 1][1];
    }
  }
  if (!component) throw new Error('could not detect the component to mount; pass --component <Name>');
  return { dir, order, component };
}

// ── transpile + build a local harness ─────────────────────────────────────--
function tx(src, file) {
  return Babel.transform(src, { presets: [['react', { runtime: 'classic' }]], filename: file }).code;
}
// Classic scripts share one global lexical scope; wrap each file so top-level
// consts can't collide. Everything crosses between files through window.
const wrap = (code) => ';(function(){\n' + code + '\n})();\n';

function reactUmd(name) {
  // React 18's exports map blocks require.resolve of the umd subpath; read the file.
  const p = path.join(HERE, 'node_modules', name, 'umd',
    (name === 'react' ? 'react' : 'react-dom') + '.production.min.js');
  if (!fs.existsSync(p)) throw new Error('missing ' + p + ' (run npm install in scripts/)');
  return fs.readFileSync(p);
}

function buildHarness(serveDir, project) {
  fs.mkdirSync(serveDir, { recursive: true });
  const scriptTags = [];
  project.order.forEach((f, i) => {
    const name = 'mod_' + i + '.js';
    fs.writeFileSync(path.join(serveDir, name), wrap(tx(fs.readFileSync(f, 'utf8'), path.basename(f))));
    scriptTags.push('<script src="./' + name + '"></script>');
  });
  fs.writeFileSync(path.join(serveDir, 'react.js'), reactUmd('react'));
  fs.writeFileSync(path.join(serveDir, 'react-dom.js'), reactUmd('react-dom'));

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}#root{position:absolute;inset:0}</style>
<script>try{localStorage.setItem('animstage:t','0');}catch(e){} window.module={exports:{}};</script>
</head><body>
<div id="root"></div>
<script src="./react.js"></script>
<script src="./react-dom.js"></script>
${scriptTags.join('\n')}
<script>
(function mount(){
  if(!window.${project.component} || !window.ReactDOM || !window.React){ return setTimeout(mount,20); }
  window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(window.${project.component}));
  window.__mounted = true;
})();
</script>
</body></html>`;
  fs.writeFileSync(path.join(serveDir, 'index.html'), html);
}

// ── chrome discovery ──────────────────────────────────────────────────────--
function findChrome() {
  if (args.chrome && fs.existsSync(args.chrome)) return args.chrome;
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'chrome.exe' : process.platform === 'darwin' ? 'Google Chrome for Testing' : 'chrome';
  const roots = [path.join(home, '.cache', 'puppeteer', 'chrome'), path.join(home, '.cache', 'puppeteer', 'chrome-headless-shell')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === exe || e.name === 'chrome.exe' || e.name === 'chrome') return full;
      }
    }
  }
  const sys = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const p of sys) if (fs.existsSync(p)) return p;
  return null;
}

// ── audio tap, injected before any page script runs ───────────────────────--
// Splice a gain node between the app's AudioContext and its real destination,
// fan it out to a MediaStreamDestination, and expose a recorder that plays the
// timeline from 0 while capturing. Returning the recording from the page keeps
// the audio out of this process until ffmpeg needs it.
function audioTapInit() {
  try { localStorage.setItem('animstage:t', '0'); } catch (e) {}
  const Real = window.AudioContext || window.webkitAudioContext;
  if (!Real) return;
  function Tapped() {
    const ac = new Real();
    try {
      const realDest = ac.destination;
      const tap = ac.createGain();
      const msd = ac.createMediaStreamDestination();
      tap.connect(realDest); tap.connect(msd);
      Object.defineProperty(ac, 'destination', { value: tap, configurable: true });
      window.__tapStream = msd.stream;
      window.__audioCreated = true;
      if (ac.resume) ac.resume();
    } catch (e) {}
    return ac;
  }
  window.AudioContext = Tapped;
  window.webkitAudioContext = Tapped;

  window.__recordAudio = (durMs) => new Promise((resolve) => {
    const stream = window.__tapStream;
    const svg = document.querySelector('svg[data-om-exportable-video-with-duration-secs]');
    if (!stream || !svg || typeof MediaRecorder === 'undefined') { resolve(null); return; }
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      resolve(btoa(bin));
    };
    rec.start();
    // play from exactly 0 so the captured audio lines up with frame 0
    svg.dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', { detail: { time: 0 } }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      try { rec.stop(); } catch (e) { resolve(null); }
    }, durMs);
  });
}

// ── static server ─────────────────────────────────────────────────────────--
function serve(dir) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    fs.readFile(path.join(dir, p), (e, buf) => {
      if (e) { res.statusCode = 404; res.end('404'); return; }
      res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream'); res.end(buf);
    });
  });
  return server;
}

function ffmpeg(fpArgs) {
  const r = spawnSync('ffmpeg', fpArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) { console.error('ffmpeg not found on PATH. Install ffmpeg and retry.'); process.exit(1); }
  if (r.status !== 0) { console.error('ffmpeg failed (' + r.status + ')'); process.exit(1); }
}

// ── main ──────────────────────────────────────────────────────────────────--
(async () => {
  let project;
  try { project = resolveProject(args.input); }
  catch (e) { console.error(e.message); process.exit(2); }

  // Read the scene's own <Stage fps={N}>. Skip the runtime file, whose Stage
  // definition carries a default `fps = 60` that is not the scene's choice.
  let fps = args.fps;
  if (!fps) {
    for (const f of project.order) {
      const src = fs.readFileSync(f, 'utf8');
      if (/function\s+Stage\s*\(/.test(src)) continue;
      const m = src.match(/<Stage[^>]*\bfps\s*=\s*\{?\s*(\d+)/);
      if (m) { fps = +m[1]; break; }
    }
  }
  fps = fps || 30;

  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome/Chromium found. Set PUPPETEER_EXECUTABLE_PATH or pass --chrome <path>,\n' +
      'or run "npx @puppeteer/browsers install chrome" to download one.');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-mp4-'));
  const serveDir = path.join(work, 'serve');
  const framesDir = path.join(work, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  buildHarness(serveDir, project);

  const server = serve(serveDir);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-background-timer-throttling', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(audioTapInit);
  page.on('pageerror', (e) => console.log('  page error:', e.message));

  // probe Stage dims before sizing the viewport
  await page.goto('http://localhost:' + port + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('svg[data-om-exportable-video-with-duration-secs]', { timeout: 30000 });
  await page.waitForFunction(() => window.__mounted === true, { timeout: 30000 });
  const meta = await page.evaluate(() => {
    const s = document.querySelector('svg[data-om-exportable-video-with-duration-secs]');
    return { dur: +s.getAttribute('data-om-exportable-video-with-duration-secs'), w: +s.getAttribute('width'), h: +s.getAttribute('height') };
  });
  const duration = meta.dur || (await page.evaluate(() => window.DURATION)) || 10;
  const W = meta.w, H = meta.h;
  const N = Math.round(duration * fps);
  console.log('animation: ' + W + 'x' + H + ' @ ' + fps + 'fps, ' + duration + 's (' + N + ' frames), component ' + project.component);

  const [TW, TH] = targetDims(W, H, args.preset, args.quality);
  const crf = args.crf != null ? args.crf : QUALITY_CRF[args.quality];
  // Render at enough device pixels that scaling up to the target stays sharp;
  // for downscales 1x is fine and ffmpeg does the resampling.
  const dpr = args.scale != null ? args.scale
    : Math.max(1, Math.min(3, Math.ceil(Math.min(TW, TH) / Math.min(W, H))));
  const reshaped = TW !== W || TH !== H;
  console.log('output: ' + TW + 'x' + TH + ' (' + args.quality +
    (PRESETS[args.preset] ? ', ' + args.preset : '') + '), crf ' + crf + ', ' + dpr + 'x capture');

  await page.setViewport({ width: W, height: H + 60, deviceScaleFactor: dpr });
  await page.waitForFunction(() => {
    const s = document.querySelector('svg[data-om-exportable-video-with-duration-secs]');
    return s && s.getAttribute('data-om-fonts-inlined') === 'true';
  }, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.addStyleTag({ content:
    '[data-omelette-chrome]{display:none!important;}' +
    'svg[data-om-exportable-video-with-duration-secs]{transform:none!important;position:fixed!important;left:0!important;top:0!important;box-shadow:none!important;margin:0!important;}'
  });

  // Pad colour for a reshaped canvas: prefer the scene's own background so the
  // letterbox reads as part of the design rather than a black bar.
  let padColor = args.bg || null;
  if (reshaped && !padColor) {
    const css = await page.evaluate(() => {
      const s = document.querySelector('svg[data-om-exportable-video-with-duration-secs]');
      const fo = s && s.querySelector('foreignObject');
      const root = fo && fo.firstElementChild;
      const pick = (el) => { if (!el) return null; const c = getComputedStyle(el).backgroundColor; return c && c !== 'rgba(0, 0, 0, 0)' ? c : null; };
      return pick(root) || pick(fo) || (s ? getComputedStyle(s).backgroundColor : null);
    }).catch(() => null);
    padColor = rgbToFfColor(css);
  }
  padColor = padColor || 'black';

  // 1) audio pass (real-time), if the scene makes sound
  let audioFile = null;
  if (args.audio !== 'off') {
    // let autoplay spin up the AudioContext, then check
    await new Promise((r) => setTimeout(r, 1200));
    const hasAudio = await page.evaluate(() => !!window.__tapStream);
    if (hasAudio) {
      console.log('capturing soundtrack (real time, ~' + Math.ceil(duration) + 's)...');
      const b64 = await page.evaluate((d) => window.__recordAudio(d), Math.ceil(duration * 1000) + 350);
      if (b64) {
        audioFile = path.join(work, 'audio.webm');
        fs.writeFileSync(audioFile, Buffer.from(b64, 'base64'));
        console.log('  audio ' + (fs.statSync(audioFile).size / 1e6).toFixed(2) + ' MB');
      }
    } else {
      console.log('no Web Audio detected; rendering silent.');
    }
  }

  // 2) video pass: pin each frame and screenshot
  const clip = { x: 0, y: 0, width: W, height: H };
  const t0 = Date.now();
  for (let f = 0; f < N; f++) {
    const t = f / fps;
    await page.evaluate((t) => {
      document.querySelector('svg[data-om-exportable-video-with-duration-secs]')
        .dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', { detail: { time: t } }));
    }, t);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    await page.screenshot({ clip, path: path.join(framesDir, 'f_' + String(f).padStart(5, '0') + '.png'), type: 'png', optimizeForSpeed: true });
    if (f % 60 === 0) process.stdout.write('  frame ' + f + '/' + N + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + 's)\r');
  }
  console.log('\n  frames done (' + N + ')');

  await browser.close();
  server.close();

  // 3) mux
  const out = path.resolve(args.out || path.join(project.dir, project.component.replace(/[^\w.-]/g, '') + '.mp4'));
  // Fit the captured frame into the target canvas preserving aspect, then pad
  // the remainder so the output is exactly the requested size. For source +
  // original this is a no-op scale and no padding.
  const vf = 'scale=' + TW + ':' + TH + ':force_original_aspect_ratio=decrease:flags=lanczos,' +
    'pad=' + TW + ':' + TH + ':(ow-iw)/2:(oh-ih)/2:color=' + padColor + ',setsar=1';
  const base = ['-y', '-framerate', String(fps), '-start_number', '0', '-i', path.join(framesDir, 'f_%05d.png')];
  if (audioFile) {
    ffmpeg([...base, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-vf', vf,
      '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k', '-shortest', out]);
  } else {
    ffmpeg([...base, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-vf', vf, '-movflags', '+faststart', out]);
  }

  const size = (fs.statSync(out).size / 1e6).toFixed(2);
  if (!args.keep) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
  else console.log('work dir kept: ' + work);
  console.log('\ndone: ' + out + ' (' + size + ' MB, ' + TW + 'x' + TH + ', ' + fps + 'fps, ' + duration + 's, audio ' + (audioFile ? 'yes' : 'no') + ')');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
