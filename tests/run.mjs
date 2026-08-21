/* MetaStrip test run: node tests/run.mjs

   The parsers and strippers are plain browser scripts with no module system,
   so they are loaded into a VM context with the handful of browser globals
   they touch. Fixtures are built byte by byte in fixtures.mjs. Nothing here
   needs a DOM: the DOM side is covered by tests/browser.html. */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as F from "./fixtures.mjs";

const JS_DIR = path.join(import.meta.dirname, "..", "js");
const SCRIPTS = ["aitags.js", "c2pa.js", "edits.js", "exif.js", "stripper.js", "video.js", "pdf.js", "audio.js"];
const DOM_SCRIPTS = ["linkage.js", "receipt.js", "redact.js", "storage.js", "folder.js"];

const ctx = vm.createContext({ console, File, Blob, DataView, Uint8Array, TextDecoder, TextEncoder });
for (const name of SCRIPTS) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, name), "utf8"), ctx, { filename: name });
}
const call = (expr, args = {}) => {
  Object.assign(ctx, args);
  return vm.runInContext(expr, ctx);
};

/* folder.js reaches for the page for its buttons and for app.js helpers, so
   the pieces it needs are stubbed and the rest of the page is absent. */
Object.assign(ctx, {
  window: {},
  document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [] },
  HTMLVideoElement: class {},
  isRemovableField: (f) => Boolean(f.ranges || f.chunkRange || f.chunkRanges || (f.edits && f.edits.length)),
  // mirrors app.js, which owns the real one
  formatBytes: (n) =>
    n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1024 * 1024 * 1024
          ? `${(n / (1024 * 1024)).toFixed(2)} MB`
          : `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`,
  async readMetadata(file) {
    if (ctx.isVideoFile(file)) return ctx.parseVideoMetadata(file);
    if (ctx.isPdfFile(file)) return ctx.parsePdfMetadata(file);
    if (ctx.isAudioFile(file)) return ctx.parseAudioMetadata(file);
    return ctx.parseMetadata(await file.arrayBuffer());
  },
  async computeCleanResult(file, meta) {
    if (meta.kind === "video") return ctx.stripVideoFile(file, ctx.allVideoEdits(meta));
    if (meta.format === "pdf") return ctx.stripPdfFile(file, ctx.allPdfEdits(meta));
    if (meta.kind === "audio") {
      const edits = meta.format === "m4a" ? ctx.allVideoEdits(meta) : ctx.allAudioEdits(meta);
      return ctx.stripAudioFile(file, meta, edits);
    }
    const buffer = await file.arrayBuffer();
    const result = ctx.stripMetadata(buffer);
    if (!result) throw new Error("unsupported");
    return { blob: new Blob([result.bytes]), lossless: result.lossless };
  },
});
for (const name of DOM_SCRIPTS) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, name), "utf8"), ctx, { filename: name });
}

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    return true;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  return false;
}

function eq(name, actual, expected) {
  return check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* Locates a top-level box by type, so a test can assert on exactly the media
   payload rather than on the whole file. */
function findBox(u8, type) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.length);
  let offset = 0;
  while (offset + 8 <= u8.length) {
    const size = view.getUint32(offset);
    const name = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
    if (name === type) return { start: offset, end: offset + size };
    if (size < 8) break;
    offset += size;
  }
  throw new Error(`no ${type} box in fixture`);
}

/* Byte-for-character view, the same one the PDF reader uses. */
function latin1(u8) {
  let out = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x8000, u8.length)));
  }
  return out;
}

function xrefOffsets(text) {
  const at = text.lastIndexOf("xref\n0 ");
  if (at < 0) return [];
  const rows = text.slice(at).matchAll(/^(\d{10}) 00000 n/gm);
  return [...rows].map((r) => Number(r[1])).filter((n) => n > 0);
}

/* Splits an Ogg stream into its pages, so each checksum can be verified. */
function oggPages(u8) {
  const pages = [];
  let offset = 0;
  while (offset + 27 <= u8.length) {
    if (latin1(u8.subarray(offset, offset + 4)) !== "OggS") break;
    const segments = u8[offset + 26];
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += u8[offset + 27 + i];
    const end = offset + 27 + segments + payload;
    const page = u8.subarray(offset, end);
    page.sequence = pages.length;
    pages.push(page);
    offset = end;
  }
  return pages;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* Reads a LONG value straight out of IFD0, to prove a structural tag came
   through a strip untouched. */
function readTiffTag(u8, tag) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.length);
  const ifd0 = view.getUint32(4, true);
  const count = view.getUint16(ifd0, true);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (view.getUint16(entry, true) === tag) return view.getUint32(entry + 8, true);
  }
  return null;
}

function countTiffEntries(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.length);
  return view.getUint16(view.getUint32(4, true), true);
}

const parse = (u8) => call("parseMetadata(__buf)", { __buf: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length) });
const strip = (u8) => call("stripMetadata(__buf)", { __buf: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length) });
const crc32 = (b, s, e) => call("crc32(__b, __s, __e)", { __b: b, __s: s, __e: e });
const labels = (meta) => meta.fields.map((f) => f.label);
const valueOf = (meta, label) => (meta.fields.find((f) => f.label === label) || {}).value;
const has = (meta, label) => meta.fields.some((f) => f.label === label);

/* ---------------- JPEG ---------------- */

const exifBlob = F.makeTiff({
  ifd0: [
    [0x010f, 2, "Canon"],
    [0x0110, 2, "Canon EOS R5"],
    [0x0131, 2, "Lightroom 14.2"],
  ],
  exif: [
    [0x9003, 2, "2026:08:20 07:31:09"],
    [0xa431, 2, "SN-0428871"],
  ],
  gps: F.GPS_SURAT,
});

