/* MetaStrip — lossless metadata stripping.
   Removes metadata segments byte-by-byte without re-encoding pixels,
   so image quality is untouched. */

/** Strip metadata from an image ArrayBuffer.
    Returns { bytes: Uint8Array, lossless: boolean } or null if unsupported. */
function stripMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes: stripJpeg(bytes), lossless: true };
  if (isPng(bytes)) return { bytes: stripPng(bytes), lossless: true };
  return null;
}

/* ---------- JPEG ----------
   Drop: APP1 (EXIF + XMP), APP11 (JUMBF, which is where C2PA Content
   Credentials live), APP13 (Photoshop IRB), COM (comments).
   Keep: APP0 (JFIF), APP2 (ICC color profile), APP14 (Adobe color
   transform — removing it corrupts colors), and all coding segments. */

const JPEG_DROP_MARKERS = new Set([0xe1, 0xeb, 0xed, 0xfe]);

function stripJpeg(bytes) {
  const out = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda) {
      out.push(bytes.subarray(offset)); // SOS: scan data + EOI, copy verbatim
      return concat(out);
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segEnd = offset + 2 + length;
    if (!JPEG_DROP_MARKERS.has(marker)) out.push(bytes.subarray(offset, segEnd));
    offset = segEnd;
  }
  out.push(bytes.subarray(offset));
  return concat(out);
}

/* ---------- PNG ----------
   Drop text/time/exif chunks; keep everything else (incl. IHDR/IDAT/
   PLTE/tRNS/gAMA/iCCP etc.) so pixels and rendering are untouched. */

const PNG_DROP_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "caBX"]);

function stripPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const out = [bytes.subarray(0, 8)]; // signature
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const chunkEnd = offset + 8 + length + 4;
    if (!PNG_DROP_CHUNKS.has(type)) out.push(bytes.subarray(offset, chunkEnd));
    if (type === "IEND") break;
    offset = chunkEnd;
  }
  return concat(out);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/* ---------- Selective stripping ----------
   Redacts chosen fields in place: JPEG EXIF entries are zeroed
   byte-for-byte, PNG text chunks are cut out whole, and PNG eXIf
   redactions get their chunk CRC recomputed so the file stays valid. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Redact only the given fields (from parseMetadata) inside the file.
    Returns { bytes, lossless: true }. */
function selectiveStrip(buffer, removeFields) {
  const out = new Uint8Array(buffer.slice(0));
  const cuts = [];
  const crcChunks = new Map();

  for (const f of removeFields) {
    if (!f) continue;
    if (f.mode === "cut" && (f.chunkRange || f.chunkRanges)) {
      // a C2PA manifest larger than one JPEG segment spans several of them
      if (f.chunkRanges) cuts.push(...f.chunkRanges);
      if (f.chunkRange) cuts.push(f.chunkRange);
    } else if (f.ranges) {
      for (const [a, b] of f.ranges) out.fill(0, a, b);
      if (f.crcChunk) crcChunks.set(f.crcChunk.start, f.crcChunk);
    }
  }

  // fix CRCs of PNG chunks we zeroed inside (CRC covers type + data)
  const view = new DataView(out.buffer);
  for (const chunk of crcChunks.values()) {
    const crc = crc32(out, chunk.start + 4, chunk.dataEnd);
    view.setUint32(chunk.dataEnd, crc);
  }

  if (!cuts.length) return { bytes: out, lossless: true };

  // splice out whole-chunk cuts, back to front after merging overlaps
  cuts.sort((p, q) => p[0] - q[0]);
  const merged = [cuts[0].slice()];
  for (const [a, b] of cuts.slice(1)) {
    const last = merged[merged.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const kept = [];
  let pos = 0;
  for (const [a, b] of merged) {
    kept.push(out.subarray(pos, a));
    pos = b;
  }
  kept.push(out.subarray(pos));
  return { bytes: concat(kept), lossless: true };
}

/** Fallback for formats without a lossless stripper: re-encode via canvas. */
async function stripViaCanvas(file) {
  const bitmap = await createImageBitmap(await blobFromFile(file));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), lossless: false } : null;
}

function blobFromFile(file) {
  return Promise.resolve(file instanceof Blob ? file : new Blob([file]));
}

function cleanFilename(name, forceJpg = false) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = forceJpg ? "jpg" : dot > 0 ? name.slice(dot + 1) : "img";
  return `${stem}-clean.${ext}`;
}
