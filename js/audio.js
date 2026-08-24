/* MetaStrip — audio metadata.

   A voice memo is the quiet one. An iPhone or Android recording is an MP4
   under the hood, so it can carry the same GPS atom a video does, and field
   recorders write the device, the operator's name and a timestamp into every
   WAV they produce. Music files carry the whole tagging apparatus plus
   whatever the ripping software felt like leaving behind.

   Four containers, three removal strategies, chosen by what each format
   allows:
     M4A   ISO-BMFF, so the video path already handles it byte for byte
     MP3   frames are self-synchronising with no stored offsets, so tag
           blocks are cut out and the file gets smaller
     WAV   a chunk cannot move without rewriting the RIFF size, so a chunk is
           renamed JUNK — which the spec defines as "skip this" — and zeroed
     FLAC  a metadata block becomes a PADDING block of the same size, which
           is what the format has for exactly this purpose */

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|flac|ogg|oga|opus|aiff|aif|caf|amr|3ga)$/i;

function isAudioFile(file) {
  return (file.type && file.type.startsWith("audio/")) || AUDIO_EXT.test(file.name || "");
}

/** Read metadata from any supported audio File. */
async function parseAudioMetadata(file) {
  const head = await readSlice(file, 0, 16);

  // an M4A is an MP4: same boxes, same atoms, same GPS
  if (asciiOf(head, 4, 8) === "ftyp") {
    const meta = await parseMp4(file);
    meta.kind = "audio";
    meta.format = "m4a";
    return meta;
  }
  if (asciiOf(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
    return parseMp3(file);
  }
  if (asciiOf(head, 0, 4) === "RIFF" && asciiOf(head, 8, 12) === "WAVE") return parseWav(file);
  if (asciiOf(head, 0, 4) === "fLaC") return parseFlac(file);
  if (asciiOf(head, 0, 4) === "OggS") return parseOgg(file);
  if (asciiOf(head, 0, 4) === "FORM") return parseAiff(file);

  return { fields: [], gps: null, format: "other", kind: "audio", containerEdits: [] };
}

function asciiOf(bytes, start, end) {
  let s = "";
  for (let i = start; i < end && i < bytes.length; i++) {
    const c = bytes[i];
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : "";
  }
  return s;
}

function utf8Of(bytes, start, end) {
  if (end <= start) return "";
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, end));
  const clean = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 160 ? clean.slice(0, 160) + "…" : clean;
}

/* ---------- MP3 ----------
   ID3v2 sits at the front and ID3v1 is the last 128 bytes. Neither is
   referenced from anywhere, so both are cut and the file shrinks. */

const ID3_FRAMES = {
  TIT2: { label: "Title", risk: "identity" },
  TPE1: { label: "Artist", risk: "identity" },
  TPE2: { label: "Album artist", risk: "identity" },
  TALB: { label: "Album", risk: "identity" },
  TCOM: { label: "Composer", risk: "identity" },
  TCON: { label: "Genre", risk: "identity" },
  COMM: { label: "Comment", risk: "identity" },
  TDRC: { label: "Recorded", risk: "time" },
  TYER: { label: "Recorded", risk: "time" },
  TDAT: { label: "Recording date", risk: "time" },
  TIME: { label: "Recording time", risk: "time" },
  TENC: { label: "Encoded by", risk: "device" },
  TSSE: { label: "Encoder software", risk: "trivia" },
  TOWN: { label: "File owner", risk: "identity" },
  TPUB: { label: "Publisher", risk: "identity" },
  TCOP: { label: "Copyright", risk: "identity" },
  WXXX: { label: "Linked URL", risk: "identity" },
  WOAF: { label: "File URL", risk: "identity" },
  UFID: { label: "Unique file id", risk: "identity" },
  PRIV: { label: "Private data", risk: "identity" },
  GEOB: { label: "Embedded object", risk: "identity" },
  APIC: { label: "Cover art", risk: "device" },
  TXXX: { label: "Custom tag", risk: "identity" },
  // the 2.2 three-letter forms, still common in old libraries
  TT2: { label: "Title", risk: "identity" },
  TP1: { label: "Artist", risk: "identity" },
  TAL: { label: "Album", risk: "identity" },
  COM: { label: "Comment", risk: "identity" },
};