{
  const jpeg = F.makeJpeg({ exif: exifBlob, comment: "shot at home" });
  const meta = parse(jpeg);
  eq("jpeg: format", meta.format, "jpeg");
  eq("jpeg: make", valueOf(meta, "Camera make"), "Canon");
  eq("jpeg: model", valueOf(meta, "Camera model"), "Canon EOS R5");
  eq("jpeg: serial", valueOf(meta, "Camera serial no."), "SN-0428871");
  check("jpeg: comment", valueOf(meta, "Comment") === "shot at home");
  check("jpeg: gps found", Boolean(meta.gps));
  check("jpeg: gps latitude", Math.abs(meta.gps.lat - 21.1703) < 0.01, JSON.stringify(meta.gps));
  check("jpeg: gps longitude", Math.abs(meta.gps.lon - 72.8181) < 0.01, JSON.stringify(meta.gps));

  const cleaned = strip(jpeg);
  check("jpeg: strip is lossless", cleaned && cleaned.lossless === true);
  const after = parse(cleaned.bytes);
  eq("jpeg: no fields after strip", after.fields.length, 0);
  eq("jpeg: no gps after strip", after.gps, null);
  check("jpeg: pixels survive", [...cleaned.bytes].join(",").includes("18,52,86,120"), "scan data missing");
}

{
  // ICC profiles must survive: dropping APP2 shifts colours
  const jpeg = F.makeJpeg({ exif: exifBlob, app2: new Uint8Array([1, 2, 3, 4]) });
  const cleaned = strip(jpeg);
  const text = [...cleaned.bytes].map((b) => String.fromCharCode(b)).join("");
  check("jpeg: keeps ICC profile", text.includes("ICC_PROFILE"));
}

/* ---------------- PNG ---------------- */

{
  const png = F.makePng([F.pngText("Comment", "made on my laptop")], { crc32 });
  const meta = parse(png);
  eq("png: format", meta.format, "png");
  check("png: text chunk read", has(meta, "PNG Comment"), labels(meta).join(","));
  const cleaned = strip(png);
  eq("png: no fields after strip", parse(cleaned.bytes).fields.length, 0);
  const text = [...cleaned.bytes].map((b) => String.fromCharCode(b)).join("");
  check("png: keeps IHDR", text.includes("IHDR"));
  check("png: keeps IEND", text.includes("IEND"));
}

/* ---------------- TIFF-based EXIF in PNG ---------------- */

{
  const png = F.makePng([["eXIf", exifBlob]], { crc32 });
  const meta = parse(png);
  eq("png: exif chunk make", valueOf(meta, "Camera make"), "Canon");
  check("png: exif chunk gps", Boolean(meta.gps));
}

/* ---------------- selective strip ---------------- */

{
  const jpeg = F.makeJpeg({ exif: exifBlob });
  const meta = parse(jpeg);
  const keepModel = meta.fields.filter((f) => f.label !== "Camera model");
  const result = call("selectiveStrip(__buf, __fields)", {
    __buf: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length),
    __fields: [...keepModel, meta.gps],
  });
  const after = parse(result.bytes);
  eq("selective: model kept", valueOf(after, "Camera model"), "Canon EOS R5");
  eq("selective: make dropped", valueOf(after, "Camera make"), undefined);
  eq("selective: gps dropped", after.gps, null);
  eq("selective: size unchanged", result.bytes.length, jpeg.length);
}

/* ---------------- MP4 ---------------- */

const asFile = (u8, name, type) => new File([u8], name, { type });

async function parseVideo(u8, name = "clip.mp4", type = "video/mp4") {
  return call("parseVideoMetadata(__file)", { __file: asFile(u8, name, type) });
}

{
  const mp4 = F.makeMp4({
    udta: [
      F.textAtom("©xyz", "+21.1702+072.8311/"),
      F.textAtom("©mod", "iPhone 15 Pro"),
      F.textAtom("©swr", "18.2"),
    ],
  });
  const meta = await parseVideo(mp4);
  eq("mp4: kind", meta.kind, "video");
  eq("mp4: model", valueOf(meta, "Camera model"), "iPhone 15 Pro");
  eq("mp4: frame size", valueOf(meta, "Frame size"), "1920 x 1080");
  eq("mp4: codec", valueOf(meta, "Codec"), "H.264");
  eq("mp4: duration", valueOf(meta, "Duration"), "0:02");
  check("mp4: gps", meta.gps && Math.abs(meta.gps.lat - 21.1702) < 0.001, JSON.stringify(meta.gps));

  const result = await call("stripVideoFile(__file, allVideoEdits(__meta))", {
    __file: asFile(mp4, "clip.mp4", "video/mp4"),
    __meta: meta,
  });
  const cleanedBytes = new Uint8Array(await result.blob.arrayBuffer());
  eq("mp4: size unchanged by strip", cleanedBytes.length, mp4.length);
  const after = await parseVideo(cleanedBytes);
  eq("mp4: gps gone", after.gps, null);
  eq("mp4: model gone", valueOf(after, "Camera model"), undefined);
  eq("mp4: frame size kept", valueOf(after, "Frame size"), "1920 x 1080");
  const mdatAt = findBox(mp4, "mdat");
  check(
    "mp4: mdat bytes untouched",
    sameBytes(mp4.subarray(mdatAt.start, mdatAt.end), cleanedBytes.subarray(mdatAt.start, mdatAt.end)),
    "media data changed"
  );
}

{
  const mp4 = F.makeMp4({ width: 1920, height: 1080, storedWidth: 1440 });
  const meta = await parseVideo(mp4);
  eq("mp4: anamorphic reported", valueOf(meta, "Frame size"), "1920 x 1080 (stored 1440 x 1080, anamorphic)");
}

/* ---------------- WebM ---------------- */

