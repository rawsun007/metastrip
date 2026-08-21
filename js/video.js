/* MetaStrip — video metadata.
   Reads MP4 / MOV (ISO base media file format) by slicing the File, so a
   two-hour clip never lands in memory whole: only the small header boxes
   are ever read, never the mdat payload. */

const VIDEO_EXT = /\.(mp4|m4v|mov|qt|webm|mkv|3gp|3g2)$/i;

function isVideoFile(file) {
  return (file.type && file.type.startsWith("video/")) || VIDEO_EXT.test(file.name || "");
}

/* Seconds between 1904-01-01 (the QuickTime epoch) and the Unix epoch */
const MP4_EPOCH_OFFSET = 2082844800;

async function readSlice(file, start, length) {
  if (start >= file.size || length <= 0) return new Uint8Array(0);
  const end = Math.min(file.size, start + length);
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/* ---------- ISO-BMFF box plumbing ---------- */

/* Reads one box header at an absolute file offset. Handles the 64-bit
   largesize form (size === 1) and the "runs to end of file" form
   (size === 0) that QuickTime still emits for a trailing mdat. */
async function readBoxHeader(file, offset) {
  const head = await readSlice(file, offset, 16);
  if (head.length < 8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.length);
  const type = fourcc(head, 4);
  let size = view.getUint32(0);
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
    headerSize = 16;
  } else if (size === 0) {
    size = file.size - offset;
  }
  if (size < headerSize) return null;
  return { type, start: offset, end: Math.min(offset + size, file.size), dataStart: offset + headerSize, headerSize };
}

/* Same walk, but over bytes already in memory. `base` is the absolute file
   offset of bytes[0], so every box reported carries real file coordinates
   and can be edited later without a second parse. */
function* childBoxes(bytes, base, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const type = fourcc(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < headerSize || offset + size > to) return;
    yield {
      type,
      start: offset,
      end: offset + size,
      dataStart: offset + headerSize,
      absStart: base + offset,
      absEnd: base + offset + size,
      absDataStart: base + offset + headerSize,
    };
    offset += size;
  }
}

function fourcc(bytes, offset) {
  let s = "";
  for (let i = offset; i < offset + 4; i++) {
    const c = bytes[i];
    // 0xA9 is the copyright sign that opens every QuickTime user-data atom
    // ("©xyz", "©mak"); keep it readable instead of folding it into a dot
    if (c === 0xa9) s += "©";
    else s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
  }
  return s;
}

/* ---------- top level ---------- */

/** Parse an MP4/MOV File. Async because it reads only the boxes it needs. */
async function parseMp4(file) {
  const result = { fields: [], gps: null, format: "mp4", kind: "video", containerEdits: [], mdatEnd: 0 };
  const boxes = [];
  let offset = 0;
  let guard = 0;
  while (offset < file.size && guard++ < 4096) {
    const box = await readBoxHeader(file, offset);
    if (!box) break;
    boxes.push(box);
    if (box.type === "mdat") result.mdatEnd = Math.max(result.mdatEnd, box.end);
    if (box.end <= offset) break;
    offset = box.end;
  }

  const moov = boxes.find((b) => b.type === "moov");
  if (moov) {
    // moov is header-only (a few hundred KB even for long clips), so it is
    // safe to pull in whole and walk in memory
    const moovBytes = await readSlice(file, moov.start, moov.end - moov.start);
    walkMoov(moovBytes, moov.start, result);
  }
  return result;
}

function walkMoov(bytes, base, result) {
  for (const box of childBoxes(bytes, base, 8)) {
    if (box.type === "mvhd") readMovieHeader(bytes, box, result);
    else if (box.type === "trak") walkTrak(bytes, box, result);
    else if (box.type === "udta" || box.type === "meta" || box.type === "uuid") {
      // free the whole container on a full strip, so anything in there this
      // parser does not recognise is cleared too
      result.containerEdits.push({ kind: "free", start: box.absStart, end: box.absEnd });
      if (box.type === "udta") walkUdta(bytes, box, result);
      else if (box.type === "meta") walkMeta(bytes, box, result);
      else pushXmpField(box, result);
    }
  }
}

function walkTrak(bytes, trak, result) {
  for (const box of childBoxes(bytes, trak.absStart - trak.start, trak.dataStart, trak.end)) {
    if (box.type === "tkhd") readTrackHeader(bytes, box, result);
    else if (box.type === "mdia") walkMdia(bytes, box, result);
    else if (box.type === "udta" || box.type === "meta") {
      result.containerEdits.push({ kind: "free", start: box.absStart, end: box.absEnd });
      if (box.type === "udta") walkUdta(bytes, box, result);
      else walkMeta(bytes, box, result);
    }
  }
}

