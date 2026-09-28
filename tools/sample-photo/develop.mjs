/* develop.mjs: paint the demo photos and write them into assets/.

     node develop.mjs

   assets/sample-sunset.jpg   the leaking one: a camera-style EXIF block with
                              device, lens, settings, both timestamps and GPS
   assets/sample-moonrise.jpg the already-clean one: no metadata at all

   The pictures come from paint.html. The EXIF is written here, by hand, as a
   big-endian TIFF with IFD0, an Exif IFD and a GPS IFD, the layout an iPhone
   writes, so the site's parser reads it the way it reads a real photo.

   The GPS is Ocean Beach, San Francisco: a public beach, looking west, with
   Lands End and Seal Rocks to the north, which is what the painting shows.
   The timestamp is a July evening a little before sunset there. */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ASSETS = path.join(import.meta.dirname, "..", "..", "assets");
const OUT_W = 1280, OUT_H = 800, QUALITY = 0.86;

const SUNSET = {
  make: "Apple",
  model: "iPhone 16 Pro Max",
  software: "26.2",
  taken: "2026:07:06 20:21:14",
  exposure: [1, 2000],
  fnumber: [178, 100],
  iso: 64,
  focal: [6765, 1000],
  lensMake: "Apple",
  lensModel: "iPhone 16 Pro Max back triple camera 6.765mm f/1.78",
  lat: 37.76458, lon: -122.51071, alt: 4,
};

// ---------- a minimal TIFF writer ----------
const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
function entry(tag, type, value) {
  // value: string for ASCII, number[] for the rest (a RATIONAL is [num, den])
  if (type === TYPE.ASCII) { const b = Buffer.from(value + "\0", "latin1"); return { tag, type, count: b.length, data: b }; }
  const vals = type === TYPE.RATIONAL ? value : [].concat(value);
  const count = type === TYPE.RATIONAL ? vals.length / 2 : vals.length;
  const b = Buffer.alloc(count * SIZE[type]);
  vals.forEach((v, i) => {
    if (type === TYPE.BYTE) b.writeUInt8(v, i);
    else if (type === TYPE.SHORT) b.writeUInt16BE(v, i * 2);
    else b.writeUInt32BE(v, i * 4);
  });
  return { tag, type, count, data: b };
}
// Lay out IFDs one after another; values over 4 bytes go after each IFD.
// Pointer tags (Exif, GPS) are patched once the offsets are known.
function tiff(ifds) {
  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  const offsets = []; let pos = 8;
  for (const es of ifds) {
    offsets.push(pos);
    const extra = es.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);
    pos += 2 + es.length * 12 + 4 + extra;
  }
  const out = Buffer.alloc(pos); header.copy(out, 0);
  ifds.forEach((es, k) => {
    es.sort((a, b) => a.tag - b.tag);
    let p = offsets[k], extra = p + 2 + es.length * 12 + 4;
    out.writeUInt16BE(es.length, p); p += 2;
    for (const e of es) {
      out.writeUInt16BE(e.tag, p); out.writeUInt16BE(e.type, p + 2); out.writeUInt32BE(e.count, p + 4);
      const data = e.pointsTo !== undefined ? (() => { const b = Buffer.alloc(4); b.writeUInt32BE(offsets[e.pointsTo]); return b; })() : e.data;
      if (data.length <= 4) data.copy(out, p + 8);
      else { out.writeUInt32BE(extra, p + 8); data.copy(out, extra); extra += data.length + (data.length % 2); }
      p += 12;
    }
    out.writeUInt32BE(0, p);   // no next IFD
  });
  return out;
}
const dms = (deg) => {
  const a = Math.abs(deg), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000);
  return [d, 1, m, 1, s, 10000];
};
function exifFor(p) {
  const pointer = (tag, to) => ({ tag, type: TYPE.LONG, count: 1, data: Buffer.alloc(4), pointsTo: to });
  const ifd0 = [
    entry(0x010f, TYPE.ASCII, p.make), entry(0x0110, TYPE.ASCII, p.model),
    entry(0x0131, TYPE.ASCII, p.software), entry(0x0132, TYPE.ASCII, p.taken),
    pointer(0x8769, 1), pointer(0x8825, 2),
  ];
  const exif = [
    entry(0x829a, TYPE.RATIONAL, p.exposure), entry(0x829d, TYPE.RATIONAL, p.fnumber),
    entry(0x8827, TYPE.SHORT, p.iso), entry(0x9003, TYPE.ASCII, p.taken),
    entry(0x920a, TYPE.RATIONAL, p.focal),
    entry(0xa002, TYPE.LONG, OUT_W), entry(0xa003, TYPE.LONG, OUT_H),
    entry(0xa433, TYPE.ASCII, p.lensMake), entry(0xa434, TYPE.ASCII, p.lensModel),
  ];
  const gps = [
    entry(0x0001, TYPE.ASCII, p.lat >= 0 ? "N" : "S"), entry(0x0002, TYPE.RATIONAL, dms(p.lat)),
    entry(0x0003, TYPE.ASCII, p.lon >= 0 ? "E" : "W"), entry(0x0004, TYPE.RATIONAL, dms(p.lon)),
    entry(0x0005, TYPE.BYTE, 0), entry(0x0006, TYPE.RATIONAL, [p.alt, 1]),
  ];
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff([ifd0, exif, gps])]);
  const seg = Buffer.alloc(4); seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}

// ---------- paint and encode ----------
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto("file://" + path.join(import.meta.dirname, "paint.html"));
const encode = (scene) => page.evaluate((scene, w, h, q) => {
  paint(scene);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const o = out.getContext("2d"); o.imageSmoothingQuality = "high";
  o.drawImage(document.getElementById("c"), 0, 0, w, h);
  return out.toDataURL("image/jpeg", q).split(",")[1];
}, scene, OUT_W, OUT_H, QUALITY);
const sunsetJpeg = Buffer.from(await encode("golden"), "base64");
const moonJpeg = Buffer.from(await encode("blue"), "base64");
await browser.close();

// A camera puts EXIF in APP1 straight after the start-of-image marker.
const sunset = Buffer.concat([sunsetJpeg.subarray(0, 2), exifFor(SUNSET), sunsetJpeg.subarray(2)]);
fs.writeFileSync(path.join(ASSETS, "sample-sunset.jpg"), sunset);
fs.writeFileSync(path.join(ASSETS, "sample-moonrise.jpg"), moonJpeg);
console.log(`sample-sunset.jpg ${sunset.length} B, sample-moonrise.jpg ${moonJpeg.length} B`);
