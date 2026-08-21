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

/* A raw file is a TIFF: same header, same IFDs, plus the structural tags a
   converter needs and a rendered preview a viewer can show. */
export function makeRaw({ preview = null, makerNote = null, extra = [] } = {}) {
  const previewBytes = preview || bytes(0xff, 0xd8, 0xff, 0xe0, new Uint8Array(40), 0xff, 0xd9);
  const tiff = makeTiff({
    ifd0: [
      [0x0100, 4, 8280], // ImageWidth: structural, must survive
      [0x0101, 4, 5520], // ImageLength
      [0x010f, 2, "NIKON CORPORATION"],
      [0x0110, 2, "NIKON Z 8"],
      [0x0131, 2, "Ver.2.10"],
      [0x013b, 2, "Roshan Ramani"],
      [0xc62f, 2, "3021455"],
      [0xc68b, 2, "DSC_4821.NEF"],
      ...extra,
    ],
    exif: [
      [0x9003, 2, "2026:08:20 07:31:09"],
      [0xa431, 2, "SN-0428871"],
      ...(makerNote ? [[0x927c, 7, makerNote]] : []),
    ],
    gps: GPS_SURAT,
  });
  return { tiff, previewBytes };
}

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
  // APP11: 'JP', box instance number, packet sequence number, then the JUMBF
  if (jumbf) parts.push(segment(0xeb, bytes("JP", be16(1), be32(1), jumbf)));
  if (comment) parts.push(segment(0xfe, bytes(comment)));
  parts.push(bytes(0xff, 0xda, be16(12), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  parts.push(bytes(0x12, 0x34, 0x56, 0x78)); // stand-in scan data
  parts.push(bytes(0xff, 0xd9));
  if (trailer) parts.push(bytes(trailer));
  return bytes(...parts);
}

/* ---------- C2PA ----------
   Spec-shaped: a JUMBF superbox per level, each opening with a jumd
   description box whose type UUID is the four-character code followed by the
   JUMBF suffix, and CBOR payloads that a real decoder can read. */

const JUMBF_UUID_SUFFIX = [0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export function jumbfBox(type, payload) {
  return bytes(be32(payload.length + 8), type, payload);
}

function jumd(code, label) {
  const toggles = label ? 0x03 : 0x01;
  return jumbfBox("jumd", bytes(code, JUMBF_UUID_SUFFIX, toggles, label ? bytes(label, 0) : []));
}

function superbox(code, label, ...children) {
  return jumbfBox("jumb", bytes(jumd(code, label), ...children));
}

/* ---------- CBOR encoder (definite lengths only) ---------- */

function cborHead(major, value) {
  if (value < 24) return bytes((major << 5) | value);
  if (value < 0x100) return bytes((major << 5) | 24, value);
  if (value < 0x10000) return bytes((major << 5) | 25, be16(value));
  return bytes((major << 5) | 26, be32(value));
}

export function cbor(value) {
  if (value === null || value === undefined) return bytes(0xf6);
  if (value === true) return bytes(0xf5);
  if (value === false) return bytes(0xf4);
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
  }
  if (typeof value === "string") {
    const utf8 = new TextEncoder().encode(value);
    return bytes(cborHead(3, utf8.length), utf8);
  }
  if (value instanceof Uint8Array) return bytes(cborHead(2, value.length), value);
  if (Array.isArray(value)) return bytes(cborHead(4, value.length), ...value.map(cbor));
  const keys = Object.keys(value);
  return bytes(cborHead(5, keys.length), ...keys.map((k) => bytes(cbor(k), cbor(value[k]))));
}

/* A DER fragment carrying a common name, the way a signing certificate does:
   OID 2.5.4.3 then a UTF8String. */
function derCommonName(name) {
  const utf8 = new TextEncoder().encode(name);
  return bytes(0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, utf8.length, utf8);
}

export function makeC2paJumbf({
  generator = "Adobe Firefly 3.0",
  signer = "Jane Photographer",
  actions = ["c2pa.created", "c2pa.edited"],
  sourceType = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  author = null,
  ingredients = 0,
} = {}) {
  const claim = cbor({
    claim_generator: generator,
    instanceID: "xmp:iid:0f1e2d3c",
    assertions: actions.length,
  });
  const actionsAssertion = cbor({
    actions: actions.map((action, i) => ({
      action,
      softwareAgent: generator,
      ...(i === 0 && sourceType ? { digitalSourceType: sourceType } : {}),
    })),
  });

  const children = [
    superbox("c2cl", "c2pa.claim.v2", jumbfBox("cbor", claim)),
    superbox("c2as", "c2pa.assertions",
      superbox("c2as", "c2pa.actions.v2", jumbfBox("cbor", actionsAssertion))),
    superbox("c2cs", "c2pa.signature", jumbfBox("cbor", bytes(derCommonName(signer)))),
  ];
  if (author) {
    children.push(
      superbox("c2as", "stds.schema-org.CreativeWork",
        jumbfBox("json", bytes(JSON.stringify({ "@type": "CreativeWork", author: [{ name: author }] }))))
    );
  }
  for (let i = 0; i < ingredients; i++) {
    children.push(superbox("c2as", `c2pa.ingredient.v3__${i}`, jumbfBox("cbor", cbor({ title: `source-${i}.jpg` }))));
  }

  const manifest = superbox("c2ma", "urn:uuid:0000-test-manifest", ...children);
  return superbox("c2pa", "c2pa", manifest);
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

export const C2PA_UUID = [
  0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c,
  0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
];

export const XMP_UUID = [
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8,
  0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
];

/* ---------- audio ---------- */

function syncsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

/** An MP3 with an ID3v2.4 tag in front and an ID3v1 tag at the back. */
export function makeMp3({ frames = [["TIT2", "Voice memo 12"], ["TPE1", "Roshan Ramani"]], id3v1 = true } = {}) {
  const frameBytes = frames.map(([id, text]) => {
    const payload = bytes(0x03, text); // encoding 3 = UTF-8
    return bytes(id, syncsafe(payload.length), be16(0), payload);
  });
  const body = bytes(...frameBytes);
  const tag = bytes("ID3", 4, 0, 0, syncsafe(body.length), body);
  // a plausible MPEG frame header plus payload, which must survive untouched
  const audio = bytes(0xff, 0xfb, 0x90, 0x00, new Uint8Array(413).fill(0x55));
  const v1 = id3v1
    ? bytes("TAG", pad("Voice memo 12", 30), pad("Roshan Ramani", 30), pad("", 30), pad("2026", 4), pad("", 30), 0)
    : bytes();
  return bytes(tag, audio, v1);
}

function pad(text, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < Math.min(text.length, length); i++) out[i] = text.charCodeAt(i);
  return out;
}

function riffChunk(type, data) {
  const body = bytes(data);
  return bytes(type, le32(body.length), body, body.length % 2 ? [0] : []);
}

/** A WAV with an INFO list, a Broadcast Wave chunk and real sample data. */
export function makeWav({ info = true, bext = true } = {}) {
  const fmt = riffChunk("fmt ", bytes(le16(1), le16(1), le32(48000), le32(96000), le16(2), le16(16)));
  const samples = new Uint8Array(512);
  for (let i = 0; i < samples.length; i++) samples[i] = (i * 7) & 0xff;
  const data = riffChunk("data", samples);
  const chunks = [fmt];
  if (info) {
    chunks.push(riffChunk("LIST", bytes(
      "INFO",
      riffChunk("INAM", bytes("Voice memo 12", 0)),
      riffChunk("IART", bytes("Roshan Ramani", 0)),
      riffChunk("ISFT", bytes("Zoom H6essential", 0))
    )));
  }
  if (bext) {
    const description = pad("Interview, kitchen table", 256);
    const originator = pad("Roshan Ramani", 32);
    const reference = pad("REF-00421", 32);
    chunks.push(riffChunk("bext", bytes(description, originator, reference, pad("2026-08-20", 10), pad("07:31:09", 8), new Uint8Array(60))));
  }
  chunks.push(data);
  const body = bytes(...chunks);
  return bytes("RIFF", le32(body.length + 4), "WAVE", body);
}

function flacBlock(type, data, last = false) {
  const body = bytes(data);
  return bytes((last ? 0x80 : 0) | type, [(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body);
}

function vorbisComments(vendor, comments) {
  const encode = (text) => new TextEncoder().encode(text);
  const vendorBytes = encode(vendor);
  const parts = [le32(vendorBytes.length), vendorBytes, le32(comments.length)];
  for (const comment of comments) {
    const encoded = encode(comment);
    parts.push(le32(encoded.length), encoded);
  }
  return bytes(...parts.map((p) => bytes(p)));
}

/** A FLAC with a STREAMINFO block, comments and a picture block. */
export function makeFlac({ picture = true } = {}) {
  const streaminfo = flacBlock(0, new Uint8Array(34));
  const comments = flacBlock(4, vorbisComments("reference libFLAC 1.4.3", [
    "TITLE=Voice memo 12",
    "ARTIST=Roshan Ramani",
    "LOCATION=21.1702, 72.8311",
  ]), !picture);
  const parts = [bytes("fLaC"), streaminfo, comments];
  if (picture) parts.push(flacBlock(6, new Uint8Array(64).fill(0x99), true));
  parts.push(bytes(0xff, 0xf8, 0x69, 0x18, new Uint8Array(64).fill(0x33))); // frame
  return bytes(...parts);
}

/** An Ogg page carrying an OpusTags comment header, with a valid CRC. */
export function makeOpus() {
  const idHeader = bytes("OpusHead", 1, 1, le16(312), le32(48000), le16(0), 0);
  const tags = bytes("OpusTags", vorbisComments("libopus 1.4", [
    "TITLE=Voice memo 12",
    "ARTIST=Roshan Ramani",
  ]));
  return bytes(oggPage(idHeader, 0, 2), oggPage(tags, 1, 0));
}

export function oggPage(payload, sequence, headerType) {
  const body = bytes(payload);
  const segments = [];
  let left = body.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);
  const page = bytes(
    "OggS", 0, headerType,
    new Uint8Array(8), // granule position
    le32(0x1234), le32(sequence), le32(0), // serial, sequence, crc placeholder
    segments.length, segments, body
  );
  const view = new DataView(page.buffer, page.byteOffset, page.length);
  view.setUint32(22, oggCrcReference(page), true);
  return page;
}

/* An independent implementation of the Ogg page checksum, so the test is
   checking the app's version against something rather than itself. */
export function oggCrcReference(page) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i]; // the CRC field reads as zero
    crc = crc ^ (byte << 24);
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

/* ---------- PDF ----------
   A real, minimal PDF: one page, an information dictionary, an XMP packet and
   a cross-reference table whose offsets are computed from the assembled body,
   so a test can prove that cleaning did not move anything. */

export function makePdf({
  title = "Quarterly figures",
  author = "Roshan Ramani",
  producer = "Skia/PDF m151",
  creator = "Microsoft Word",
  xmp = true,
  encrypted = false,
  hexTitle = false,
} = {}) {
  const xmpPacket = xmp
    ? `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<xmp:CreatorTool>${creator}</xmp:CreatorTool>
<dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`
    : "";

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R" + (xmp ? " /Metadata 6 0 R" : "") + " >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 100 Td (hello there) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< " +
      (hexTitle ? `/Title <${toHex(title)}> ` : `/Title (${title}) `) +
      `/Author (${author}) /Creator (${creator}) /Producer (${producer}) ` +
      "/CreationDate (D:20260820073109+00'00') /ModDate (D:20260821102218+00'00') >>\nendobj\n",
  ];
  if (xmp) {
    objects.push(`6 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmpPacket.length} >>\nstream\n${xmpPacket}\nendstream\nendobj\n`);
  }

  const header = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  let body = "";
  const offsets = [];
  for (const object of objects) {
    offsets.push(header.length + body.length);
    body += object;
  }
  const xrefStart = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R` +
    (encrypted ? " /Encrypt 7 0 R" : "") +
    " /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] >>\n" +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return bytes(header + body + xref + trailer);
}

function toHex(text) {
  let out = "";
  for (const c of text) out += c.charCodeAt(0).toString(16).padStart(2, "0");
  return out;
}

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

/* ---------- fake File System Access handles ----------
   Enough of the API surface for the folder walk to run with no disk behind
   it: entries(), getFile(), getDirectoryHandle({create}) and a writable that
   records what was written. */

export function fakeDirectory(tree, name = "root") {
  const children = new Map();
  const written = new Map();

  for (const [key, value] of Object.entries(tree)) {
    if (value instanceof Uint8Array) {
      children.set(key, {
        kind: "file",
        name: key,
        async getFile() {
          return new File([value], key, { type: "" });
        },
      });
    } else {
      children.set(key, fakeDirectory(value, key));
    }
  }

  const handle = {
    kind: "directory",
    name,
    written,
    children,
    async *entries() {
      for (const [key, value] of children) yield [key, value];
    },
    async getDirectoryHandle(dirName, { create } = {}) {
      if (!children.has(dirName)) {
        if (!create) throw new Error(`no such directory ${dirName}`);
        children.set(dirName, fakeDirectory({}, dirName));
      }
      return children.get(dirName);
    },
    async getFileHandle(fileName, { create } = {}) {
      if (!children.has(fileName) && !create) throw new Error(`no such file ${fileName}`);
      return {
        kind: "file",
        name: fileName,
        async createWritable() {
          return {
            async write(blob) {
              written.set(fileName, new Uint8Array(await blob.arrayBuffer()));
            },
            async close() {},
          };
        },
      };
    },
  };
  return handle;
}

/* Collects every file written anywhere under a fake tree. */
export function writtenFiles(handle, prefix = "") {
  const out = new Map();
  for (const [name, bytes] of handle.written) out.set(prefix + name, bytes);
  for (const [name, child] of handle.children) {
    if (child.kind === "directory") {
      for (const [key, value] of writtenFiles(child, `${prefix}${name}/`)) out.set(key, value);
    }
  }
  return out;
}
