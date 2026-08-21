/* MetaStrip — metadata parser.
   Reads EXIF (JPEG APP1 + PNG eXIf), PNG text chunks, and GPS IFD.
   Pure byte-level parsing, no dependencies, runs entirely in the browser. */

/* Each tag carries its own risk category up front, rather than being
   inferred from a shared per-IFD default plus regex patches, so a new
   tag can never silently inherit the wrong icon. */
const IFD0_TAGS = {
  0x010f: { label: "Camera make", risk: "device" },
  0x00fe: null, // NewSubfileType: structural, never a leak
  0x02bc: { label: "XMP packet", risk: "device" },
  0xc614: { label: "Camera model (DNG)", risk: "device" },
  0xc62f: { label: "Camera serial no.", risk: "identity" },
  0xc68b: { label: "Original file name", risk: "identity" },
  0xc6fe: { label: "Original raw name", risk: "identity" },
  0x9c9b: { label: "Windows title", risk: "identity" },
  0x9c9c: { label: "Windows comment", risk: "identity" },
  0x9c9d: { label: "Windows author", risk: "identity" },
  0x9c9e: { label: "Windows keywords", risk: "identity" },
  0x9c9f: { label: "Windows subject", risk: "identity" },
  0x0110: { label: "Camera model", risk: "device" },
  0x0131: { label: "Software", risk: "device" },
  0x0132: { label: "Modified", risk: "time" },
  0x013b: { label: "Artist", risk: "identity" },
  0x8298: { label: "Copyright", risk: "identity" },
};

const EXIF_TAGS = {
  0x9003: { label: "Taken", risk: "time" },
  0x9004: { label: "Digitized", risk: "time" },
  0x829a: { label: "Exposure time", risk: "settings" },
  0x829d: { label: "F-number", risk: "settings" },
  0x8827: { label: "ISO", risk: "settings" },
  0x920a: { label: "Focal length", risk: "settings" },
  0xa433: { label: "Lens make", risk: "device" },
  0xa434: { label: "Lens model", risk: "device" },
  0xa002: { label: "Pixel width", risk: "dimensions" },
  0xa003: { label: "Pixel height", risk: "dimensions" },
  0xa430: { label: "Owner name", risk: "identity" },
  0xa431: { label: "Camera serial no.", risk: "identity" },
  0xa435: { label: "Lens serial no.", risk: "identity" },
  0x9286: { label: "User comment", risk: "identity" },
  0xc4a5: { label: "Print image matching", risk: "device" },
};

const MAKER_NOTE_TAG = 0x927c;
const USER_COMMENT_TAG = 0x9286;
const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;
const SUB_IFDS_TAG = 0x014a;
const PREVIEW_OFFSET_TAG = 0x0201; // JPEGInterchangeFormat
const PREVIEW_LENGTH_TAG = 0x0202;

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

/** Parse metadata from an image ArrayBuffer. Returns { fields: [{label, value, risk}], gps: {lat, lon}|null } */
function parseMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes);
  if (isPng(bytes)) return parsePng(bytes);
  if (isHeic(bytes)) return parseHeic(bytes);
  if (tiffStartOf(bytes) >= 0) return parseTiffFile(bytes);
  return { fields: [], gps: null, format: "other" };
}

/* ---------- RAW ----------
   A raw file from a camera is a TIFF: DNG, CR2, NEF, ARW, ORF and PEF all
   open with a TIFF header and keep their metadata in ordinary IFDs, which is
   the same structure JPEG hides inside APP1. So the parser already written
   reads them; what changes is how they get cleaned.

   A raw file cannot have its IFD entries blanked wholesale the way an APP1
   blob can: entries must stay sorted by tag, and the structural ones point at
   the actual image strips. So raw removal blanks values in place and leaves
   every entry header standing, which keeps the file loadable by a converter
   while the personal parts read empty. */