function walkMdia(bytes, mdia, result) {
  for (const box of childBoxes(bytes, mdia.absStart - mdia.start, mdia.dataStart, mdia.end)) {
    if (box.type === "minf") walkMinf(bytes, box, result);
  }
}

function walkMinf(bytes, minf, result) {
  for (const box of childBoxes(bytes, minf.absStart - minf.start, minf.dataStart, minf.end)) {
    if (box.type === "stbl") {
      for (const stbl of childBoxes(bytes, box.absStart - box.start, box.dataStart, box.end)) {
        if (stbl.type === "stsd") readSampleDescription(bytes, stbl, result);
      }
    }
  }
}

/* ---------- individual header boxes ---------- */

const CODEC_NAMES = {
  avc1: "H.264", avc3: "H.264", hvc1: "HEVC / H.265", hev1: "HEVC / H.265",
  av01: "AV1", vp08: "VP8", vp09: "VP9", mp4v: "MPEG-4 Visual", jpeg: "Motion JPEG",
  mp4a: "AAC audio", alac: "ALAC audio", Opus: "Opus audio", ".mp3": "MP3 audio",
  "ac-3": "AC-3 audio", "ec-3": "E-AC-3 audio", sowt: "PCM audio", lpcm: "PCM audio",
};

function readMovieHeader(bytes, box, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const p = box.dataStart;
  const version = bytes[p];
  const wide = version === 1;
  const created = wide ? readUint64(view, p + 4) : view.getUint32(p + 4);
  const modified = wide ? readUint64(view, p + 12) : view.getUint32(p + 8);
  const tsOffset = wide ? p + 20 : p + 12;
  const timescale = view.getUint32(tsOffset);
  const duration = wide ? readUint64(view, tsOffset + 4) : view.getUint32(tsOffset + 4);

  if (created) {
    result.fields.push({
      label: "Recorded", value: mp4Date(created), risk: "time",
      edits: [{ kind: "zero", start: box.absDataStart + 4, end: box.absDataStart + 4 + (wide ? 8 : 4) }],
    });
  }
  if (modified) {
    const start = box.absDataStart + (wide ? 12 : 8);
    result.fields.push({
      label: "Last modified", value: mp4Date(modified), risk: "time",
      edits: [{ kind: "zero", start, end: start + (wide ? 8 : 4) }],
    });
  }
  if (timescale && duration) {
    result.fields.push({ label: "Duration", value: formatDuration(duration / timescale), risk: "dimensions" });
  }
}

function readTrackHeader(bytes, box, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const width = view.getUint32(box.end - 8) / 65536;
  const height = view.getUint32(box.end - 4) / 65536;
  if (width >= 1 && height >= 1 && !result.fields.some((f) => f.label === "Frame size")) {
    result.fields.push({
      label: "Frame size", value: `${Math.round(width)} x ${Math.round(height)}`, risk: "dimensions",
    });
  }
}

function readSampleDescription(bytes, box, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = view.getUint32(box.dataStart + 4);
  let offset = box.dataStart + 8;
  for (let i = 0; i < count && offset + 8 <= box.end; i++) {
    const size = view.getUint32(offset);
    const format = fourcc(bytes, offset + 4);
    const name = CODEC_NAMES[format] || format;
    if (!result.fields.some((f) => f.label === "Codec" && f.value === name)) {
      result.fields.push({ label: "Codec", value: name, risk: "device" });
    }
    if (size < 8) break;
    offset += size;
  }
}

/* ---------- user data: where phones actually hide the personal bits ----------
   Two dialects live side by side. Classic QuickTime keeps "©xyz"-style atoms
   directly under udta; Apple's newer files put an mdta key table plus a
   parallel ilst value list under moov/meta. Both are read here, and every
   field remembers the exact box it came from so it can be neutralised later
   without re-parsing. */