{
  const webm = F.makeWebm({ title: "holiday", tags: [["DEVICE", "Pixel 8"], ["LOCATION", "+21.1702+072.8311/"]] });
  const meta = await parseVideo(webm, "clip.webm", "video/webm");
  eq("webm: format", meta.format, "webm");
  eq("webm: title", valueOf(meta, "Title"), "holiday");
  eq("webm: device", valueOf(meta, "Device"), "Pixel 8");
  eq("webm: frame size", valueOf(meta, "Frame size"), "1280 x 720");
  check("webm: gps from tag", meta.gps && Math.abs(meta.gps.lat - 21.1702) < 0.001, JSON.stringify(meta.gps));

  const result = await call("stripVideoFile(__file, allVideoEdits(__meta))", {
    __file: asFile(webm, "clip.webm", "video/webm"),
    __meta: meta,
  });
  const cleaned = new Uint8Array(await result.blob.arrayBuffer());
  eq("webm: size unchanged", cleaned.length, webm.length);
  const after = await parseVideo(cleaned, "clip.webm", "video/webm");
  eq("webm: title gone", valueOf(after, "Title"), undefined);
  eq("webm: gps gone", after.gps, null);
  eq("webm: frame size kept", valueOf(after, "Frame size"), "1280 x 720");
}

/* ---------------- C2PA Content Credentials ---------------- */

{
  const jumbf = F.makeC2paJumbf({ generator: "Adobe Firefly 3.0", author: "Jane Q. Public", ingredients: 2 });
  const jpeg = F.makeJpeg({ exif: exifBlob, jumbf });
  const meta = parse(jpeg);
  check("c2pa jpeg: detected", has(meta, "Content Credentials"), labels(meta).join(","));
  eq("c2pa jpeg: generator", valueOf(meta, "Made with"), "Adobe Firefly 3.0");
  eq("c2pa jpeg: ai flagged", valueOf(meta, "Origin claim"), "AI generated by a trained model");
  check("c2pa jpeg: actions", (valueOf(meta, "Edit history") || "").includes("created"));
  eq("c2pa jpeg: signer from certificate", valueOf(meta, "Signed by"), "Jane Photographer");
  eq("c2pa jpeg: named author", valueOf(meta, "Named author"), "Jane Q. Public");
  check("c2pa jpeg: ingredients counted", (valueOf(meta, "Source files") || "").startsWith("2 earlier"));
  check("c2pa jpeg: exif still read", valueOf(meta, "Camera make") === "Canon");

  const cleaned = strip(jpeg);
  const after = parse(cleaned.bytes);
  check("c2pa jpeg: gone after strip", !has(after, "Content Credentials"), labels(after).join(","));
  const text = [...cleaned.bytes].map((b) => String.fromCharCode(b)).join("");
  check("c2pa jpeg: no manifest bytes left", !text.includes("Firefly"));

  // selective: keep the credentials, drop the camera
  const keepC2pa = meta.fields.filter((f) => f.label !== "Content Credentials");
  const partial = call("selectiveStrip(__buf, __fields)", {
    __buf: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length),
    __fields: [...keepC2pa, meta.gps],
  });
  const partialMeta = parse(partial.bytes);
  check("c2pa jpeg: kept when unticked", has(partialMeta, "Content Credentials"));
  eq("c2pa jpeg: camera dropped alongside", valueOf(partialMeta, "Camera make"), undefined);
}

{
  const signed = F.makeC2paJumbf({
    generator: "c2pa-rs/0.36.1",
    sourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
  });
  const png = F.makePng([["caBX", signed]], { crc32 });
  const meta = parse(png);
  check("c2pa png: detected", has(meta, "Content Credentials"), labels(meta).join(","));
  eq("c2pa png: origin claim", valueOf(meta, "Origin claim"), "captured by a camera");
  const after = parse(strip(png).bytes);
  check("c2pa png: gone after strip", !has(after, "Content Credentials"));
}

{
  const manifest = F.makeC2paJumbf({ generator: "Sora 2" });
  const mp4 = F.makeMp4({ topLevelUuid: F.bytes(F.C2PA_UUID, manifest) });
  const meta = await parseVideo(mp4);
  check("c2pa mp4: detected", meta.fields.some((f) => f.label === "Content Credentials"), labels(meta).join(","));
  eq("c2pa mp4: generator", valueOf(meta, "Made with"), "Sora 2");

  const result = await call("stripVideoFile(__file, allVideoEdits(__meta))", {
    __file: asFile(mp4, "clip.mp4", "video/mp4"),
    __meta: meta,
  });
  const cleaned = new Uint8Array(await result.blob.arrayBuffer());
  eq("c2pa mp4: size unchanged", cleaned.length, mp4.length);
  const after = await parseVideo(cleaned);
  check("c2pa mp4: gone after strip", !after.fields.some((f) => f.label === "Content Credentials"));
  const text = [...cleaned].map((b) => String.fromCharCode(b)).join("");
  check("c2pa mp4: no manifest bytes left", !text.includes("Sora 2"));
}

{
  const mp4 = F.makeMp4({ topLevelUuid: F.bytes(F.XMP_UUID, "<x:xmpmeta>tracking id</x:xmpmeta>") });
  const meta = await parseVideo(mp4);
  check("mp4: top-level XMP found", meta.fields.some((f) => f.label === "XMP metadata"), labels(meta).join(","));
}

/* ---------------- motion photo: a video bolted onto a JPEG ---------------- */

{
  const hidden = F.makeMp4({
    udta: [F.textAtom("©xyz", "+21.1702+072.8311/"), F.textAtom("©mod", "Pixel 8 Pro")],
  });
  const jpeg = F.makeJpeg({ exif: exifBlob, trailer: hidden });
  const meta = parse(jpeg);
  check("motion photo: trailer found", has(meta, "Hidden video"), labels(meta).join(","));
  eq("motion photo: trailer kind", meta.trailer.kind, "video");
  eq("motion photo: trailer start is after EOI", meta.trailer.end - meta.trailer.start, hidden.length);

  // the hidden clip really is a parseable video
  const inner = await parseVideo(jpeg.subarray(meta.trailer.start));
  eq("motion photo: inner model", valueOf(inner, "Camera model"), "Pixel 8 Pro");
  check("motion photo: inner gps", inner.gps && Math.abs(inner.gps.lat - 21.1702) < 0.001);

  const cleaned = strip(jpeg);
  check("motion photo: file got smaller", cleaned.bytes.length < jpeg.length);
  check("motion photo: still lossless", cleaned.lossless === true);
  const after = parse(cleaned.bytes);
  check("motion photo: trailer gone", !has(after, "Hidden video"), labels(after).join(","));
  eq("motion photo: no trailer record", after.trailer, undefined);
  const tail = cleaned.bytes.subarray(cleaned.bytes.length - 2);
  check("motion photo: ends on EOI", tail[0] === 0xff && tail[1] === 0xd9, [...tail].join(","));
  check("motion photo: pixels survive", [...cleaned.bytes].join(",").includes("18,52,86,120"));
}