async function parseMp3(file) {
  const result = { fields: [], gps: null, format: "mp3", kind: "audio", containerEdits: [] };
  const head = await readSlice(file, 0, 10);

  if (asciiOf(head, 0, 3) === "ID3") {
    const major = head[3];
    const size = syncsafe(head, 6);
    const end = Math.min(file.size, 10 + size);
    result.containerEdits.push({ kind: "cut", start: 0, end });
    const block = await readSlice(file, 0, end);
    readId3Frames(block, major, result, { kind: "cut", start: 0, end });
    result.fields.push({
      label: "ID3 tag",
      value: `${formatAudioSize(end)} tag block at the start of the file`,
      risk: "device",
      edits: [{ kind: "cut", start: 0, end }],
    });
  }

  if (file.size > 128) {
    const tail = await readSlice(file, file.size - 128, 128);
    if (asciiOf(tail, 0, 3) === "TAG") {
      const edit = { kind: "cut", start: file.size - 128, end: file.size };
      result.containerEdits.push(edit);
      const title = utf8Of(tail, 3, 33);
      const artist = utf8Of(tail, 33, 63);
      result.fields.push({
        label: "ID3v1 tag",
        value: [title, artist].filter(Boolean).join(" — ") || "128 bytes at the end of the file",
        risk: "identity",
        edits: [edit],
      });
    }
  }
  return result;
}

/* ID3v2 sizes are "syncsafe": seven bits per byte, so a tag can never look
   like an audio frame header. */
function syncsafe(bytes, offset) {
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}

function readId3Frames(block, major, result, removal) {
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  let offset = 10;
  let guard = 0;
  while (offset + headerLength <= block.length && guard++ < 512) {
    const id = asciiOf(block, offset, offset + idLength);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // padding, or the end of the tag
    const size =
      major === 2
        ? (block[offset + 3] << 16) | (block[offset + 4] << 8) | block[offset + 5]
        : major === 4
          ? syncsafe(block, offset + 4)
          : (block[offset + 4] << 24) | (block[offset + 5] << 16) | (block[offset + 6] << 8) | block[offset + 7];
    if (size <= 0) break;

    const dataStart = offset + headerLength;
    const dataEnd = Math.min(block.length, dataStart + size);
    const info = ID3_FRAMES[id];
    if (info) {
      const value = describeId3Frame(id, block, dataStart, dataEnd);
      if (value) {
        result.fields.push({ label: info.label, value, risk: info.risk, edits: [removal] });
      }
    }
    offset = dataStart + size;
  }
}

function describeId3Frame(id, block, start, end) {
  if (id === "APIC" || id === "GEOB" || id === "PRIV" || id === "UFID") {
    const size = end - start;
    const owner = utf8Of(block, start, Math.min(end, start + 64));
    return `${formatAudioSize(size)}${owner ? `, ${owner}` : ""}`;
  }
  // text frames open with an encoding byte, then the value
  const encoding = block[start];
  if (encoding === 1 || encoding === 2) return utf16Of(block, start + 1, end);
  return utf8Of(block, start + 1, end);
}

