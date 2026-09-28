# MetaStrip trailer: brief

**What it is:** a browser tool that shows everything a file leaks (GPS,
device, serials, timestamps) and strips it, 100% on your device.
**For:** anyone about to post, send or hand over a photo, video, PDF or
recording.
**Angle:** your file is a surveillance record, and MetaStrip is the only one
that reads it before somebody else does. The film plays the watcher, then
takes everything away from it.
**Hook:** the site's own post title, "YOUR PHOTOS KNOW WHERE YOU LIVE."
**Punchline:** the same photo, cleaned, goes back under the scanner and the
scanner finds nothing.

## Style

Glitch-brutalist forensics, chosen to be unlike anything else made for these
projects: the site's black stage and its five accents as full-bleed fields,
giant Anton set as solid blocks that crowd and crop the frame, surveillance
graphics (lock-on brackets, a radar grid, terminal readouts in IBM Plex Mono),
and hard cuts on the beat torn by RGB-split glitch bands. One canvas, so the
glitch works on real pixels.

## Everything on screen is real

The subject is `assets/sample-photo.jpg`, the demo photo the site ships. The
stage loads the site's own `js/exif.js` and `js/stripper.js` from the repo:

- The coordinates, device, lens, software and timestamps are what
  `parseMetadata()` reads out of that file.
- The hex dump is the file's real first 544 bytes, and the cut is what
  `stripMetadata()` does to a JPEG on "Strip all": it removes the APP1
  segment (bytes 2 to 485) and copies the image data verbatim.
- "18,566 B → 18,083 B", "image data identical, 17,474 B" and "read it
  again: 0 fields left" are measured on the stripped bytes at bake time.
- The format list and what each leaks come from the README's table; "23
  FORMATS" is that table counted.
- The finished reel is checked by the site's own video reader (sweep.mjs)
  and carries no metadata of its own.

Honest limits: the location act is a radar grid rather than a map, because
the demo photo's GPS falls in the Pacific off San Francisco; and the packets
bouncing off the browser window are a picture of "nothing leaves your
device", not a claim that anything tried.

## Acts (128 bpm, 52 beats, 24.4 s)

| Beats | Act | On screen | Sound |
|---|---|---|---|
| 0-8 | Hook | The photo under the scanner, then "YOUR PHOTOS / KNOW WHERE / YOU LIVE." one line a beat | Sub drone, data chirps, a hit per slam |
| 8-16 | Locate | Radar grid, crosshair locks, real coordinates, "YOUR EXACT LOCATION" | Groove starts on the lock, lock beeps, sonar ping |
| 16-20 | Device | Blue field, "YOUR DEVICE FINGERPRINT", make, model, lens, software | Typing ticks |
| 20-24 | Timeline | Violet field, split-flap timestamp, "the exact second you pressed the button" | Flap clatter |
| 24-28 | Formats | Twelve formats strobed with what each leaks, "23 FORMATS." | A stab per word |
| 28-37 | Strip | Real bytes, APP1 lit, cut and spliced; sizes and two checks; "CLEANING A FILE WITHOUT TOUCHING A PIXEL." | Zap, falling bytes, chimes |
| 37-44 | Local | "100% IN YOUR BROWSER.", packets bounce inside the window, "NO UPLOAD. NO SERVER. NO ACCOUNT." | Bouncing blips |
| 44-52 | Outro | The cleaned photo; the scanner hunts; GPS/DEVICE/TIMESTAMPS none; NOTHING TO FIND.; METASTRIP, "Your files. Untracked." | The groove falls away, a refusal buzzer, silence, then A major |