const UDTA_LABELS = {
  "©mak": { label: "Camera make", risk: "device" },
  "©mod": { label: "Camera model", risk: "device" },
  "©swr": { label: "Software", risk: "device" },
  "©too": { label: "Encoder", risk: "device" },
  "©day": { label: "Recorded", risk: "time" },
  "©nam": { label: "Title", risk: "identity" },
  "©cmt": { label: "Comment", risk: "identity" },
  "©des": { label: "Description", risk: "identity" },
  "©inf": { label: "Information", risk: "identity" },
  "©ART": { label: "Artist", risk: "identity" },
  "©aut": { label: "Author", risk: "identity" },
  "©cpy": { label: "Copyright", risk: "identity" },
  "©alb": { label: "Album", risk: "identity" },
  "©gen": { label: "Genre", risk: "identity" },
  "©key": { label: "Keywords", risk: "identity" },
  "©dir": { label: "Director", risk: "identity" },
  "©prd": { label: "Producer", risk: "identity" },
  name: { label: "Name", risk: "identity" },
  desc: { label: "Description", risk: "identity" },
  auth: { label: "Author", risk: "identity" },
  titl: { label: "Title", risk: "identity" },
  cprt: { label: "Copyright", risk: "identity" },
  gspm: { label: "Google Photos metadata", risk: "device" },
  gspu: { label: "Google Photos upload URL", risk: "identity" },
  gssd: { label: "Google Photos session id", risk: "identity" },
  gshh: { label: "Google Photos host", risk: "identity" },
  SDLN: { label: "Recording label", risk: "device" },
  smta: { label: "Samsung metadata", risk: "device" },
};

const APPLE_KEY_LABELS = {
  "com.apple.quicktime.make": { label: "Camera make", risk: "device" },
  "com.apple.quicktime.model": { label: "Camera model", risk: "device" },
  "com.apple.quicktime.software": { label: "Software", risk: "device" },
  "com.apple.quicktime.creationdate": { label: "Recorded", risk: "time" },
  "com.apple.quicktime.location.ISO6709": { label: "GPS location", risk: "location" },
  "com.apple.quicktime.location.accuracy.horizontal": { label: "Location accuracy", risk: "location" },
  "com.apple.quicktime.content.identifier": { label: "Live Photo pairing id", risk: "identity" },
  "com.apple.quicktime.camera.identifier": { label: "Camera identifier", risk: "identity" },
  "com.apple.quicktime.artist": { label: "Artist", risk: "identity" },
  "com.apple.quicktime.title": { label: "Title", risk: "identity" },
  "com.apple.quicktime.description": { label: "Description", risk: "identity" },
  "com.apple.quicktime.comment": { label: "Comment", risk: "identity" },
  "com.apple.quicktime.author": { label: "Author", risk: "identity" },
  "com.apple.quicktime.displayname": { label: "Display name", risk: "identity" },
  "com.apple.photos.originating.signature": { label: "Photos signature", risk: "identity" },
  "com.android.version": { label: "Android version", risk: "device" },
  "com.android.capture.fps": { label: "Capture frame rate", risk: "device" },
};

function walkUdta(bytes, udta, result) {
  const base = udta.absStart - udta.start;
  for (const box of childBoxes(bytes, base, udta.dataStart, udta.end)) {
    if (box.type === "©xyz" || box.type === "xyz ") {
      readIso6709Field(readAtomText(bytes, box), box, result);
    } else if (box.type === "loci") {
      readLociBox(bytes, box, result);
    } else if (box.type === "meta") {
      walkMeta(bytes, box, result);
    } else if (box.type === "uuid") {
      pushXmpField(box, result);
    } else {
      const known = UDTA_LABELS[box.type];
      const text = readAtomText(bytes, box);
      if (!text) continue;
      pushVideoField(result, {
        label: known ? known.label : `Tag ${box.type.trim()}`,
        value: text,
        risk: known ? known.risk : "device",
        edits: [{ kind: "free", start: box.absStart, end: box.absEnd }],
      });
    }
  }
}

/* moov/meta (or trak/meta): hdlr says which flavour, then keys + ilst for
   Apple's mdta form, or plain iTunes-style ©atoms inside ilst. */
function walkMeta(bytes, meta, result) {
  const base = meta.absStart - meta.start;
  // a QuickTime meta box has no version/flags, an ISO one does; probing for a
  // sane first child type tells the two apart without guessing by brand
  let start = meta.dataStart;
  const probe = fourcc(bytes, meta.dataStart + 4);
  if (!/^(hdlr|keys|ilst|mdta|free|uuid)$/.test(probe.trim()) && meta.dataStart + 4 < meta.end) {
    start = meta.dataStart + 4;
  }
  let keys = [];
  let ilst = null;
  for (const box of childBoxes(bytes, base, start, meta.end)) {
    if (box.type === "keys") keys = readKeysTable(bytes, box);
    else if (box.type === "ilst") ilst = box;
    else if (box.type === "uuid") pushXmpField(box, result);
    else if (box.type === "udta") walkUdta(bytes, box, result);
  }
  if (ilst) readIlst(bytes, ilst, keys, result);
}