const TIFF_MAGIC_LE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_MAGIC_BE = [0x4d, 0x4d, 0x00, 0x2a];
const ORF_MAGICS = [[0x49, 0x49, 0x52, 0x4f], [0x4d, 0x4d, 0x4f, 0x52], [0x49, 0x49, 0x52, 0x53]];
const FUJI_MAGIC = "FUJIFILMCCD-RAW";

/** Byte offset of the TIFF header, or -1 when this is not a TIFF-based file. */
function tiffStartOf(bytes) {
  if (bytes.length < 16) return -1;
  const at = (magic, offset = 0) => magic.every((b, i) => bytes[offset + i] === b);
  if (at(TIFF_MAGIC_LE) || at(TIFF_MAGIC_BE)) return 0;
  // Olympus writes a TIFF whose version field is its own marker
  if (ORF_MAGICS.some((m) => at(m))) return 0;
  // Fujifilm wraps a TIFF inside its own container, at an offset it records
  if (asciiSlice(bytes, 0, 15) === FUJI_MAGIC) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const offset = view.getUint32(84);
    if (offset > 0 && offset + 8 < bytes.length) return offset;
  }
  return -1;
}

function parseTiffFile(bytes) {
  const result = { fields: [], gps: null, format: "tiff", kind: "image", previews: [] };
  const tiffStart = tiffStartOf(bytes);
  if (tiffStart < 0) return result;
  parseTiff(bytes, tiffStart, result, null, { blankValuesOnly: true, followChain: true });
  describePreviews(result);
  return result;
}

/* Every raw file carries at least one fully rendered JPEG of the picture so
   that a viewer has something to show. People do not know it is in there, and
   it survives anything that only edits the raw data. */
function describePreviews(result) {
  const total = result.previews.reduce((n, p) => n + (p.end - p.start), 0);
  if (!total) return;
  result.fields.push({
    label: "Embedded preview",
    value: `${result.previews.length} rendered JPEG${result.previews.length === 1 ? "" : "s"} of this photo, ${formatTrailerSize(total)}`,
    risk: "device",
    mode: "zero",
    ranges: result.previews.map((p) => [p.start, p.end]),
  });
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1"]);

function isHeic(b) {
  if (b.length < 12) return false;
  if (asciiSlice(b, 4, 8) !== "ftyp") return false;
  return HEIC_BRANDS.has(asciiSlice(b, 8, 12));
}

/* HEIC embeds its EXIF as a verbatim TIFF blob behind an "Exif\0\0"
   signature, so a signature scan plus the shared TIFF parser reads it
   without touching the ISO-BMFF box tree. */
function parseHeic(bytes) {
  const result = { fields: [], gps: null, format: "heic" };
  const limit = bytes.length - 6;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 &&
        bytes[i + 3] === 0x66 && bytes[i + 4] === 0 && bytes[i + 5] === 0) {
      parseTiff(bytes, i + 6, result, null);
      break;
    }
  }
  readHeicC2pa(bytes, result);
  return result;
}

/* HEIF keeps Content Credentials in a uuid box stamped with the C2PA
   identifier. Only the payload is cleared, so the box chain the image itself
   depends on stays intact. */
function readHeicC2pa(bytes, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let offset = 0;
  let guard = 0;
  while (offset + 8 <= bytes.length && guard++ < 4096) {
    let size = view.getUint32(offset);
    const type = asciiSlice(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize) return;
    const end = Math.min(offset + size, bytes.length);
    if (type === "uuid" && isC2paUuid(bytes, offset + headerSize)) {
      const payloadStart = offset + headerSize + 16;
      const analysis = analyzeC2paManifest(bytes, payloadStart, end);
      for (const field of c2paFields(analysis, { mode: "zero", ranges: [[payloadStart, end]] })) {
        result.fields.push(field);
      }
    }
    offset = end;
  }
}

function isPng(b) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/* ---------- JPEG ---------- */

