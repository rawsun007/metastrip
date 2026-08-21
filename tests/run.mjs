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
const SCRIPTS = ["c2pa.js", "exif.js", "stripper.js", "video.js"];

const ctx = vm.createContext({ console, File, Blob, DataView, Uint8Array, TextDecoder, TextEncoder });
for (const name of SCRIPTS) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, name), "utf8"), ctx, { filename: name });
}
const call = (expr, args = {}) => {
  Object.assign(ctx, args);
  return vm.runInContext(expr, ctx);
};

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

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

/* ---------------- report ---------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
