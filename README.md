# MetaStrip

**Your photos and videos. Untracked.**

Live at [metastrip.vercel.app](https://metastrip.vercel.app/) · current release **v1.0.0** ([changelog](https://metastrip.vercel.app/changelog.html))

Your photos and videos quietly carry hidden metadata: your exact GPS location, your device model, and the exact second you recorded them. MetaStrip shows you everything a file leaks, then strips it, **100% in your browser**. No upload, no server, no account. Nothing ever leaves your device.

## Features

- 🔍 **See what leaks**: parses EXIF, GPS and text metadata from JPEG, PNG and HEIC
- 🎬 **Videos too**: MP4, MOV, WebM and Matroska — GPS, camera make and model, recording time, Live Photo pairing ids, embedded XMP and stray muxer tags
- 📍 **Location alert**: pinpoints embedded GPS coordinates on a map link, or a real mini map
- ✂️ **Lossless stripping**: removes metadata segments byte by byte, zero re-compression, zero quality loss
- 🧠 **Never loads a whole video**: only header boxes are read, and the cleaned file is assembled from slices of the original, so a multi-gigabyte clip costs almost no memory
- 🖼 **Shown in the right shape**: previews keep their true aspect ratio, and the card layout adapts per shape — vertical reels, 4:3, 16:9 and 2.39:1 scope each get a box that fits, with anamorphic footage corrected to its display size
- 📊 **Storage budget**: a live meter and honest limits, so a huge file is refused with a real explanation instead of killing the tab
- 🔒 **Zero trust needed**: everything runs client-side and works offline once loaded

## How video stripping works

A video cannot be cleaned the way a JPEG is. Chunk offset tables (`stco`, `co64`) hold
absolute file positions into the media data, so deleting a single byte ahead of them
desynchronises playback.

So nothing moves. Each doomed box keeps its exact size and gets its type rewritten to
`free` with a zeroed payload — a box every demuxer already skips — and raw timestamps
are zeroed where they sit. WebM gets the same treatment with `Void` elements, which keeps
Cue and SeekHead positions valid. Decoded frames come out hash-identical to the original.

## Run locally

Any static file server works:

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173

## Built by

[Roshan Ramani](https://github.com/rawsun007)