function parseJpeg(bytes) {
  const result = { fields: [], gps: null, format: "jpeg" };
  // a manifest larger than a segment is split across several APP11s, so they
  // are collected and read as one
  const app11 = { ranges: [], payload: [] };
  let offset = 2;
  let scanStart = -1;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      scanStart = offset; // SOS / EOI — no more headers, but a tail may follow
      break;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segStart = offset + 4;
    if (marker === 0xe1 && hasPrefix(bytes, segStart, "Exif\0\0")) {
      parseTiff(bytes, segStart + 6, result, null);
    } else if (marker === 0xe1 && hasPrefix(bytes, segStart, "http://ns.adobe.com/xap/1.0/")) {
      result.fields.push({
        label: "XMP metadata", value: "present (editing history, IDs)", risk: "device",
        mode: "zero", ranges: [[segStart, segStart + length - 2]],
      });
    } else if (marker === 0xeb && hasPrefix(bytes, segStart, "JP")) {
      // APP11: 'JP', box instance number, packet sequence number, then JUMBF
      const bodyStart = segStart + 8;
      const bodyEnd = segStart + length - 2;
      app11.ranges.push([offset, segStart + length - 2]);
      if (bodyEnd > bodyStart) app11.payload.push(bytes.subarray(bodyStart, bodyEnd));
    } else if (marker === 0xfe) {
      const comment = asciiSlice(bytes, segStart, Math.min(segStart + length - 2, bytes.length)).trim();
      if (comment) result.fields.push({
        label: "Comment", value: comment, risk: "device",
        mode: "zero", ranges: [[segStart, segStart + length - 2]],
      });
    }
    offset = segStart + length - 2;
  }
  if (app11.payload.length) readEmbeddedC2pa(app11, result);
  if (scanStart >= 0) readJpegTrailer(bytes, scanStart, result);
  return result;
}

/* ---------- what comes after the picture ----------
   A Pixel or Galaxy "motion photo" is a JPEG with an entire MP4 bolted on
   after the end-of-image marker, carrying its own GPS, camera model and
   timestamps. Nothing in the JPEG spec says to look there, so most cleaners
   copy it straight through and call the file clean.

   Finding the real end of the image is exact rather than a guess: inside
   entropy-coded data every 0xFF byte is stuffed as FF 00 and restart markers
   only run FFD0-FFD7, so the first FFD9 after the scan is the true EOI. */
function readJpegTrailer(bytes, scanStart, result) {
  const eoi = findJpegEoi(bytes, scanStart);
  if (eoi < 0) return;
  const start = eoi + 2;
  const size = bytes.length - start;
  if (size < 16) return; // padding, not a payload

  const kind = classifyTrailer(bytes, start);
  result.trailer = { start, end: bytes.length, kind, size };
  result.fields.push({
    label: kind === "video" ? "Hidden video" : kind === "samsung" ? "Samsung extra data" : "Appended data",
    value:
      kind === "video"
        ? `a whole MP4 bolted on after the image, ${formatTrailerSize(size)}`
        : `${formatTrailerSize(size)} of extra data after the image`,
    risk: "device",
    mode: "cut",
    chunkRange: [start, bytes.length],
  });
}

function findJpegEoi(bytes, from) {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i;
  }
  return -1;
}

function classifyTrailer(bytes, start) {
  if (asciiSlice(bytes, start + 4, start + 8) === "ftyp") return "video";
  // Samsung closes its appended block with a SEFT footer
  const tailStart = Math.max(start, bytes.length - 64);
  if (asciiSlice(bytes, tailStart, bytes.length).includes("SEF")) return "samsung";
  return "data";
}

function formatTrailerSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* JPEG can drop whole APP11 segments: marker segments are self-delimiting and
   nothing in the file points into them. */
