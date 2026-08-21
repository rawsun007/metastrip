/* Synthetic files, built byte by byte in JS.

   No binary fixtures live in the repo: every test file is assembled here, so
   what each test depends on is readable, and a fixture can carry exactly the
   one weird structure a test is about (a JUMBF box, a video bolted onto a
   JPEG, an anamorphic track) without hunting for a real-world sample. */

export function bytes(...parts) {
  const flat = [];
  for (const part of parts) {
    if (typeof part === "number") flat.push(part & 0xff);
    else if (typeof part === "string") for (const c of part) flat.push(c.charCodeAt(0) & 0xff);
    else for (const b of part) flat.push(b & 0xff);
  }
  return Uint8Array.from(flat);
}

export const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
export const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
export const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/* ---------- TIFF / EXIF ----------
   Little-endian, values longer than four bytes are appended after the last
   IFD and referenced by offset, exactly as a camera writes them. */

function encodeValue(type, value) {
  if (type === 2) return bytes(value, 0); // ASCII, null terminated
  if (type === 3) return bytes(le16(value));
  if (type === 4) return bytes(le32(value));
  if (type === 5 || type === 10) {
    const out = [];
    for (const [n, d] of value) out.push(...le32(n), ...le32(d));
    return Uint8Array.from(out);
  }
  if (type === 7) return Uint8Array.from(value);
  throw new Error(`unsupported tiff type ${type}`);
}

function countOf(type, value, encoded) {
  if (type === 2) return encoded.length;
  if (type === 5 || type === 10) return value.length;
  if (type === 7) return encoded.length;
  return 1;
}

/** makeTiff({ ifd0: [[tag, type, value], ...], exif: [...], gps: [...] }) */
export function makeTiff({ ifd0 = [], exif = [], gps = [], bigEndian = false } = {}) {
  const w16 = bigEndian ? be16 : le16;
  const w32 = bigEndian ? be32 : le32;

  // lay out: header(8) IFD0 [EXIF IFD] [GPS IFD] then the overflow pool
  const prep = (entries) =>
    entries.map(([tag, type, value]) => {
      const encoded = encodeValue(type, value);
      return { tag, type, value, encoded, count: countOf(type, value, encoded) };
    });

  const ifd0Entries = prep(ifd0);
  const exifEntries = prep(exif);
  const gpsEntries = prep(gps);

  const pointerCount = (exifEntries.length ? 1 : 0) + (gpsEntries.length ? 1 : 0);
  const ifd0Size = 2 + (ifd0Entries.length + pointerCount) * 12 + 4;
  const exifSize = exifEntries.length ? 2 + exifEntries.length * 12 + 4 : 0;
  const gpsSize = gpsEntries.length ? 2 + gpsEntries.length * 12 + 4 : 0;

  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifd0Size;
  const gpsOffset = exifOffset + exifSize;
  let poolOffset = gpsOffset + gpsSize;

  const pool = [];
  const assign = (entry) => {
    if (entry.encoded.length <= 4) {
      entry.inline = [...entry.encoded, 0, 0, 0, 0].slice(0, 4);
      return;
    }
    entry.offset = poolOffset;
    pool.push(entry.encoded);
    poolOffset += entry.encoded.length + (entry.encoded.length % 2);
  };
  [...ifd0Entries, ...exifEntries, ...gpsEntries].forEach(assign);

  const entryBytes = (entry) => [
    ...w16(entry.tag),
    ...w16(entry.type),
    ...w32(entry.count),
    ...(entry.inline || w32(entry.offset)),
  ];

  const ifd = (entries, extraPointers = []) => {
    const all = [...entries.map(entryBytes), ...extraPointers];
    return bytes(w16(all.length), all.flat(), w32(0));
  };

  const pointers = [];
  if (exifEntries.length) pointers.push([...w16(0x8769), ...w16(4), ...w32(1), ...w32(exifOffset)]);
  if (gpsEntries.length) pointers.push([...w16(0x8825), ...w16(4), ...w32(1), ...w32(gpsOffset)]);

  const header = bytes(bigEndian ? "MM" : "II", w16(42), w32(ifd0Offset));
  const poolBytes = [];
  for (const chunk of pool) {
    poolBytes.push(...chunk);
    if (chunk.length % 2) poolBytes.push(0);
  }

  return bytes(
    header,
    ifd(ifd0Entries, pointers),
    exifEntries.length ? ifd(exifEntries) : [],
    gpsEntries.length ? ifd(gpsEntries) : [],
    poolBytes
  );
}

