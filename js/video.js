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
    if (box.type === "uuid" || box.type === "jumb") await readTopLevelProvenance(file, box, result);
    if (box.end <= offset) break;
    offset = box.end;
  }

  const moov = boxes.find((b) => b.type === "moov");
  if (moov) {
    // moov is header-only (a few hundred KB even for long clips), so it is
    // safe to pull in whole and walk in memory
    const moovBytes = await readSlice(file, moov.start, moov.end - moov.start);
    walkMoov(moovBytes, moov.start, result);
    pushFrameSizeField(result);
  }
  return result;
}

/* A top-level uuid box is where MP4 and HEIF keep Content Credentials, and
   where a lot of writers keep XMP. Neither is inside moov, so the moov walk
   never saw them. */
async function readTopLevelProvenance(file, box, result) {
  const head = await readSlice(file, box.dataStart, 16);
  const isC2pa = box.type === "jumb" || isC2paUuid(head, 0);
  const isXmp = box.type === "uuid" && isXmpUuid(head, 0);
  if (!isC2pa && !isXmp) return;

  result.containerEdits.push({ kind: "free", start: box.start, end: box.end });
  if (isXmp) {
    pushXmpField({ absStart: box.start, absEnd: box.end }, result);
    return;
  }
  // manifests are small relative to a video, so this one box can be read whole
  const payloadStart = box.type === "jumb" ? box.dataStart : box.dataStart + 16;
  const manifest = await readSlice(file, payloadStart, Math.min(4 * 1024 * 1024, box.end - payloadStart));
  const analysis = analyzeC2paManifest(manifest, 0, manifest.length);
  for (const field of c2paFields(analysis, { edits: [{ kind: "free", start: box.start, end: box.end }] })) {
    pushVideoField(result, field);
  }
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

/* tkhd carries the display size, which is what a player actually shows. It
   is not always the stored size: anamorphic footage stores narrow pixels
   and stretches them on playback, so the two must be kept apart. */
function readTrackHeader(bytes, box, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const width = Math.round(view.getUint32(box.end - 8) / 65536);
  const height = Math.round(view.getUint32(box.end - 4) / 65536);
  if (width >= 1 && height >= 1 && !result.displaySize) {
    result.displaySize = { width, height };
  }
}

function readSampleDescription(bytes, box, result) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = view.getUint32(box.dataStart + 4);
  let offset = box.dataStart + 8;
  for (let i = 0; i < count && offset + 8 <= box.end; i++) {
    const size = view.getUint32(offset);
    const format = fourcc(bytes, offset + 4);
    pushVideoField(result, { label: "Codec", value: CODEC_NAMES[format] || format, risk: "device" });

    // a visual sample entry puts the stored pixel size 32 bytes in
    if (offset + 36 <= box.end && !result.storedSize) {
      const width = view.getUint16(offset + 32);
      const height = view.getUint16(offset + 34);
      if (width >= 1 && height >= 1) result.storedSize = { width, height };
    }
    if (size < 8) break;
    offset += size;
  }
}

/* One honest line for the shape of the picture. When the stored pixels do
   not match what gets displayed, both numbers are shown rather than
   quietly picking one. */
function pushFrameSizeField(result) {
  const display = result.displaySize;
  const stored = result.storedSize;
  if (!display && !stored) return;
  const shown = display || stored;
  let value = `${shown.width} x ${shown.height}`;
  if (display && stored && !sameShape(display, stored)) {
    value += ` (stored ${stored.width} x ${stored.height}, anamorphic)`;
  }
  pushVideoField(result, { label: "Frame size", value, risk: "dimensions" });
}

function sameShape(a, b) {
  if (a.width === b.width && a.height === b.height) return true;
  return Math.abs(a.width / a.height - b.width / b.height) < 0.01;
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

/* ---------- WebM / Matroska ----------
   Same idea, different container. EBML elements carry a variable-length id
   and a variable-length size, so the tree is walked without ever reading a
   Cluster: those hold the actual frames and are simply skipped over. */

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

const EBML = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  dateUtc: 0x4461,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  title: 0x7ba9,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  codecId: 0x86,
  trackName: 0x536e,
  language: 0x22b59c,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  displayWidth: 0x54b0,
  displayHeight: 0x54ba,
  tags: 0x1254c367,
  tag: 0x7373,
  simpleTag: 0x67c8,
  tagName: 0x45a3,
  tagString: 0x4487,
  attachments: 0x1941a469,
  cluster: 0x1f43b675,
  cues: 0x1c53bb6b,
};

/* Milliseconds between 2001-01-01 (the Matroska epoch) and the Unix epoch */
const EBML_EPOCH_MS = 978307200000;