function readEmbeddedC2pa(app11, result) {
  const joined = concatChunks(app11.payload);
  const analysis = analyzeC2paManifest(joined, 0, joined.length);
  const fields = c2paFields(analysis, { mode: "cut", chunkRanges: app11.ranges });
  for (const field of fields) result.fields.push(field);
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function hasPrefix(bytes, offset, str) {
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function asciiSlice(bytes, start, end) {
  let s = "";
  for (let i = start; i < end; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : "";
  }
  return s;
}

/* ---------- TIFF / IFD (shared by JPEG EXIF and PNG eXIf) ---------- */

function parseTiff(bytes, tiffStart, result, crcChunk, options = {}) {
  if (tiffStart + 8 > bytes.length) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const le = bytes[tiffStart] === 0x49; // "II" little-endian, "MM" big-endian
  const version = view.getUint16(tiffStart + 2, le);
  // 42 is TIFF; Olympus and a few others stamp their own version here
  if (version !== 42 && !options.blankValuesOnly) return;
  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, le);

  const firstField = result.fields.length;
  const pointers = {};
  let next = readIfd(view, bytes, tiffStart, ifd0, le, IFD0_TAGS, result.fields, pointers, options, result);
  // a raw file chains further IFDs, and that is where the previews live
  let guard = 0;
  while (options.followChain && next && guard++ < 8) {
    const at = tiffStart + next;
    if (at + 2 > bytes.length) break;
    next = readIfd(view, bytes, tiffStart, at, le, IFD0_TAGS, result.fields, pointers, options, result);
  }
  for (const sub of pointers.subIfds || []) {
    readIfd(view, bytes, tiffStart, tiffStart + sub, le, IFD0_TAGS, result.fields, pointers, options, result);
  }
  if (pointers[EXIF_IFD_POINTER]) {
    readIfd(view, bytes, tiffStart, tiffStart + pointers[EXIF_IFD_POINTER].value, le, EXIF_TAGS, result.fields, pointers, options, result);
  }
  if (pointers[GPS_IFD_POINTER]) {
    result.gps = readGps(view, bytes, tiffStart, tiffStart + pointers[GPS_IFD_POINTER].value, le);
    if (result.gps) {
      // also blank the pointer entry itself so nothing references the dead IFD
      result.gps.ranges.push([pointers[GPS_IFD_POINTER].offset, pointers[GPS_IFD_POINTER].offset + 12]);
      result.gps.mode = "zero";
      if (crcChunk) result.gps.crcChunk = crcChunk;
    }
  }
  if (crcChunk) {
    for (let i = firstField; i < result.fields.length; i++) result.fields[i].crcChunk = crcChunk;
  }
}

function readIfd(view, bytes, tiffStart, ifdOffset, le, tagMap, fields, pointers, options = {}, result = null) {
  if (ifdOffset + 2 > bytes.length) return 0;
  const count = view.getUint16(ifdOffset, le);
  let preview = {};
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > bytes.length) return 0;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const num = view.getUint32(entry + 4, le);
    const size = (TYPE_SIZES[type] || 1) * num;

    if (tag === EXIF_IFD_POINTER || tag === GPS_IFD_POINTER) {
      pointers[tag] = { value: view.getUint32(entry + 8, le), offset: entry };
      continue;
    }
    if (tag === SUB_IFDS_TAG) {
      pointers.subIfds = pointers.subIfds || [];
      const listAt = size > 4 ? tiffStart + view.getUint32(entry + 8, le) : entry + 8;
      for (let k = 0; k < Math.min(num, 8); k++) {
        if (listAt + k * 4 + 4 > bytes.length) break;
        pointers.subIfds.push(view.getUint32(listAt + k * 4, le));
      }
      continue;
    }
    // the rendered JPEG a raw file keeps for viewers to display
    if (tag === PREVIEW_OFFSET_TAG) preview.start = tiffStart + view.getUint32(entry + 8, le);
    if (tag === PREVIEW_LENGTH_TAG) preview.length = view.getUint32(entry + 8, le);

    const valueRanges = () => {
      if (options.blankValuesOnly) {
        // keep the entry header so the IFD stays sorted and valid
        return size > 4
          ? valueBlockRange(view, bytes, tiffStart, entry, size, le)
          : [[entry + 8, entry + 12]];
      }
      const ranges = [[entry, entry + 12]];
      if (size > 4) ranges.push(...valueBlockRange(view, bytes, tiffStart, entry, size, le));
      return ranges;
    };

    if (tag === MAKER_NOTE_TAG && size > 4) {
      const block = valueRanges();
      // after a strip the entry header stays but the block is zeroed, and an
      // empty block is not something to report as present
      if (!block.length || allZero(bytes, block)) continue;
      fields.push({
        label: "Maker notes",
        value: `${formatTrailerSize(size)} of camera internals, often including a serial number`,
        risk: "identity",
        mode: "zero",
        ranges: block,
      });
      continue;
    }

    const tagInfo = tagMap[tag];
    if (!tagInfo) continue;

    const value = tag === USER_COMMENT_TAG
      ? asciiSlice(bytes, tiffStart + view.getUint32(entry + 8, le) + 8, tiffStart + view.getUint32(entry + 8, le) + size)
      : readTagValue(view, bytes, tiffStart, entry, type, num, le);
    if (value === null || value === "") continue;

    fields.push({ label: tagInfo.label, value: String(value), risk: tagInfo.risk, mode: "zero", ranges: valueRanges() });
  }

  if (result && preview.start && preview.length && preview.start + preview.length <= bytes.length) {
    result.previews = result.previews || [];
    result.previews.push({ start: preview.start, end: preview.start + preview.length });
  }
  const nextAt = ifdOffset + 2 + count * 12;
  return nextAt + 4 <= bytes.length ? view.getUint32(nextAt, le) : 0;
}