function utf16Of(bytes, start, end) {
  let out = "";
  let i = start;
  let little = true;
  if (bytes[i] === 0xff && bytes[i + 1] === 0xfe) i += 2;
  else if (bytes[i] === 0xfe && bytes[i + 1] === 0xff) {
    little = false;
    i += 2;
  }
  for (; i + 1 < end; i += 2) {
    const code = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.replace(/\s+/g, " ").trim();
}

/* ---------- WAV ----------
   Renaming a chunk to JUNK is the format's own way of saying "skip this", so
   nothing has to move and the RIFF size stays honest. */

const WAV_INFO_TAGS = {
  INAM: { label: "Title", risk: "identity" },
  IART: { label: "Artist", risk: "identity" },
  ICMT: { label: "Comment", risk: "identity" },
  ICRD: { label: "Recorded", risk: "time" },
  ISFT: { label: "Software", risk: "device" },
  IENG: { label: "Engineer", risk: "identity" },
  ITCH: { label: "Technician", risk: "identity" },
  ICOP: { label: "Copyright", risk: "identity" },
  IGNR: { label: "Genre", risk: "identity" },
  IPRD: { label: "Product", risk: "identity" },
  ISBJ: { label: "Subject", risk: "identity" },
  ISRC: { label: "Source", risk: "identity" },
  ICMS: { label: "Commissioned by", risk: "identity" },
};

const JUNK_BYTES = new Uint8Array([0x4a, 0x55, 0x4e, 0x4b]); // "JUNK"

const WAV_DROP_CHUNKS = new Set(["LIST", "id3 ", "ID3 ", "iXML", "bext", "_PMX", "cart", "IXML", "axml"]);

async function parseWav(file) {
  const result = { fields: [], gps: null, format: "wav", kind: "audio", containerEdits: [] };
  let offset = 12;
  let guard = 0;
  while (offset + 8 <= file.size && guard++ < 4096) {
    const header = await readSlice(file, offset, 8);
    const type = asciiOf(header, 0, 4);
    const view = new DataView(header.buffer, header.byteOffset, header.length);
    const size = view.getUint32(4, true);
    const dataStart = offset + 8;
    const dataEnd = Math.min(file.size, dataStart + size);
    if (!type || size < 0) break;

    if (WAV_DROP_CHUNKS.has(type)) {
      const removal = [
        { kind: "literal", data: JUNK_BYTES, start: offset, end: offset + 4 },
        { kind: "zero", start: dataStart, end: dataEnd },
      ];
      result.containerEdits.push(...removal);
      const block = await readSlice(file, dataStart, Math.min(dataEnd - dataStart, 64 * 1024));
      if (type === "LIST" && asciiOf(block, 0, 4) === "INFO") readWavInfo(block, dataStart, result, removal);
      else if (type === "bext") readBroadcastExtension(block, result, removal);
      else {
        result.fields.push({
          label: type.trim() === "iXML" ? "Recorder metadata" : `Chunk ${type.trim()}`,
          value: utf8Of(block, 0, Math.min(block.length, 400)) || `${formatAudioSize(dataEnd - dataStart)} of metadata`,
          risk: "device",
          edits: removal,
        });
      }
    }
    // chunks are word aligned
    offset = dataEnd + (size % 2);
  }
  return result;
}

function readWavInfo(block, base, result, removal) {
  let offset = 4;
  const view = new DataView(block.buffer, block.byteOffset, block.length);
  let guard = 0;
  while (offset + 8 <= block.length && guard++ < 256) {
    const type = asciiOf(block, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const value = utf8Of(block, offset + 8, Math.min(block.length, offset + 8 + size));
    const info = WAV_INFO_TAGS[type];
    if (info && value) result.fields.push({ label: info.label, value, risk: info.risk, edits: removal });
    offset += 8 + size + (size % 2);
  }
}

/* A Broadcast Wave chunk is the most identifying thing in professional audio:
   who recorded it, on what, when, and every processing step since. */
function readBroadcastExtension(block, result, removal) {
  const description = utf8Of(block, 0, 256);
  const originator = utf8Of(block, 256, 288);
  const reference = utf8Of(block, 288, 320);
  const date = utf8Of(block, 320, 330);
  const time = utf8Of(block, 330, 338);
  const parts = [
    originator ? `recorded by ${originator}` : null,
    date ? `on ${date}${time ? ` at ${time}` : ""}` : null,
    reference ? `reference ${reference}` : null,
    description || null,
  ].filter(Boolean);
  result.fields.push({
    label: "Broadcast metadata",
    value: parts.join(", ") || "present",
    risk: "identity",
    edits: removal,
  });
}

/* ---------- FLAC ----------
   Metadata blocks are a linked list of typed blocks. Turning one into a
   PADDING block of the same size is exactly what the format expects. */

const FLAC_VORBIS_COMMENT = 4;
const FLAC_PICTURE = 6;
const FLAC_PADDING = 1;

const FLAC_TAGS = {
  TITLE: { label: "Title", risk: "identity" },
  ARTIST: { label: "Artist", risk: "identity" },
  ALBUM: { label: "Album", risk: "identity" },
  ALBUMARTIST: { label: "Album artist", risk: "identity" },
  DATE: { label: "Recorded", risk: "time" },
  COMMENT: { label: "Comment", risk: "identity" },
  DESCRIPTION: { label: "Description", risk: "identity" },
  GENRE: { label: "Genre", risk: "identity" },
  COPYRIGHT: { label: "Copyright", risk: "identity" },
  ENCODER: { label: "Encoder software", risk: "trivia" },
  ENCODED_BY: { label: "Encoded by", risk: "device" },
  ORGANIZATION: { label: "Organisation", risk: "identity" },
  PERFORMER: { label: "Performer", risk: "identity" },
  LOCATION: { label: "Location", risk: "location" },
};

async function parseFlac(file) {
  const result = { fields: [], gps: null, format: "flac", kind: "audio", containerEdits: [] };
  let offset = 4;
  let last = false;
  let guard = 0;
  while (!last && offset + 4 <= file.size && guard++ < 128) {
    const header = await readSlice(file, offset, 4);
    last = Boolean(header[0] & 0x80);
    const type = header[0] & 0x7f;
    const size = (header[1] << 16) | (header[2] << 8) | header[3];
    const dataStart = offset + 4;
    const dataEnd = Math.min(file.size, dataStart + size);

    if (type === FLAC_VORBIS_COMMENT || type === FLAC_PICTURE) {
      // keep the last-block flag, change only the type
      const newHeader = new Uint8Array([(header[0] & 0x80) | FLAC_PADDING]);
      const removal = [
        { kind: "literal", data: newHeader, start: offset, end: offset + 1 },
        { kind: "zero", start: dataStart, end: dataEnd },
      ];
      result.containerEdits.push(...removal);
      if (type === FLAC_PICTURE) {
        result.fields.push({
          label: "Cover art",
          value: `${formatAudioSize(size)} image embedded in the file`,
          risk: "device",
          edits: removal,
        });
      } else {
        const block = await readSlice(file, dataStart, Math.min(size, 256 * 1024));
        readVorbisComments(block, result, removal);
      }
    }
    offset = dataEnd;
  }
  return result;
}

/* Vorbis comments are little-endian counted UTF-8 strings of the form
   NAME=value, used by FLAC, Ogg Vorbis and Opus alike. */
function readVorbisComments(block, result, removal) {
  if (block.length < 8) return;
  const view = new DataView(block.buffer, block.byteOffset, block.length);
  let offset = 4 + view.getUint32(0, true); // vendor string
  if (offset + 4 > block.length) return;
  const vendor = utf8Of(block, 4, Math.min(block.length, offset));
  if (vendor) {
    result.fields.push({ label: "Encoder software", value: vendor, risk: "trivia", edits: removal });
  }
  const count = view.getUint32(offset, true);
  offset += 4;
  for (let i = 0; i < Math.min(count, 256) && offset + 4 <= block.length; i++) {
    const size = view.getUint32(offset, true);
    const text = utf8Of(block, offset + 4, Math.min(block.length, offset + 4 + size));
    offset += 4 + size;
    const split = text.indexOf("=");
    if (split < 1) continue;
    const name = text.slice(0, split).toUpperCase();
    const value = text.slice(split + 1);
    if (!value) continue;
    const info = FLAC_TAGS[name];
    result.fields.push({
      label: info ? info.label : `Tag ${name.toLowerCase()}`,
      value,
      risk: info ? info.risk : "identity",
      edits: removal,
    });
  }
}

/* ---------- Ogg and Opus ----------
   Every Ogg page carries a CRC of itself, so a comment cannot simply be
   blanked: the page has to be rebuilt and its checksum recomputed. That is
   done here, and the result is handed over as literal replacement bytes. */

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    table[n] = c >>> 0;
  }
  return table;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
  }
  return crc >>> 0;
}

