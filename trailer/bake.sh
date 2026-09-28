#!/bin/bash
# Bake the trailer: reel/untracked.mp4 and its cover, reel/cover.jpg.
#
# Needs Node 22+, Python 3 with numpy, ffmpeg and Google Chrome (or CHROME=...).
# Everything on screen is read from the repo at bake time: the photo from
# ../assets and its metadata by the site's own parser in ../js.
set -euo pipefail
cd "$(dirname "$0")"

[ -d node_modules ] || npm install --silent
python3 synth.py

# Two cameras, one half each; waiting on each pid makes a crash in either
# half fail the bake instead of encoding a hole.
N=$(python3 -c "import json;b=json.load(open('beats.json'));print(round(b['duration']*b['fps']))")
rm -rf frames && mkdir -p frames reel
node camera.mjs roll 0 $((N / 2)) & A=$!
node camera.mjs roll $((N / 2)) "$N" & B=$!
wait $A; wait $B

# Cover: the settled wordmark, baked in as frame 0 so a thumbnail shows it
# without shifting the sound.
cp "$(printf 'frames/%05d.jpg' $((N - 12)))" reel/cover.jpg

# The encode writes no metadata of its own:
#   -map_metadata -1       no global tags
#   bitexact flags         no encoder name stamped in the container, the kind
#                          of muxer tag MetaStrip reports
#   encoder=               no per-stream "Lavc libx264" tag either
#   filter_units 6         no SEI units: x264 writes its version and every
#                          setting into the video stream itself, threads=15
#                          included, which is a small fingerprint of the
#                          machine that made it. SEI is optional; nothing
#                          needs it to play.
# What remains is structure every MP4 has (the hdlr names VideoHandler and
# SoundHandler). Loudness to -14 LUFS with a limiter for AAC headroom.
ffmpeg -v error -y -framerate 30 -i frames/%05d.jpg -i reel/cover.jpg -i synth.wav \
  -filter_complex "[0:v][1:v]overlay=enable='eq(n\,0)'[v];[2:a]loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.72:level=false[a]" \
  -map "[v]" -map "[a]" -map_metadata -1 -map_chapters -1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -metadata:s:v encoder= -bsf:v filter_units=remove_types=6 \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high \
  -movflags +faststart -c:a aac -b:a 192k -ar 48000 -shortest reel/untracked.mp4

# A trailer about hidden metadata should not carry any. Ask MetaStrip.
node sweep.mjs reel/untracked.mp4
echo "✓ reel/untracked.mp4"