function vintLength(firstByte) {
  for (let i = 0; i < 8; i++) if (firstByte & (0x80 >> i)) return i + 1;
  return 0;
}

/* Reads one EBML element header. Ids keep their marker bits (that is how
   they are written in the spec tables); sizes drop theirs. A size of all
   ones means "unknown", which live-muxed files use for the Segment. */
async function readEbmlHeader(file, offset) {
  const head = await readSlice(file, offset, 16);
  if (head.length < 2) return null;
  const idLen = vintLength(head[0]);
  if (!idLen || idLen > 4 || head.length < idLen + 1) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + head[i];

  const sizeLen = vintLength(head[idLen]);
  if (!sizeLen || sizeLen > 8 || head.length < idLen + sizeLen) return null;
  let size = head[idLen] & (0xff >> sizeLen);
  let unknown = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    size = size * 256 + head[idLen + i];
    if (head[idLen + i] !== 0xff) unknown = false;
  }
  const dataStart = offset + idLen + sizeLen;
  return {
    id, start: offset, dataStart,
    dataEnd: unknown ? file.size : Math.min(dataStart + size, file.size),
    end: unknown ? file.size : Math.min(dataStart + size, file.size),
  };
}

async function* ebmlChildren(file, from, to) {
  let offset = from;
  let guard = 0;
  while (offset < to && guard++ < 8192) {
    const el = await readEbmlHeader(file, offset);
    if (!el || el.end <= offset) return;
    yield el;
    offset = el.end;
  }
}

async function parseWebm(file) {
  const result = { fields: [], gps: null, format: "webm", kind: "video", containerEdits: [] };
  for await (const top of ebmlChildren(file, 0, file.size)) {
    if (top.id !== EBML.segment) continue;
    let timecodeScale = 1e6;
    let duration = 0;
    for await (const el of ebmlChildren(file, top.dataStart, top.dataEnd)) {
      // clusters are the payload; never read them, just step over
      if (el.id === EBML.cluster || el.id === EBML.cues || el.id === EBML.seekHead) continue;
      if (el.id === EBML.info) {
        for await (const info of ebmlChildren(file, el.dataStart, el.dataEnd)) {
          if (info.id === EBML.timecodeScale) timecodeScale = (await ebmlUint(file, info)) || 1e6;
          else if (info.id === EBML.duration) duration = await ebmlFloat(file, info);
          else if (info.id === EBML.dateUtc) {
            const ns = await ebmlUint(file, info);
            pushVideoField(result, {
              label: "Recorded", value: new Date(EBML_EPOCH_MS + ns / 1e6).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"),
              risk: "time", edits: [{ kind: "void", start: info.start, end: info.end }],
            });
          } else if (info.id === EBML.muxingApp || info.id === EBML.writingApp || info.id === EBML.title) {
            const text = await ebmlString(file, info);
            if (!text) continue;
            pushVideoField(result, {
              label: info.id === EBML.title ? "Title" : info.id === EBML.muxingApp ? "Muxing app" : "Writing app",
              value: text,
              risk: info.id === EBML.title ? "identity" : "device",
              edits: [{ kind: "void", start: info.start, end: info.end }],
            });
          }
        }
      } else if (el.id === EBML.tracks) {
        await readWebmTracks(file, el, result);
      } else if (el.id === EBML.tags) {
        result.containerEdits.push({ kind: "void", start: el.start, end: el.end });
        await readWebmTags(file, el, result);
      } else if (el.id === EBML.attachments) {
        result.containerEdits.push({ kind: "void", start: el.start, end: el.end });
        pushVideoField(result, {
          label: "Attached files", value: "present (cover art or arbitrary files)", risk: "device",
          edits: [{ kind: "void", start: el.start, end: el.end }],
        });
      }
    }
    if (duration) {
      pushVideoField(result, { label: "Duration", value: formatDuration((duration * timecodeScale) / 1e9), risk: "dimensions" });
    }
  }
  return result;
}