function readKeysTable(bytes, box) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = view.getUint32(box.dataStart + 4);
  const keys = [];
  let offset = box.dataStart + 8;
  for (let i = 0; i < count && offset + 8 <= box.end; i++) {
    const size = view.getUint32(offset);
    if (size < 8) break;
    keys.push(utf8Slice(bytes, offset + 8, offset + size));
    offset += size;
  }
  return keys;
}

function readIlst(bytes, ilst, keys, result) {
  const base = ilst.absStart - ilst.start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (const item of childBoxes(bytes, base, ilst.dataStart, ilst.end)) {
    // an mdta item's type is a big-endian 1-based index into the keys table,
    // an iTunes item's type is the atom name itself
    const index = view.getUint32(item.start + 4);
    const keyName = index >= 1 && index <= keys.length ? keys[index - 1] : null;
    const text = readAtomText(bytes, item);
    if (!text) continue;

    if (keyName === "com.apple.quicktime.location.ISO6709") {
      readIso6709Field(text, item, result);
      continue;
    }
    const known = keyName ? APPLE_KEY_LABELS[keyName] : UDTA_LABELS[item.type];
    pushVideoField(result, {
      label: known ? known.label : keyName ? shortKeyName(keyName) : `Tag ${item.type.trim()}`,
      value: text,
      risk: known ? known.risk : "device",
      edits: [{ kind: "free", start: item.absStart, end: item.absEnd }],
    });
  }
}

function shortKeyName(key) {
  const tail = key.replace(/^com\.apple\.(quicktime|photos)\./, "").replace(/^com\.android\./, "Android ");
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/* Reads an atom's text payload in either dialect: a "data" child box
   (iTunes / mdta) or the classic 2-byte size + 2-byte language prefix. */
function readAtomText(bytes, box) {
  const base = box.absStart - box.start;
  for (const child of childBoxes(bytes, base, box.dataStart, box.end)) {
    if (child.type === "data") return utf8Slice(bytes, child.dataStart + 8, child.end);
  }
  if (box.end - box.dataStart <= 4) return "";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const declared = view.getUint16(box.dataStart);
  const textStart = box.dataStart + 4;
  const textEnd = declared && textStart + declared <= box.end ? textStart + declared : box.end;
  return utf8Slice(bytes, textStart, textEnd);
}

function utf8Slice(bytes, start, end) {
  if (end <= start) return "";
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, end));
  const clean = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 160 ? clean.slice(0, 160) + "…" : clean;
}

/* ISO 6709: "+21.1702+072.8311+012.000/" — the exact shape iPhones and most
   Android cameras write into ©xyz. */
function readIso6709Field(text, box, result) {
  const coords = parseIso6709(text);
  const edits = [{ kind: "free", start: box.absStart, end: box.absEnd }];
  if (!coords) {
    if (text) {
      pushVideoField(result, { label: "GPS location", value: text, risk: "location", edits });
    }
    return;
  }
  if (result.gps) {
    result.gps.edits.push(...edits);
    return;
  }
  result.gps = { lat: coords.lat, lon: coords.lon, alt: coords.alt, edits };
}