export const GPS_SURAT = [
  [1, 2, "N"],
  [2, 5, [[21, 1], [10, 1], [1272, 1000]]],
  [3, 2, "E"],
  [4, 5, [[72, 1], [49, 1], [5194, 1000]]],
  [6, 5, [[12, 1]]],
];

/* ---------- JPEG ---------- */

function segment(marker, payload) {
  return bytes(0xff, marker, be16(payload.length + 2), payload);
}

/** A JPEG whose entropy data is a stub: parsers walk markers, not pixels. */
export function makeJpeg({ exif, jumbf, comment, xmp, trailer, app2 } = {}) {
  const parts = [bytes(0xff, 0xd8)];
  if (exif) parts.push(segment(0xe1, bytes("Exif\0\0", exif)));
  if (xmp) parts.push(segment(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0", xmp)));
  if (app2) parts.push(segment(0xe2, bytes("ICC_PROFILE\0", app2)));
  if (jumbf) parts.push(segment(0xeb, bytes("JP", jumbf)));
  if (comment) parts.push(segment(0xfe, bytes(comment)));
  parts.push(bytes(0xff, 0xda, be16(12), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  parts.push(bytes(0x12, 0x34, 0x56, 0x78)); // stand-in scan data
  parts.push(bytes(0xff, 0xd9));
  if (trailer) parts.push(bytes(trailer));
  return bytes(...parts);
}

/* A C2PA manifest store, shaped like the real thing: a JUMBF superbox whose
   description box names c2pa, holding a CBOR-ish claim payload. The parser
   under test reads labels and strings, not full CBOR, so the payload here
   carries realistic strings in a realistic nesting. */
export function makeC2paJumbf({
  generator = "Adobe Firefly 3.0",
  signer = "Jane Photographer",
  action = "c2pa.created",
  aiGenerated = true,
} = {}) {
  const jumd = (type, label) =>
    jumbfBox("jumd", bytes(type, [0x00, 0x03], label, 0));
  const claim = bytes(
    "claim_generator", 0,
    generator, 0,
    "signature", 0,
    signer, 0,
    "actions", 0,
    action, 0,
    aiGenerated ? "c2pa.trainedAlgorithmicMedia" : "c2pa.digitalCapture", 0
  );
  const claimBox = jumbfBox("jumb", bytes(jumd("c2cl", "c2pa.claim"), jumbfBox("cbor", claim)));
  const assertionBox = jumbfBox("jumb", bytes(jumd("c2as", "c2pa.assertions"), jumbfBox("cbor", claim)));
  const manifest = jumbfBox("jumb", bytes(jumd("c2ma", "urn:uuid:test-manifest"), claimBox, assertionBox));
  return jumbfBox("jumb", bytes(jumd("c2pa", "c2pa"), manifest));
}

export function jumbfBox(type, payload) {
  return bytes(be32(payload.length + 8), type, payload);
}

/* ---------- PNG ---------- */

export function makePng(chunks = [], { crc32 } = {}) {
  const parts = [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const body = bytes(type, data);
    const crc = crc32 ? crc32(body, 0, body.length) : 0;
    return bytes(be32(data.length), body, be32(crc >>> 0));
  };
  parts.push(chunk("IHDR", bytes(be32(4), be32(4), [8, 2, 0, 0, 0])));
  for (const [type, data] of chunks) parts.push(chunk(type, bytes(data)));
  parts.push(chunk("IEND", bytes()));
  return bytes(...parts);
}

export const pngText = (keyword, value) => ["tEXt", bytes(keyword, 0, value)];

/* ---------- ISO-BMFF (MP4 / MOV / M4A) ---------- */

export function box(type, ...payload) {
  const body = bytes(...payload);
  return bytes(be32(body.length + 8), type, body);
}

export function makeMp4({
  udta = [],
  topLevelUuid = null,
  width = 1920,
  height = 1080,
  storedWidth = null,
  handler = "vide",
  codec = "avc1",
  duration = 96000,
  timescale = 48000,
  created = 3800000000,
} = {}) {
  const mvhd = box("mvhd", 0, [0, 0, 0], be32(created), be32(created), be32(timescale), be32(duration), new Uint8Array(80));
  const tkhd = box(
    "tkhd", 0, [0, 0, 7], be32(created), be32(created), be32(1), be32(0), be32(duration),
    new Uint8Array(52), be32(width * 65536), be32(height * 65536)
  );
  const stsd = box(
    "stsd", 0, [0, 0, 0], be32(1),
    box(codec, new Uint8Array(24), be16(storedWidth || width), be16(height), new Uint8Array(50))
  );
  const trak = box(
    "trak", tkhd,
    box("mdia", box("hdlr", 0, [0, 0, 0], "\0\0\0\0", handler, new Uint8Array(12)),
      box("minf", box("stbl", stsd)))
  );
  const children = [mvhd, trak];
  if (udta.length) children.push(box("udta", ...udta));
  const moov = box("moov", ...children);
  const parts = [box("ftyp", "isom", be32(512), "isomiso2avc1mp41"), box("mdat", new Uint8Array(64)), moov];
  if (topLevelUuid) parts.push(box("uuid", topLevelUuid));
  return bytes(...parts);
}

/** A QuickTime-style text atom: 2-byte size, 2-byte language, then text. */
export function textAtom(type, text) {
  return box(type, be16(text.length), be16(0), text);
}

export const XMP_UUID = [
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8,
  0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
];

/* ---------- Matroska ---------- */

export function ebml(id, payload) {
  const body = bytes(payload);
  const idBytes = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    const b = (id >>> shift) & 0xff;
    if (b || idBytes.length) idBytes.push(b);
  }
  // always the eight-byte length form (0x01 marker plus seven length bytes),
  // so nothing has to be measured twice
  const size = body.length;
  const len = [0x01, 0, 0, 0, (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff];
  return bytes(idBytes, len, body);
}

export function makeWebm({ title = "", tags = [], width = 1280, height = 720, displayWidth = null } = {}) {
  const info = ebml(0x1549a966, bytes(
    ebml(0x2ad7b1, bytes(be32(1000000).slice(1))),
    title ? ebml(0x7ba9, bytes(title)) : [],
    ebml(0x4d80, bytes("libebml v1.4.5")),
    ebml(0x5741, bytes("mkvmerge v88.0"))
  ));
  const video = ebml(0xe0, bytes(
    ebml(0xb0, bytes(be16(width))),
    ebml(0xba, bytes(be16(height))),
    displayWidth ? ebml(0x54b0, bytes(be16(displayWidth))) : [],
    displayWidth ? ebml(0x54ba, bytes(be16(height))) : []
  ));
  const tracks = ebml(0x1654ae6b, ebml(0xae, bytes(ebml(0x86, bytes("V_MPEG4/ISO/AVC")), video)));
  const tagList = tags.length
    ? ebml(0x1254c367, ebml(0x7373, bytes(...tags.map(([name, value]) =>
        ebml(0x67c8, bytes(ebml(0x45a3, bytes(name)), ebml(0x4487, bytes(value))))))))
    : bytes();
  const cluster = ebml(0x1f43b675, new Uint8Array(32));
  const segment = ebml(0x18538067, bytes(info, tracks, tagList, cluster));
  const header = ebml(0x1a45dfa3, bytes(ebml(0x4286, bytes(1))));
  return bytes(header, segment);
}