{
  // a plain JPEG must not grow a phantom trailer, and padding is not a payload
  const plain = F.makeJpeg({ exif: exifBlob });
  eq("plain jpeg: no trailer", parse(plain).trailer, undefined);
  const padded = F.makeJpeg({ exif: exifBlob, trailer: new Uint8Array(4) });
  eq("padded jpeg: padding ignored", parse(padded).trailer, undefined);
  const stripped = strip(padded);
  eq("padded jpeg: padding dropped", stripped.bytes.length, strip(plain).bytes.length);
}

{
  // Samsung closes its appended block with a SEF footer
  const sef = F.bytes("SEFH", new Uint8Array(24), "SEFT");
  const jpeg = F.makeJpeg({ exif: exifBlob, trailer: sef });
  const meta = parse(jpeg);
  check("samsung trailer: found", has(meta, "Samsung extra data"), labels(meta).join(","));
}

/* ---------------- RAW ---------------- */

{
  const { tiff } = F.makeRaw({ makerNote: new Uint8Array(64).fill(0x41) });
  const meta = parse(tiff);
  eq("raw: format", meta.format, "tiff");
  eq("raw: make", valueOf(meta, "Camera make"), "NIKON CORPORATION");
  eq("raw: model", valueOf(meta, "Camera model"), "NIKON Z 8");
  eq("raw: artist", valueOf(meta, "Artist"), "Roshan Ramani");
  eq("raw: dng serial", valueOf(meta, "Camera serial no."), "3021455");
  eq("raw: original file name", valueOf(meta, "Original file name"), "DSC_4821.NEF");
  check("raw: maker notes found", has(meta, "Maker notes"), labels(meta).join(","));
  check("raw: gps found", Boolean(meta.gps));

  const cleaned = strip(tiff);
  check("raw: strip is lossless", cleaned && cleaned.lossless === true);
  eq("raw: size unchanged", cleaned.bytes.length, tiff.length);
  const after = parse(cleaned.bytes);
  eq("raw: make gone", valueOf(after, "Camera make"), undefined);
  eq("raw: serial gone", valueOf(after, "Camera serial no."), undefined);
  eq("raw: original name gone", valueOf(after, "Original file name"), undefined);
  eq("raw: gps gone", after.gps, null);
  check("raw: maker notes gone", !has(after, "Maker notes"));

  // the structural tags a converter needs must survive untouched
  const width = readTiffTag(cleaned.bytes, 0x0100);
  eq("raw: ImageWidth survives", width, 8280);
  eq("raw: ImageLength survives", readTiffTag(cleaned.bytes, 0x0101), 5520);
  check("raw: entry headers kept", countTiffEntries(cleaned.bytes) === countTiffEntries(tiff), "IFD lost entries");
}

{
  // big-endian raw files must read the same way
  const tiff = F.makeTiff({ ifd0: [[0x010f, 2, "PENTAX"]], bigEndian: true });
  eq("raw: big-endian make", valueOf(parse(tiff), "Camera make"), "PENTAX");
}

/* ---------------- PDF ---------------- */

async function parsePdf(u8, name = "doc.pdf") {
  return call("parsePdfMetadata(__file)", { __file: asFile(u8, name, "application/pdf") });
}

{
  const pdf = F.makePdf({});
  const meta = await parsePdf(pdf);
  eq("pdf: format", meta.format, "pdf");
  eq("pdf: kind", meta.kind, "document");
  eq("pdf: pages", valueOf(meta, "Pages"), "1");
  eq("pdf: title", valueOf(meta, "Title"), "Quarterly figures");
  eq("pdf: author", valueOf(meta, "Author"), "Roshan Ramani");
  eq("pdf: producer", valueOf(meta, "Written by"), "Skia/PDF m151");
  eq("pdf: creator", valueOf(meta, "Created with"), "Microsoft Word");
  check("pdf: created stamp", (valueOf(meta, "Created") || "").includes("20260820"));
  check("pdf: xmp found", (valueOf(meta, "XMP metadata") || "").includes("Roshan Ramani"), valueOf(meta, "XMP metadata"));
  check("pdf: file identifier", has(meta, "File identifier"), labels(meta).join(","));

  const result = await call("stripPdfFile(__file, allPdfEdits(__meta))", {
    __file: asFile(pdf, "doc.pdf", "application/pdf"),
    __meta: meta,
  });
  const cleaned = new Uint8Array(await result.blob.arrayBuffer());
  eq("pdf: size unchanged", cleaned.length, pdf.length);

  const after = await parsePdf(cleaned);
  eq("pdf: title gone", valueOf(after, "Title"), undefined);
  eq("pdf: author gone", valueOf(after, "Author"), undefined);
  eq("pdf: producer gone", valueOf(after, "Written by"), undefined);
  eq("pdf: dates gone", valueOf(after, "Created"), undefined);
  eq("pdf: pages still known", valueOf(after, "Pages"), "1");

  const text = latin1(cleaned);
  check("pdf: no name left anywhere", !text.includes("Roshan Ramani"));
  check("pdf: page content untouched", text.includes("(hello there) Tj"));
  check("pdf: xref table untouched", text.includes("startxref"));
  check("pdf: object structure intact", (text.match(/\d+ 0 obj/g) || []).length >= 5);
  // the offsets in the xref must still point at real objects
  for (const offset of xrefOffsets(text)) {
    check(`pdf: xref offset ${offset} still lands on an object`, /^\d+ 0 obj/.test(text.slice(offset, offset + 20)));
  }
}