async function readWebmTracks(file, tracks, result) {
  for await (const entry of ebmlChildren(file, tracks.dataStart, tracks.dataEnd)) {
    if (entry.id !== EBML.trackEntry) continue;
    let width = 0;
    let height = 0;
    let displayWidth = 0;
    let displayHeight = 0;
    for await (const el of ebmlChildren(file, entry.dataStart, entry.dataEnd)) {
      if (el.id === EBML.codecId) {
        const codec = await ebmlString(file, el);
        const name = WEBM_CODECS[codec] || codec;
        if (name) pushVideoField(result, { label: "Codec", value: name, risk: "device" });
      } else if (el.id === EBML.trackName) {
        const text = await ebmlString(file, el);
        if (text) {
          pushVideoField(result, {
            label: "Track name", value: text, risk: "identity",
            edits: [{ kind: "void", start: el.start, end: el.end }],
          });
        }
      } else if (el.id === EBML.video) {
        for await (const v of ebmlChildren(file, el.dataStart, el.dataEnd)) {
          if (v.id === EBML.pixelWidth) width = await ebmlUint(file, v);
          else if (v.id === EBML.pixelHeight) height = await ebmlUint(file, v);
          else if (v.id === EBML.displayWidth) displayWidth = await ebmlUint(file, v);
          else if (v.id === EBML.displayHeight) displayHeight = await ebmlUint(file, v);
        }
      }
    }
    if (width && height) result.storedSize = result.storedSize || { width, height };
    if (displayWidth && displayHeight) {
      result.displaySize = result.displaySize || { width: displayWidth, height: displayHeight };
    }
    pushFrameSizeField(result);
  }
}

const WEBM_CODECS = {
  "V_VP8": "VP8", "V_VP9": "VP9", "V_AV1": "AV1", "V_MPEG4/ISO/AVC": "H.264",
  "V_MPEGH/ISO/HEVC": "HEVC / H.265", "A_OPUS": "Opus audio", "A_VORBIS": "Vorbis audio",
  "A_AAC": "AAC audio", "A_FLAC": "FLAC audio",
};

/* Matroska tags are free-form name/value pairs, and that is exactly where
   phone and desktop editors park location strings and device names. */
async function readWebmTags(file, tags, result) {
  for await (const tag of ebmlChildren(file, tags.dataStart, tags.dataEnd)) {
    if (tag.id !== EBML.tag) continue;
    for await (const simple of ebmlChildren(file, tag.dataStart, tag.dataEnd)) {
      if (simple.id !== EBML.simpleTag) continue;
      let name = "";
      let value = "";
      for await (const el of ebmlChildren(file, simple.dataStart, simple.dataEnd)) {
        if (el.id === EBML.tagName) name = await ebmlString(file, el);
        else if (el.id === EBML.tagString) value = await ebmlString(file, el);
      }
      if (!name || !value) continue;
      // muxers write a per-track DURATION tag that just repeats the Info
      // duration; showing it twice reads like a second leak
      if (/^duration$/i.test(name)) continue;
      const edits = [{ kind: "void", start: simple.start, end: simple.end }];
      if (/^(LOCATION|GPS.*|GEO.*)$/i.test(name)) {
        readIso6709Field(value, { absStart: simple.start, absEnd: simple.end }, result);
        continue;
      }
      pushVideoField(result, {
        label: WEBM_TAG_LABELS[name.toUpperCase()] || titleCase(name),
        value,
        risk: WEBM_TAG_RISKS[name.toUpperCase()] || "identity",
        edits,
      });
    }
  }
}

const WEBM_TAG_LABELS = {
  TITLE: "Title", COMMENT: "Comment", DESCRIPTION: "Description", ARTIST: "Artist",
  ENCODER: "Encoder", DATE_RECORDED: "Recorded", DATE: "Recorded", COPYRIGHT: "Copyright",
  DEVICE: "Device", MODEL: "Camera model", MAKE: "Camera make",
};

const WEBM_TAG_RISKS = {
  ENCODER: "device", DEVICE: "device", MODEL: "device", MAKE: "device",
  DATE_RECORDED: "time", DATE: "time",
};

function titleCase(name) {
  const words = name.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function ebmlUint(file, el) {
  const bytes = await readSlice(file, el.dataStart, Math.min(8, el.dataEnd - el.dataStart));
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

async function ebmlFloat(file, el) {
  const length = el.dataEnd - el.dataStart;
  const bytes = await readSlice(file, el.dataStart, length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return 0;
}

async function ebmlString(file, el) {
  const bytes = await readSlice(file, el.dataStart, Math.min(512, el.dataEnd - el.dataStart));
  return utf8Slice(bytes, 0, bytes.length);
}

/* ---------- dispatch ---------- */

/** Read metadata from any supported video File. */
async function parseVideoMetadata(file) {
  const head = await readSlice(file, 0, 16);
  if (EBML_MAGIC.every((b, i) => head[i] === b)) return parseWebm(file);
  const brand = fourcc(head, 4);
  if (brand === "ftyp" || brand === "moov" || brand === "mdat" || brand === "free" || brand === "skip") {
    return parseMp4(file);
  }
  return { fields: [], gps: null, format: "other", kind: "video", containerEdits: [] };
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

/** Rewrite a video File with the given edits applied. Returns a Blob. */
async function stripVideoFile(file, edits) {
  return applyFileEdits(file, edits, file.type || "video/mp4");
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
