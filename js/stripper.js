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
   Drop: APP1 (EXIF + XMP), APP13 (Photoshop IRB), COM (comments).
   Keep: APP0 (JFIF), APP2 (ICC color profile), APP14 (Adobe color
   transform — removing it corrupts colors), and all coding segments. */

const JPEG_DROP_MARKERS = new Set([0xe1, 0xed, 0xfe]);

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

const PNG_DROP_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

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