{
  // UTF-16 and hex-encoded strings are the normal case for non-ASCII titles
  const pdf = F.makePdf({ hexTitle: true, title: "Björk résumé" });
  const meta = await parsePdf(pdf);
  eq("pdf: hex string title", valueOf(meta, "Title"), "Björk résumé");
  const result = await call("stripPdfFile(__file, allPdfEdits(__meta))", {
    __file: asFile(pdf, "doc.pdf", "application/pdf"),
    __meta: meta,
  });
  const cleaned = new Uint8Array(await result.blob.arrayBuffer());
  const text = latin1(cleaned);
  check("pdf: hex title blanked to zeros", /\/Title <0+>/.test(text), text.slice(text.indexOf("/Title"), text.indexOf("/Title") + 40));
  eq("pdf: hex title gone", valueOf(await parsePdf(cleaned), "Title"), undefined);
}

{
  // an encrypted PDF is declined rather than damaged
  const pdf = F.makePdf({ encrypted: true });
  const meta = await parsePdf(pdf);
  check("pdf: encryption reported", has(meta, "Encrypted"), labels(meta).join(","));
  eq("pdf: nothing offered for removal", meta.fields.filter((f) => f.edits).length, 0);
}

/* ---------------- audio ---------------- */

async function parseAudio(u8, name, type) {
  return call("parseAudioMetadata(__file)", { __file: asFile(u8, name, type) });
}

async function stripAudio(u8, name, type, meta) {
  const result = await call("stripAudioFile(__file, __meta, __meta.format === 'm4a' ? allVideoEdits(__meta) : allAudioEdits(__meta))", {
    __file: asFile(u8, name, type),
    __meta: meta,
  });
  return new Uint8Array(await result.blob.arrayBuffer());
}

{
  const mp3 = F.makeMp3({});
  const meta = await parseAudio(mp3, "memo.mp3", "audio/mpeg");
  eq("mp3: format", meta.format, "mp3");
  eq("mp3: kind", meta.kind, "audio");
  eq("mp3: title", valueOf(meta, "Title"), "Voice memo 12");
  eq("mp3: artist", valueOf(meta, "Artist"), "Roshan Ramani");
  check("mp3: id3v1 found", has(meta, "ID3v1 tag"), labels(meta).join(","));

  const cleaned = await stripAudio(mp3, "memo.mp3", "audio/mpeg", meta);
  check("mp3: file shrank", cleaned.length < mp3.length);
  const after = await parseAudio(cleaned, "memo.mp3", "audio/mpeg");
  eq("mp3: nothing left", after.fields.length, 0);
  eq("mp3: starts on a frame header", cleaned[0], 0xff);
  check("mp3: audio frames untouched", cleaned.length === 417, `got ${cleaned.length}`);
  check("mp3: payload survives", cleaned[4] === 0x55 && cleaned[400] === 0x55);
}

{
  const wav = F.makeWav({});
  const meta = await parseAudio(wav, "memo.wav", "audio/wav");
  eq("wav: format", meta.format, "wav");
  eq("wav: title", valueOf(meta, "Title"), "Voice memo 12");
  eq("wav: software", valueOf(meta, "Software"), "Zoom H6essential");
  check("wav: broadcast chunk read", (valueOf(meta, "Broadcast metadata") || "").includes("Roshan Ramani"), valueOf(meta, "Broadcast metadata"));

  const cleaned = await stripAudio(wav, "memo.wav", "audio/wav", meta);
  eq("wav: size unchanged", cleaned.length, wav.length);
  const after = await parseAudio(cleaned, "memo.wav", "audio/wav");
  eq("wav: nothing left", after.fields.length, 0);
  const text = latin1(cleaned);
  check("wav: chunks renamed JUNK", text.includes("JUNK"), "no JUNK chunk");
  check("wav: no name left", !text.includes("Roshan Ramani"));
  check("wav: fmt chunk kept", text.includes("fmt "));
  check("wav: data chunk kept", text.includes("data"));
  // samples must come through byte for byte
  const dataAt = text.indexOf("data") + 8;
  check("wav: samples untouched", cleaned[dataAt] === 0 && cleaned[dataAt + 1] === 7 && cleaned[dataAt + 2] === 14);
}

{
  const flac = F.makeFlac({});
  const meta = await parseAudio(flac, "memo.flac", "audio/flac");
  eq("flac: format", meta.format, "flac");
  eq("flac: title", valueOf(meta, "Title"), "Voice memo 12");
  eq("flac: location tag", valueOf(meta, "Location"), "21.1702, 72.8311");
  check("flac: cover art found", has(meta, "Cover art"), labels(meta).join(","));

  const cleaned = await stripAudio(flac, "memo.flac", "audio/flac", meta);
  eq("flac: size unchanged", cleaned.length, flac.length);
  const after = await parseAudio(cleaned, "memo.flac", "audio/flac");
  eq("flac: nothing left", after.fields.length, 0);
  // the comment block must now be a PADDING block, and STREAMINFO untouched
  eq("flac: signature kept", latin1(cleaned.subarray(0, 4)), "fLaC");
  eq("flac: streaminfo type kept", cleaned[4] & 0x7f, 0);
  eq("flac: comment block became padding", cleaned[42] & 0x7f, 1);
  check("flac: last-block flag preserved", (cleaned[42] & 0x80) === (flac[42] & 0x80));
  check("flac: no name left", !latin1(cleaned).includes("Roshan Ramani"));
}