function parseIso6709(text) {
  if (!text) return null;
  const m = /([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(text);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon, alt: m[3] != null ? parseFloat(m[3]) : null };
}

/* 3GPP loci box: version/flags, language, a null-terminated name, then a
   role byte and 16.16 fixed-point longitude, latitude, altitude. */
function readLociBox(bytes, box, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let p = box.dataStart + 6;
  while (p < box.end && bytes[p] !== 0) p++;
  p++; // the terminator itself
  if (p + 13 > box.end) return;
  const lon = view.getInt32(p + 1) / 65536;
  const lat = view.getInt32(p + 5) / 65536;
  const alt = view.getInt32(p + 9) / 65536;
  const edits = [{ kind: "free", start: box.absStart, end: box.absEnd }];
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return;
  if (result.gps) result.gps.edits.push(...edits);
  else result.gps = { lat, lon, alt: alt || null, edits };
}

function pushXmpField(box, result) {
  pushVideoField(result, {
    label: "XMP metadata",
    value: "present (editing history, IDs)",
    risk: "device",
    edits: [{ kind: "free", start: box.absStart, end: box.absEnd }],
  });
}

/* Phones happily write the same value into udta and into meta/ilst, so the
   card would show "Camera model: iPhone" twice. Merge on label + value and
   keep both edits, so unticking the row still clears every copy. */
function pushVideoField(result, field) {
  const twin = result.fields.find((f) => f.label === field.label && f.value === field.value);
  if (twin) {
    if (field.edits) (twin.edits = twin.edits || []).push(...field.edits);
    return;
  }
  result.fields.push(field);
}

/* ---------- stripping ----------
   A video cannot be cleaned the way a JPEG is. Chunk offset tables (stco,
   co64) hold absolute file positions into mdat, so deleting a single byte
   anywhere ahead of them silently desynchronises playback.

   So nothing moves. Each doomed box keeps its size and gets its type
   rewritten to "free" with a zeroed payload — a box every demuxer already
   knows to skip — and raw timestamp fields are zeroed where they sit. The
   file stays byte-for-byte aligned, pixels are never re-encoded, and the
   output is assembled from Blob slices so a 4 GB clip never enters memory. */

function patchBytes(edit, length) {
  const patch = new Uint8Array(length);
  if (edit.kind === "free" && length >= 8) {
    new DataView(patch.buffer).setUint32(0, length);
    patch[4] = 0x66; // f
    patch[5] = 0x72; // r
    patch[6] = 0x65; // e
    patch[7] = 0x65; // e
  } else if (edit.kind === "void") {
    writeVoidElement(patch);
  }
  return patch;
}

/* EBML's equivalent of a free box. The element is ID 0xEC plus a length
   prefix, so the prefix width is chosen to make the total land exactly on
   the hole being filled. */
function writeVoidElement(patch) {
  const total = patch.length;
  if (total < 2) return; // nothing valid fits, leave it zeroed
  patch[0] = 0xec;
  if (total <= 128) {
    patch[1] = 0x80 | (total - 2); // one-byte length
    return;
  }
  if (total < 9) return;
  patch[1] = 0x01; // eight-byte length marker
  const payload = total - 9;
  for (let i = 0; i < 7; i++) patch[8 - i] = (payload / 2 ** (8 * i)) & 0xff;
}

/* Overlapping edits are the norm: a whole udta box may be freed while one
   of its children was already marked. Sort, then clip each edit to what the
   previous one did not already cover, so byte ranges are written once. */
function mergeEdits(edits) {
  const clean = edits
    .filter((e) => e && e.end > e.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let reach = -1;
  for (const edit of clean) {
    if (edit.start >= reach) {
      out.push({ ...edit });
      reach = edit.end;
    } else if (edit.end > reach) {
      // partially covered: keep only the tail, and only if a valid box
      // header still fits, otherwise fall back to plain zeroing
      const tail = { ...edit, start: reach };
      if (tail.kind === "free" && tail.end - tail.start < 8) tail.kind = "zero";
      out.push(tail);
      reach = edit.end;
    }
  }
  return out;
}

/** Rewrite a video File with the given edits applied. Returns a Blob. */
async function stripVideoFile(file, edits) {
  const merged = mergeEdits(edits);
  const parts = [];
  let pos = 0;
  let cleared = 0;
  for (const edit of merged) {
    const start = Math.max(pos, Math.min(edit.start, file.size));
    const end = Math.min(edit.end, file.size);
    if (end <= start) continue;
    if (start > pos) parts.push(file.slice(pos, start));
    parts.push(patchBytes(edit, end - start));
    cleared += end - start;
    pos = end;
  }
  if (pos < file.size) parts.push(file.slice(pos));
  return { blob: new Blob(parts, { type: file.type || "video/mp4" }), lossless: true, cleared };
}

/** Every edit that a full strip should apply: recognised fields, GPS, and
    the whole metadata containers, so unrecognised tags inside them go too. */
function allVideoEdits(meta) {
  const edits = [...(meta.containerEdits || [])];
  for (const f of meta.fields) if (f.edits) edits.push(...f.edits);
  if (meta.gps && meta.gps.edits) edits.push(...meta.gps.edits);
  return edits;
}

/* ---------- helpers ---------- */

function readUint64(view, offset) {
  return view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
}

function mp4Date(seconds) {
  const unix = seconds - MP4_EPOCH_OFFSET;
  if (unix < 0 || unix > 4102444800) return String(seconds);
  return new Date(unix * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}
