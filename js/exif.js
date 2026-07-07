/* MetaStrip — metadata parser.
   Reads EXIF (JPEG APP1 + PNG eXIf), PNG text chunks, and GPS IFD.
   Pure byte-level parsing, no dependencies, runs entirely in the browser. */

/* Each tag carries its own risk category up front, rather than being
   inferred from a shared per-IFD default plus regex patches, so a new
   tag can never silently inherit the wrong icon. */
const IFD0_TAGS = {
  0x010f: { label: "Camera make", risk: "device" },
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
};

const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

/** Parse metadata from an image ArrayBuffer. Returns { fields: [{label, value, risk}], gps: {lat, lon}|null } */
function parseMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes);
  if (isPng(bytes)) return parsePng(bytes);
  if (isHeic(bytes)) return parseHeic(bytes);
  return { fields: [], gps: null, format: "other" };
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
  return result;
}

function isPng(b) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/* ---------- JPEG ---------- */

function parseJpeg(bytes) {
  const result = { fields: [], gps: null, format: "jpeg" };
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI — no more headers
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segStart = offset + 4;
    if (marker === 0xe1 && hasPrefix(bytes, segStart, "Exif\0\0")) {
      parseTiff(bytes, segStart + 6, result, null);
    } else if (marker === 0xe1 && hasPrefix(bytes, segStart, "http://ns.adobe.com/xap/1.0/")) {
      result.fields.push({
        label: "XMP metadata", value: "present (editing history, IDs)", risk: "device",
        mode: "zero", ranges: [[segStart, segStart + length - 2]],
      });
    } else if (marker === 0xfe) {
      const comment = asciiSlice(bytes, segStart, Math.min(segStart + length - 2, bytes.length)).trim();
      if (comment) result.fields.push({
        label: "Comment", value: comment, risk: "device",
        mode: "zero", ranges: [[segStart, segStart + length - 2]],
      });
    }
    offset = segStart + length - 2;
  }
  return result;
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

function parseTiff(bytes, tiffStart, result, crcChunk) {
  if (tiffStart + 8 > bytes.length) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const le = bytes[tiffStart] === 0x49; // "II" little-endian, "MM" big-endian
  if (view.getUint16(tiffStart + 2, le) !== 42) return;
  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, le);

  const firstField = result.fields.length;
  const pointers = {};
  readIfd(view, bytes, tiffStart, ifd0, le, IFD0_TAGS, result.fields, pointers);
  if (pointers[EXIF_IFD_POINTER]) {
    readIfd(view, bytes, tiffStart, tiffStart + pointers[EXIF_IFD_POINTER].value, le, EXIF_TAGS, result.fields, pointers);
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

function readIfd(view, bytes, tiffStart, ifdOffset, le, tagMap, fields, pointers) {
  if (ifdOffset + 2 > bytes.length) return;
  const count = view.getUint16(ifdOffset, le);
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > bytes.length) return;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const num = view.getUint32(entry + 4, le);

    if (tag === EXIF_IFD_POINTER || tag === GPS_IFD_POINTER) {
      pointers[tag] = { value: view.getUint32(entry + 8, le), offset: entry };
      continue;
    }
    const tagInfo = tagMap[tag];
    if (!tagInfo) continue;

    const value = readTagValue(view, bytes, tiffStart, entry, type, num, le);
    if (value === null || value === "") continue;

    const size = (TYPE_SIZES[type] || 1) * num;
    const ranges = [[entry, entry + 12]];
    if (size > 4) {
      const off = tiffStart + view.getUint32(entry + 8, le);
      if (off + size <= bytes.length) ranges.push([off, off + size]);
    }
    fields.push({ label: tagInfo.label, value: String(value), risk: tagInfo.risk, mode: "zero", ranges });
  }
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