{
  const opus = F.makeOpus();
  const meta = await parseAudio(opus, "memo.opus", "audio/ogg");
  eq("opus: format", meta.format, "ogg");
  eq("opus: title", valueOf(meta, "Title"), "Voice memo 12");
  eq("opus: artist", valueOf(meta, "Artist"), "Roshan Ramani");

  const cleaned = await stripAudio(opus, "memo.opus", "audio/ogg", meta);
  eq("opus: size unchanged", cleaned.length, opus.length);
  const after = await parseAudio(cleaned, "memo.opus", "audio/ogg");
  eq("opus: nothing left", after.fields.length, 0);
  check("opus: no name left", !latin1(cleaned).includes("Roshan Ramani"));
  check("opus: OpusHead page untouched", latin1(cleaned).includes("OpusHead"));

  // every page checksum must still validate, checked against an independent
  // implementation of the Ogg CRC rather than the app's own
  for (const page of oggPages(cleaned)) {
    const stored = new DataView(page.buffer, page.byteOffset, page.length).getUint32(22, true);
    eq(`opus: page ${page.sequence} checksum valid`, stored, F.oggCrcReference(page));
  }
}

/* ---------------- folder mode ---------------- */

{
  const leakyJpeg = F.makeJpeg({ exif: exifBlob, comment: "at home" });
  const cleanJpeg = F.makeJpeg({});
  const tree = F.fakeDirectory({
    "holiday.jpg": leakyJpeg,
    "already-clean.jpg": cleanJpeg,
    "notes.txt": F.bytes("nothing to see"),
    ".hidden.jpg": leakyJpeg,
    trip: {
      "clip.mp4": F.makeMp4({ udta: [F.textAtom("©xyz", "+21.1702+072.8311/")] }),
      "memo.mp3": F.makeMp3({}),
      "doc.pdf": F.makePdf({}),
    },
    "metastrip-clean": { "holiday-clean.jpg": leakyJpeg },
  });

  ctx.__tree = tree;
  const summary = await vm.runInContext("cleanFolder(__tree, {})", ctx);
  eq("folder: files seen", summary.seen, 5);
  eq("folder: cleaned", summary.cleaned, 4);
  eq("folder: already clean", summary.alreadyClean, 1);
  eq("folder: failures", summary.failed, 0);

  const written = F.writtenFiles(tree);
  const names = [...written.keys()].sort();
  check("folder: output mirrors structure", names.includes("metastrip-clean/trip/clip-clean.mp4"), names.join(","));
  check("folder: jpeg written", names.includes("metastrip-clean/holiday-clean.jpg"), names.join(","));
  check("folder: pdf written", names.includes("metastrip-clean/trip/doc-clean.pdf"), names.join(","));
  check("folder: skips non-media", !names.some((n) => n.endsWith(".txt")));
  check("folder: skips dotfiles", !names.some((n) => n.includes(".hidden")));
  check("folder: does not re-clean its own output", !names.some((n) => n.includes("clean-clean")), names.join(","));

  // the written files must actually be clean
  const outJpeg = written.get("metastrip-clean/holiday-clean.jpg");
  eq("folder: written jpeg has no fields", parse(outJpeg).fields.length, 0);
  eq("folder: written jpeg has no gps", parse(outJpeg).gps, null);
  const outVideo = written.get("metastrip-clean/trip/clip-clean.mp4");
  eq("folder: written video has no gps", (await parseVideo(outVideo)).gps, null);
}

{
  // stopping mid-run must leave everything after it untouched
  const tree = F.fakeDirectory({
    "a.jpg": F.makeJpeg({ exif: exifBlob }),
    "b.jpg": F.makeJpeg({ exif: exifBlob }),
    "c.jpg": F.makeJpeg({ exif: exifBlob }),
  });
  const flag = { stop: false };
  const summary = await call("cleanFolder(__tree, { shouldStop: __shouldStop, onProgress: __onProgress })", {
    __tree: tree,
    __shouldStop: () => flag.stop,
    __onProgress: () => { flag.stop = true; }, // stop after the first file starts
  });
  eq("folder: stop reported", summary.stopped, true);
  eq("folder: stopped after one file", summary.seen, 1);
  eq("folder: only one file written", F.writtenFiles(tree).size, 1);
}

/* ---------------- AI generator tags ---------------- */

{
  const a1111 = [
    "a photorealistic golden retriever wearing sunglasses, 85mm, bokeh",
    "Negative prompt: blurry, extra limbs, watermark",
    "Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 3820114457, Size: 1024x1024, Model hash: 31e35c80fc, Model: sd_xl_base_1.0",
  ].join("\n");
  const png = F.makePng([F.pngText("parameters", a1111)], { crc32 });
  const meta = parse(png);
  check("ai: tool named", has(meta, "AI prompt (Automatic1111 or Forge)"), labels(meta).join(","));
  check("ai: prompt read", (valueOf(meta, "AI prompt (Automatic1111 or Forge)") || "").startsWith("a photorealistic golden retriever"));
  check("ai: negative prompt read", (valueOf(meta, "AI negative prompt") || "").includes("extra limbs"));
  const settings = valueOf(meta, "AI settings") || "";
  check("ai: seed read", settings.includes("seed 3820114457"), settings);
  check("ai: model read", settings.includes("sd_xl_base_1.0"), settings);
  check("ai: steps read", settings.includes("28 steps"), settings);

  const after = parse(strip(png).bytes);
  eq("ai: removed by strip", after.fields.length, 0);
}

