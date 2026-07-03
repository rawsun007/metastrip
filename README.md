# MetaStrip

**Your photos. Untracked.**

Your photos quietly carry hidden metadata: your exact GPS location, your device model, and the exact second you took them. MetaStrip shows you everything a photo leaks, then strips it, **100% in your browser**. No upload, no server, no account. Your photo never leaves your device.

## Features

- 🔍 **See what leaks**: parses EXIF, GPS, and text metadata from JPEG and PNG
- 📍 **Location alert**: pinpoints embedded GPS coordinates on a map link
- ✂️ **Lossless stripping**: removes metadata segments byte by byte, zero re-compression, zero quality loss
- 🔒 **Zero trust needed**: everything runs client-side and works offline once loaded

## Run locally

Any static file server works:

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173

## Built by

[Roshan Ramani](https://github.com/rawsun007)
