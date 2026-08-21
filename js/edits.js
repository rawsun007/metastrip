/* MetaStrip — applying byte edits to a file without moving anything.

   Shared by every format whose metadata cannot simply be cut out. A video
   holds absolute file offsets in its chunk tables; a PDF holds them in its
   cross-reference table. In both cases removing bytes breaks the file, so the
   bytes are overwritten in place with something the format treats as empty,
   and the result is assembled from slices of the original file so a huge file
   is never held in memory.

   Edit kinds:
     zero   fill with 0x00 — raw fields, timestamps
     free   an ISO-BMFF "free" box of the same size, payload zeroed
     void   the EBML equivalent, for Matroska
     space  fill with 0x20 — text formats, where a blank must stay parseable
     hexZero fill with ASCII "0" — a hex string that must stay a hex string
     literal write the bytes in edit.data — same length, chosen content
     cut    leave the bytes out entirely, for formats with no stored offsets */

function patchBytes(edit, length) {
  if (edit.kind === "literal" && edit.data) {
    const patch = new Uint8Array(length);
    patch.set(edit.data.subarray(0, length));
    return patch;
  }
  const patch = new Uint8Array(length);
  if (edit.kind === "space") {
    patch.fill(0x20);
  } else if (edit.kind === "hexZero") {
    patch.fill(0x30);
  } else if (edit.kind === "free" && length >= 8) {
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

/** Rewrite a File with the given edits applied. Returns { blob, cleared }. */
async function applyFileEdits(file, edits, type) {
  const merged = mergeEdits(edits);
  const parts = [];
  let pos = 0;
  let cleared = 0;
  for (const edit of merged) {
    const start = Math.max(pos, Math.min(edit.start, file.size));
    const end = Math.min(edit.end, file.size);
    if (end <= start) continue;
    if (start > pos) parts.push(file.slice(pos, start));
    // a cut leaves the bytes out; everything else replaces them in place
    if (edit.kind !== "cut") parts.push(patchBytes(edit, end - start));
    cleared += end - start;
    pos = end;
  }
  if (pos < file.size) parts.push(file.slice(pos));
  return { blob: new Blob(parts, { type: type || file.type || "application/octet-stream" }), lossless: true, cleared };
}