{
  const workflow = JSON.stringify({
    "3": { class_type: "KSampler", inputs: { seed: 987654321, steps: 30 } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a lighthouse in a storm, oil painting" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "low quality, jpeg artifacts" } },
  });
  const png = F.makePng([F.pngText("prompt", workflow)], { crc32 });
  const meta = parse(png);
  check("ai comfy: tool named", has(meta, "AI prompt (ComfyUI)"), labels(meta).join(","));
  check("ai comfy: prompt read", (valueOf(meta, "AI prompt (ComfyUI)") || "").includes("lighthouse in a storm"));
  const settings = valueOf(meta, "AI settings") || "";
  check("ai comfy: seed read", settings.includes("987654321"), settings);
  check("ai comfy: checkpoint read", settings.includes("flux1-dev"), settings);
}

{
  // a plain text chunk must not be dressed up as an AI tag
  const png = F.makePng([F.pngText("prompt", "please water the plants")], { crc32 });
  const meta = parse(png);
  check("ai: plain text not mislabelled", has(meta, "PNG prompt"), labels(meta).join(","));
  const software = F.makePng([F.pngText("Software", "NovelAI")], { crc32 });
  check("ai: software name recognised", has(parse(software), "AI prompt (NovelAI)"), labels(parse(software)).join(","));
  const other = F.makePng([F.pngText("Software", "GIMP 2.10")], { crc32 });
  check("ai: unrelated software left alone", has(parse(other), "PNG Software"), labels(parse(other)).join(","));
}

/* ---------------- linkage across files ---------------- */

{
  const withSerial = (serial, name) => ({
    name,
    meta: parse(F.makeJpeg({
      exif: F.makeTiff({
        ifd0: [[0x010f, 2, "Canon"], [0x0110, 2, "Canon EOS R5"]],
        exif: [[0xa431, 2, serial], [0x9003, 2, "2026:08:20 07:31:09"]],
      }),
    })),
  });

  const findings = call("computeLinkage(__entries)", {
    __entries: [withSerial("SN-11", "a.jpg"), withSerial("SN-11", "b.jpg"), withSerial("SN-99", "c.jpg")],
  });
  const serialFinding = findings.find((f) => f.detail.startsWith("Camera serial"));
  check("linkage: shared serial found", Boolean(serialFinding), JSON.stringify(findings.map((f) => f.detail)));
  eq("linkage: only the two matching files", serialFinding.files.join(","), "a.jpg,b.jpg");
  eq("linkage: serial is a strong link", serialFinding.kind, "strong");
  check("linkage: shared model also found", findings.some((f) => f.detail.startsWith("Camera model")));
  check("linkage: strong findings come first", findings[0].kind === "strong");

  eq("linkage: one file links to nothing", call("computeLinkage(__one)", { __one: [withSerial("SN-11", "a.jpg")] }).length, 0);
}

{
  // coordinates in the same building are one finding, not three
  const at = (lat, lon, name) => ({ name, meta: { fields: [], gps: { lat, lon } } });
  const findings = call("computeLinkage(__entries)", {
    __entries: [
      at(21.1702, 72.8311, "kitchen.jpg"),
      at(21.17025, 72.83115, "balcony.jpg"),
      at(21.1704, 72.8313, "street.jpg"),
      at(28.6139, 77.209, "delhi.jpg"),
    ],
  });
  const place = findings.filter((f) => f.text.includes("within 100 m"));
  eq("linkage: one place cluster", place.length, 1);
  eq("linkage: three files in it", place[0].files.length, 3);
  check("linkage: the far file is excluded", !place[0].files.includes("delhi.jpg"));
}

{
  // timestamps close together group, and a distant one does not
  const at = (stamp, name) => ({ name, meta: { fields: [{ label: "Taken", value: stamp }], gps: null } });
  const findings = call("computeLinkage(__entries)", {
    __entries: [
      at("2026:08:20 07:31:09", "a.jpg"),
      at("2026:08:20 07:35:00", "b.jpg"),
      at("2026:08:21 19:00:00", "c.jpg"),
    ],
  });
  const time = findings.filter((f) => f.text.includes("minutes of each other"));
  eq("linkage: one time run", time.length, 1);
  eq("linkage: two files in the run", time[0].files.join(","), "a.jpg,b.jpg");
}

{
  // a PDF and a photo can still be linked by the person named in both
  const pdfMeta = { fields: [{ label: "Author", value: "Roshan Ramani" }], gps: null };
  const photoMeta = { fields: [{ label: "Artist", value: "Roshan Ramani" }], gps: null };
  const findings = call("computeLinkage(__entries)", {
    __entries: [{ name: "cv.pdf", meta: pdfMeta }, { name: "headshot.jpg", meta: photoMeta }],
  });
  // different labels, so no single-field group: this must not report a match
  eq("linkage: different labels do not merge", findings.length, 0);
}

/* ---------------- receipt ---------------- */

{
  const entries = [
    {
      name: "holiday.jpg",
      bytesBefore: 4_200_000,
      bytesAfter: 4_180_000,
      removed: ["GPS location 21.1702, 72.8311", "Camera make", "Camera model"],
      remaining: [],
      hashBefore: "a".repeat(64),
      hashAfter: "b".repeat(64),
    },
    {
      name: "clip.mp4",
      bytesBefore: 900_000_000,
      bytesAfter: 900_000_000,
      removed: ["Content Credentials"],
      remaining: ["Duration"],
      hashNote: "not hashed, over 256 MB",
    },
  ];
  const text = call("formatReceipt(__entries, { generatedAt: __at })", {
    __entries: entries,
    __at: new Date(Date.UTC(2026, 7, 21, 10, 30, 0)),
  });

  check("receipt: names the tool", text.startsWith("MetaStrip"));
  check("receipt: fixed timestamp", text.includes("2026-08-21 10:30:00 UTC"), text.split("\n")[1]);
  check("receipt: says nothing was uploaded", text.includes("Nothing was uploaded"));
  check("receipt: lists both files", text.includes("1. holiday.jpg") && text.includes("2. clip.mp4"));
  check("receipt: reports removed fields", text.includes("removed: GPS location 21.1702, 72.8311, Camera make, Camera model"));
  check("receipt: reports what is left", text.includes("remaining: Duration"));
  check("receipt: reports nothing left", text.includes("remaining: nothing readable"));
  check("receipt: shows byte delta", text.includes("(20000 removed)"), text);
  check("receipt: notes in-place blanking", text.includes("(blanked in place)"));
  check("receipt: includes both hashes", text.includes(`sha256 before: ${"a".repeat(64)}`) && text.includes(`sha256 after:  ${"b".repeat(64)}`));
  check("receipt: explains the skip", text.includes("not hashed, over 256 MB"));
  check("receipt: gives a verification command", text.includes("shasum -a 256"));
  check("receipt: totals", text.includes("2 files cleaned in this session."));

  const empty = call("formatReceipt([], {})", {});
  check("receipt: empty case", empty.includes("No files cleaned yet."));
}

/* ---------------- pixel redaction ---------------- */

/* A stand-in for ImageData, since this runs outside a browser. */
function fakeImageData(width, height, fill = (x, y) => [x * 2, y * 3, 40, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = a;
    }
  }
  return { data, width, height };
}