async function parseOgg(file) {
  const result = { fields: [], gps: null, format: "ogg", kind: "audio", containerEdits: [] };
  let offset = 0;
  let guard = 0;
  while (offset + 27 <= file.size && guard++ < 64) {
    const header = await readSlice(file, offset, 27);
    if (asciiOf(header, 0, 4) !== "OggS") break;
    const segments = header[26];
    const table = await readSlice(file, offset + 27, segments);
    let payloadSize = 0;
    for (const length of table) payloadSize += length;
    const headerSize = 27 + segments;
    const pageStart = offset;
    const pageEnd = offset + headerSize + payloadSize;
    const payload = await readSlice(file, offset + headerSize, payloadSize);

    // the comment header: Vorbis names it, Opus prefixes OpusTags
    const isVorbisComment = payload[0] === 3 && asciiOf(payload, 1, 7) === "vorbis";
    const isOpusTags = asciiOf(payload, 0, 8) === "OpusTags";
    if (isVorbisComment || isOpusTags) {
      const commentStart = isOpusTags ? 8 : 7;
      const page = await readSlice(file, pageStart, pageEnd - pageStart);
      const rebuilt = blankOggComment(page, headerSize, commentStart);
      const removal = [{ kind: "literal", data: rebuilt, start: pageStart, end: pageEnd }];
      result.containerEdits.push(...removal);
      readVorbisComments(payload.subarray(commentStart), result, removal);
    }
    if (pageEnd <= offset) break;
    offset = pageEnd;
  }
  return result;
}

