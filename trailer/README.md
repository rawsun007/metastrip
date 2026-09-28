# MetaStrip trailer

A 24-second trailer for MetaStrip, made with the
[`/brag`](https://github.com/latent-spaces/brag) skill (`brag-slim`) and baked
from source here with one command.

**Watch:** [`reel/untracked.mp4`](reel/untracked.mp4) (cover:
[`reel/cover.jpg`](reel/cover.jpg)). The caption is [`post.txt`](post.txt),
and the reasoning behind every shot is in [`brief.md`](brief.md).

This folder is excluded from the deployed site by `/.vercelignore`: it lives
in git, not on metastrip.vercel.app.

## It uses the site's own code

Nothing on screen is typed in. The stage loads the demo photo from
`../assets` and the site's readers from `../js`:

- the coordinates, device, lens and timestamps are `parseMetadata()` on
  `assets/sample-sunset.jpg`, the site's leaking demo photo;
- the hex dump is that file's real bytes, and the cut is what
  `stripMetadata()` does on "Strip all": APP1 out, image data verbatim;
- the sizes and both checks ("image data identical", "0 fields left") are
  measured on the stripped bytes at bake time;
- and the finished reel is judged by `score.js`: it badges CLEAN with nothing
  to strip.

## Bake

```bash
trailer/bake.sh      # writes reel/untracked.mp4 and reel/cover.jpg, then sweeps it
```

Needs Node 22+, Python 3 with numpy, ffmpeg and Google Chrome (`CHROME=...`
for another Chromium). The site itself still has no dependencies: the one
this needs is pinned in `trailer/package.json`. Keep the machine awake while
it bakes; a headless Chrome in the background gets throttled.

## Files

| File | Job |
|---|---|
| `beats.json` | The cue sheet. Every act and hit in beats at 128 bpm; the picture and the score both read it. |
| `stage.html` | The frame renderer: one canvas, the engine, then one `<script>` per act. `draw(t)` paints the frame at time `t`. |
| `camera.mjs` | Headless Chrome capture. `node camera.mjs proof 3.2 7.5` shoots single frames; `roll` shoots a range. |
| `synth.py` | The score and every effect, synthesized in numpy. No samples. |
| `sweep.mjs` | Runs MetaStrip's own video reader and badge logic over a file. |
| `bake.sh` | Score, frames, cover, a trace-free encode, sweep. |

`frames/`, `proofs/`, `synth.wav`, the built stage and `node_modules` are
regenerated and ignored; `reel/` is kept.

## The encode leaves no trace

A trailer about hidden metadata should carry none. Besides dropping global
tags and the container's encoder name, the encode strips the SEI units x264
writes into the video stream itself (its version and every setting,
`threads=15` included, a small fingerprint of the machine that made it). No
metadata reader looks inside the bitstream, so no stripper would catch it.
What remains are the `hdlr` names every MP4 has.