const pixelAt = (image, x, y) => {
  const at = (y * image.width + x) * 4;
  return [image.data[at], image.data[at + 1], image.data[at + 2], image.data[at + 3]];
};

{
  const image = fakeImageData(32, 32);
  const changed = call("blackoutRegion(__image, { x: 4, y: 4, width: 8, height: 8 })", { __image: image });
  eq("redact: pixels changed", changed, 64);
  eq("redact: inside the box is black", pixelAt(image, 5, 5).join(","), "0,0,0,255");
  check("redact: outside the box untouched", pixelAt(image, 20, 20).join(",") !== "0,0,0,255");
  check("redact: edge just outside untouched", pixelAt(image, 12, 4).join(",") !== "0,0,0,255");
}

{
  // pixelate must destroy detail, not merely soften it: every pixel in a
  // block has to end up identical, so there is nothing to recover
  const image = fakeImageData(32, 32);
  call("pixelateRegion(__image, { x: 0, y: 0, width: 16, height: 16 }, 8)", { __image: image });
  const first = pixelAt(image, 0, 0).join(",");
  let uniform = true;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (pixelAt(image, x, y).join(",") !== first) uniform = false;
  check("redact: block is flat after pixelating", uniform);
  check("redact: next block differs", pixelAt(image, 9, 0).join(",") !== first);
  check("redact: outside the region untouched", pixelAt(image, 20, 20).join(",") === [40, 60, 40, 255].join(","));
}

{
  // a box drawn upwards and to the left, running off the edge, must still be
  // a sane box
  const box = call("normaliseBox({ x: 30, y: 40 }, { x: 10, y: 12 })", {});
  eq("redact: box normalised", JSON.stringify(box), JSON.stringify({ x: 10, y: 12, width: 20, height: 28 }));
  const clamped = call("clampBox({ x: -5, y: -5, width: 100, height: 100 }, 20, 20)", {});
  eq("redact: box clamped to the image", JSON.stringify(clamped), JSON.stringify({ x: 0, y: 0, width: 20, height: 20 }));
  eq("redact: stray click ignored", call("isUsefulBox({ x: 1, y: 1, width: 2, height: 2 })", {}), false);
  eq("redact: real drag kept", call("isUsefulBox({ x: 1, y: 1, width: 40, height: 9 })", {}), true);
}

{
  const cameraMeta = { fields: [{ label: "Camera model", value: "iPhone 15" }], gps: null };
  const plainMeta = { fields: [], gps: null };
  eq(
    "screenshot: phone screen size flagged",
    call("looksLikeScreenshot({ name: 'IMG_0421.png', meta: __m, width: 1179, height: 2556 })", { __m: plainMeta }),
    true
  );
  eq(
    "screenshot: camera metadata rules it out",
    call("looksLikeScreenshot({ name: 'IMG_0421.png', meta: __m, width: 1179, height: 2556 })", { __m: cameraMeta }),
    false
  );
  eq(
    "screenshot: name alone is enough",
    call("looksLikeScreenshot({ name: 'Screenshot 2026-08-21 at 10.02.11.png', meta: __m, width: 640, height: 480 })", { __m: plainMeta }),
    true
  );
  eq(
    "screenshot: ordinary photo not flagged",
    call("looksLikeScreenshot({ name: 'beach.jpg', meta: __m, width: 4032, height: 3024 })", { __m: plainMeta }),
    false
  );
}

/* ---------------- storage budget ---------------- */

{
  eq("storage: one kind", call("describeLoad({ photo: 3 })", {}), "3 photos");
  eq("storage: singular", call("describeLoad({ video: 1 })", {}), "1 video");
  eq(
    "storage: every kind reads naturally",
    call("describeLoad({ photo: 2, video: 1, audio: 1, document: 3 })", {}),
    "2 photos, 1 video, 1 audio file and 3 documents"
  );
  eq("storage: nothing open", call("describeLoad({})", {}), "nothing");

  const huge = call("checkStorageRoom({ name: 'big.mov', size: 3 * 1024 * 1024 * 1024, type: 'video/quicktime' })", {});
  eq("storage: oversized file refused", huge.ok, false);
  check("storage: refusal names the real number", huge.reason.includes("3.00 GB"), huge.reason);
  const fine = call("checkStorageRoom({ name: 'ok.jpg', size: 2000, type: 'image/jpeg' })", {});
  eq("storage: normal file accepted", fine.ok, true);
}

/* ---------------- one global scope ----------------
   These are plain scripts, not modules, so every top-level declaration lands
   in one shared scope and the last file loaded silently wins. That is how
   exif.js spent a while using video.js's text helper, which truncated at 160
   characters and quietly cut every AI prompt in half. */

{
  const declarations = new Map();
  const collisions = [];
  const everyScript = [...new Set([...SCRIPTS, ...DOM_SCRIPTS, "app.js", "motion.js"])];
  for (const name of everyScript) {
    const source = fs.readFileSync(path.join(JS_DIR, name), "utf8");
    for (const match of source.matchAll(/^(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
      const symbol = match[1];
      if (declarations.has(symbol)) collisions.push(`${symbol} in both ${declarations.get(symbol)} and ${name}`);
      else declarations.set(symbol, name);
    }
    for (const match of source.matchAll(/^const\s+([A-Z][A-Z0-9_]{2,})\s*=/gm)) {
      const symbol = match[1];
      if (declarations.has(symbol)) collisions.push(`${symbol} in both ${declarations.get(symbol)} and ${name}`);
      else declarations.set(symbol, name);
    }
  }
  check("scripts: no duplicate top-level names", collisions.length === 0, collisions.join("; "));
}

/* ---------------- report ---------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