function allZero(bytes, ranges) {
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) if (bytes[i] !== 0) return false;
  }
  return true;
}

function valueBlockRange(view, bytes, tiffStart, entry, size, le) {
  const off = tiffStart + view.getUint32(entry + 8, le);
  return off + size <= bytes.length ? [[off, off + size]] : [];
}

function readTagValue(view, bytes, tiffStart, entry, type, num, le) {
  const size = (TYPE_SIZES[type] || 1) * num;
  const valueOffset = size <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, le);
  if (valueOffset + size > bytes.length) return null;

  switch (type) {
    case 2: // ASCII
      return asciiSlice(bytes, valueOffset, valueOffset + num).trim();
    case 3: // SHORT
      return num === 1 ? view.getUint16(valueOffset, le) : readArray(view, valueOffset, num, 2, (o) => view.getUint16(o, le));
    case 4: // LONG
      return num === 1 ? view.getUint32(valueOffset, le) : readArray(view, valueOffset, num, 4, (o) => view.getUint32(o, le));
    case 5: { // RATIONAL
      const rationals = readRationals(view, valueOffset, num, le, false);
      return rationals.length === 1 ? formatRational(rationals[0]) : rationals.map(formatRational).join(", ");
    }
    case 10: { // SRATIONAL
      const rationals = readRationals(view, valueOffset, num, le, true);
      return rationals.length === 1 ? formatRational(rationals[0]) : rationals.map(formatRational).join(", ");
    }
    default:
      return null;
  }
}

function readArray(view, offset, num, stride, reader) {
  const out = [];
  for (let i = 0; i < num; i++) out.push(reader(offset + i * stride));
  return out.join(", ");
}

function readRationals(view, offset, num, le, signed) {
  const out = [];
  for (let i = 0; i < num; i++) {
    const n = signed ? view.getInt32(offset + i * 8, le) : view.getUint32(offset + i * 8, le);
    const d = signed ? view.getInt32(offset + i * 8 + 4, le) : view.getUint32(offset + i * 8 + 4, le);
    out.push([n, d]);
  }
  return out;
}

