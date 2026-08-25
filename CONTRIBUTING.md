# Contributing to MetaStrip

No build step, no dependencies, no framework. It is HTML, CSS and plain
browser scripts, which is deliberate: anybody should be able to read the
whole tool and satisfy themselves that files never leave the device.

## Running it

```bash
node build.mjs            # only needed after editing anything in js/
python3 -m http.server 4173
```

Then open http://localhost:4173. A service worker is registered, so use a
hard reload when scripts change.

## Running the tests

```bash
node tests/run.mjs
```

251 checks, no dependencies. The parsers and strippers are loaded into a VM
context with the few browser globals they touch, and every test file is
assembled byte by byte in `tests/fixtures.mjs` — there are no binary
fixtures in the repo, so each test carries exactly the structure it is about
and you can read what it depends on.

Add a failing test before a fix, and a passing one before a feature. If you
touch a parser, the tests that matter most are the ones asserting the media
survives: mdat comes out of a video strip byte-identical, an ICC profile
survives a JPEG strip, a raw file keeps its structural tags.

## Things worth knowing before you edit `js/`

**These are plain scripts sharing one global scope.** There are no modules,
so two files declaring the same function name will silently shadow each
other, and the last one loaded wins. This actually happened: `exif.js` and
`video.js` both had a `utf8Slice`, and PNG text values were being truncated
by the wrong one for a while. The suite now fails on duplicate top-level
names — do not work around it, rename.

**Nothing may move.** Most formats here store absolute byte offsets
somewhere: video chunk tables, a PDF cross-reference table, a raw file's
strip offsets. So metadata is overwritten in place with whatever that format
treats as empty, rather than cut out. `js/edits.js` holds the writer and the
edit kinds. Only MP3 and JPEG tails can be cut, because nothing points at
them.

**Never load a whole file.** A video or a raw file can be gigabytes. Read
headers with `file.slice()`, and build output from slices so the browser
streams it. `await file.arrayBuffer()` is fine for a photo and wrong for a
clip.

**The page loads one bundle, not sixteen scripts.** Every file a visitor asks
for is a billable edge request, and that arithmetic decides how much traffic a
free plan absorbs before the site goes dark. Edit the files in `js/`, run
`node build.mjs`, and commit the regenerated `js/bundle.js` with your change.
The load order lives in `BUNDLE_ORDER` in build.mjs, and a new file has to be
added there or it never ships. See OPERATIONS.md for the rest of it.

**Say what is true in the UI.** If something cannot be removed, the card
says so rather than offering a tick box that does nothing. If an operation
re-encodes, it says that too. A privacy tool that overstates what it did is
worse than no tool.

## Commits

One change per commit, with a message explaining why rather than what. The
diff already says what.
