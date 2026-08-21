# MetaStrip

**Your files. Untracked.**

Live at [metastrip.vercel.app](https://metastrip.vercel.app/) · current release **v1.2.0** ([changelog](https://metastrip.vercel.app/changelog.html))

Your files quietly carry hidden metadata: your exact GPS location, your device model, its serial number, and the exact second you pressed the button. MetaStrip shows you everything a file leaks, then strips it, **100% in your browser**. No upload, no server, no account. Nothing ever leaves your device.

## What it reads and removes

| Format | What comes out |
|---|---|
| **JPEG, PNG, HEIC** | EXIF, GPS, XMP, IPTC, comments, text chunks |
| **RAW** — DNG, CR2, CR3, NEF, ARW, ORF, RAF, PEF | camera and lens serials, the photographer's name, the original file name off the card, maker notes, and the full-size JPEG preview a raw file hides inside itself |
| **Video** — MP4, MOV, WebM, MKV | GPS as ISO 6709, camera make and model, Live Photo pairing ids, Google Photos upload ids, muxer tags |
| **Audio** — MP3, M4A, WAV, FLAC, Ogg, Opus, AIFF | ID3 tags, Vorbis comments, INFO lists, and the Broadcast Wave chunk that names whoever recorded it |
| **PDF** | Title, Author, Creator, Producer, both timestamps, the XMP packet, and the file identifier that follows a document through every save |
| **Content Credentials (C2PA)** | the signed provenance record: which tool made the file, whether the origin claim says a camera or a trained model, the signing certificate, the edit history |
| **Motion photos** | the entire MP4 that Pixel and Galaxy bolt onto a JPEG after the end-of-image marker, carrying its own GPS |
| **AI images** | the prompt, negative prompt, seed, sampler and model that Stable Diffusion, ComfyUI, InvokeAI and NovelAI leave in a text chunk |

## Features

- 🔍 **See what leaks** before you remove it, field by field, with tick boxes to keep anything you want
- 📍 **Location alert** with a real map, drawn only when you ask for it
- ✂️ **Lossless**: metadata is removed or blanked byte by byte, never re-encoded, so pixels and samples come out identical
- 🧠 **Never loads a whole file**: a multi-gigabyte video costs almost no memory, because only headers are read and the output is assembled from slices
- 🗂 **Whole folders** through the File System Access API, without a single upload — cleaned copies go into a new folder and your originals are never overwritten
- 🔗 **Cross-file linkage**: drop several files and see what ties them to each other, like a shared camera serial or a shared location
- 🧾 **Receipt**: a plain-text record with a SHA-256 of each file before and after, for handing a cleaned file to somebody who needs to trust it
- 🎨 **Pixel redaction** for the leak metadata cannot touch — a face, a plate, an address, a name on a screenshot
- 📊 **Storage budget** with honest limits, so a huge file is refused with a real explanation instead of killing the tab
- 🔒 **Zero trust needed**: everything runs client-side and works offline once loaded

## How stripping works without moving a byte

A video cannot be cleaned the way a JPEG is. Chunk offset tables (`stco`, `co64`) hold
absolute file positions into the media data, so deleting a single byte ahead of them
desynchronises playback.

So nothing moves. Each doomed box keeps its exact size and gets its type rewritten to
`free` with a zeroed payload — a box every demuxer already skips — and raw timestamps
are zeroed where they sit. WebM gets the same treatment with `Void` elements, which keeps
Cue and SeekHead positions valid. Decoded frames come out hash-identical to the original.

The same constraint shows up everywhere, and each format has its own idea of "empty":

| Format | Constraint | What replaces the metadata |
|---|---|---|
| MP4, MOV | `stco`/`co64` hold absolute offsets | a `free` box of the same size |
| Matroska | Cues and SeekHead hold positions | a `Void` element |
| PDF | the xref table holds byte offsets | spaces inside the string delimiters, `0`s inside hex strings |
| RAW | IFD entries must stay sorted, and structural tags point at image strips | values blanked, entry headers left standing |
| WAV, AIFF | a chunk cannot move without rewriting the RIFF size | the chunk renamed `JUNK`, which means "skip this" |
| FLAC | metadata blocks are a linked list | the block becomes `PADDING` |
| Ogg, Opus | every page carries a checksum of itself | the page rebuilt and its CRC recomputed |
| MP3 | nothing stores an offset | the tag blocks are simply cut out |

## Run locally

Any static file server works:

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers the three things that
are not obvious from reading one file: these are plain scripts in one shared
global scope, nothing may move because most of these formats store absolute byte
offsets, and no whole file may be loaded because a clip can be gigabytes.

## Tests

```bash
node tests/run.mjs
```

No binary fixtures and no dependencies: every test file is assembled byte by byte
in `tests/fixtures.mjs`, so a test can carry exactly the structure it is about — a
JUMBF box, a video bolted onto a JPEG, an anamorphic track — and you can read what
it depends on.

## Built by

[Roshan Ramani](https://github.com/rawsun007)