function formatRational([n, d]) {
  if (!d) return String(n);
  if (n === 1 && d > 1) return `1/${d}`;
  const v = n / d;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/* ---------- GPS ---------- */

function readGps(view, bytes, tiffStart, gpsOffset, le) {
  if (gpsOffset + 2 > bytes.length) return null;
  const count = view.getUint16(gpsOffset, le);
  const raw = {};
  const ranges = [[gpsOffset, Math.min(gpsOffset + 2 + count * 12 + 4, bytes.length)]];
  for (let i = 0; i < count; i++) {
    const entry = gpsOffset + 2 + i * 12;
    if (entry + 12 > bytes.length) return null;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const num = view.getUint32(entry + 4, le);
    const size = (TYPE_SIZES[type] || 1) * num;
    if (size > 4) {
      const off = tiffStart + view.getUint32(entry + 8, le);
      if (off + size <= bytes.length) ranges.push([off, off + size]);
    }
    if (tag === 1 || tag === 3) { // LatRef / LonRef
      raw[tag] = asciiSlice(bytes, entry + 8, entry + 8 + 2);
    } else if (tag === 2 || tag === 4) { // Lat / Lon: 3 rationals
      const size = 8 * num;
      const off = size <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, le);
      if (off + size > bytes.length || num < 3) continue;
      raw[tag] = readRationals(view, off, 3, le, false).map(([n, d]) => (d ? n / d : 0));
    } else if (tag === 6) { // Altitude: 1 rational
      const off = tiffStart + view.getUint32(entry + 8, le);
      if (off + 8 <= bytes.length && type === 5) {
        const [[n, d]] = readRationals(view, off, 1, le, false);
        if (d) raw.alt = n / d;
      }
    }
  }
  if (!raw[2] || !raw[4]) return null;
  const lat = dmsToDecimal(raw[2]) * (raw[1] === "S" ? -1 : 1);
  const lon = dmsToDecimal(raw[4]) * (raw[3] === "W" ? -1 : 1);
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon, alt: raw.alt ?? null, ranges };
}

function dmsToDecimal([d, m, s]) {
  return d + m / 60 + s / 3600;
}

/* ---------- PNG ---------- */

const PNG_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);

function parsePng(bytes) {
  const result = { fields: [], gps: null, format: "png" };
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = asciiSlice(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + 4;
    if (type === "eXIf") {
      parseTiff(bytes, dataStart, result, { start: offset, dataStart, dataEnd: dataStart + length });
    } else if (PNG_TEXT_CHUNKS.has(type)) {
      const keyword = asciiSlice(bytes, dataStart, Math.min(dataStart + 80, dataStart + length));
      const valueStart = dataStart + keyword.length + 1;
      let value = type === "tEXt" ? asciiSlice(bytes, valueStart, dataStart + length) : "(embedded text)";
      if (value.length > 120) value = value.slice(0, 120) + "…";
      result.fields.push({ label: `PNG ${keyword || type}`, value, risk: "device", mode: "cut", chunkRange: [offset, chunkEnd] });
    } else if (type === "caBX") {
      const analysis = analyzeC2paManifest(bytes, dataStart, dataStart + length);
      for (const field of c2paFields(analysis, { mode: "cut", chunkRange: [offset, chunkEnd] })) {
        result.fields.push(field);
      }
    } else if (type === "tIME" && length >= 7) {
      const y = view.getUint16(dataStart);
      const [mo, day, h, mi, s] = [1, 2, 3, 4, 5].map((i) => bytes[dataStart + i]);
      result.fields.push({
        label: "Last modified",
        value: `${y}-${pad(mo)}-${pad(day)} ${pad(h)}:${pad(mi)}:${pad(s)}`,
        risk: "time",
        mode: "cut",
        chunkRange: [offset, chunkEnd],
      });
    }
    if (type === "IEND") break;
    offset = chunkEnd; // skip data + CRC
  }
  return result;
}

function pad(n) {
  return String(n).padStart(2, "0");
}