/* Rebuilds one page with an empty comment list: the vendor string is emptied,
   the comment count set to zero, the rest of the payload zeroed, and the page
   CRC recomputed so players still accept it. */
function blankOggComment(page, headerSize, commentStart) {
  const rebuilt = page.slice(0);
  const view = new DataView(rebuilt.buffer, rebuilt.byteOffset, rebuilt.length);
  const at = headerSize + commentStart;
  if (at + 8 > rebuilt.length) return rebuilt;

  rebuilt.fill(0, at, rebuilt.length);
  view.setUint32(at, 0, true); // vendor length
  view.setUint32(at + 4, 0, true); // comment count

  // the CRC is computed over the page with its own CRC field zeroed
  view.setUint32(22, 0, true);
  const crc = oggCrc(rebuilt);
  view.setUint32(22, crc, true);
  return rebuilt;
}

/* ---------- AIFF ---------- */

async function parseAiff(file) {
  const result = { fields: [], gps: null, format: "aiff", kind: "audio", containerEdits: [] };
  let offset = 12;
  let guard = 0;
  while (offset + 8 <= file.size && guard++ < 1024) {
    const header = await readSlice(file, offset, 8);
    const type = asciiOf(header, 0, 4);
    const view = new DataView(header.buffer, header.byteOffset, header.length);
    const size = view.getUint32(4); // AIFF is big-endian
    const dataStart = offset + 8;
    const dataEnd = Math.min(file.size, dataStart + size);
    const AIFF_TEXT = { NAME: "Title", AUTH: "Author", ANNO: "Annotation", "(c) ": "Copyright", COMT: "Comment" };
    if (AIFF_TEXT[type]) {
      const removal = [
        { kind: "literal", data: JUNK_BYTES, start: offset, end: offset + 4 },
        { kind: "zero", start: dataStart, end: dataEnd },
      ];
      result.containerEdits.push(...removal);
      const block = await readSlice(file, dataStart, Math.min(dataEnd - dataStart, 4096));
      const value = utf8Of(block, 0, block.length);
      if (value) {
        result.fields.push({
          label: AIFF_TEXT[type],
          value,
          risk: type === "AUTH" ? "identity" : "device",
          edits: removal,
        });
      }
    }
    offset = dataEnd + (size % 2);
  }
  return result;
}

/* ---------- shared ---------- */

function allAudioEdits(meta) {
  const edits = [...(meta.containerEdits || [])];
  for (const field of meta.fields) if (field.edits) edits.push(...field.edits);
  if (meta.gps && meta.gps.edits) edits.push(...meta.gps.edits);
  return edits;
}

async function stripAudioFile(file, meta, edits) {
  return applyFileEdits(file, edits, file.type || "audio/mpeg");
}

function formatAudioSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
