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
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
  }
  return s;
}

/* ---------- top level ---------- */

/** Parse an MP4/MOV File. Async because it reads only the boxes it needs. */
async function parseMp4(file) {
  const result = { fields: [], gps: null, format: "mp4", kind: "video", edits: [], mdatEnd: 0 };
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
  }
}

function walkTrak(bytes, trak, result) {
  for (const box of childBoxes(bytes, trak.absStart - trak.start, trak.dataStart, trak.end)) {
    if (box.type === "tkhd") readTrackHeader(bytes, box, result);
    else if (box.type === "mdia") walkMdia(bytes, box, result);
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
