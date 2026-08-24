/* MetaStrip — PDF metadata.

   A PDF carries your name in two places at once. The document information
   dictionary holds Title, Author, Creator and Producer plus creation and
   modification times, and an XMP packet usually repeats all of it in XML,
   often with more: the original document's history, the software chain, and
   on office exports the account name of whoever pressed save.

   Cleaning one has the same constraint as a video. A PDF's cross-reference
   table stores absolute byte offsets for every object, so deleting a single
   byte anywhere earlier invalidates the whole table. So nothing moves: string
   values are overwritten with spaces inside their own delimiters, and an XMP
   packet is blanked where it sits. The page content is never touched, so the
   document renders exactly as before.

   Encrypted PDFs are declined rather than damaged: their strings are
   ciphertext, and blanking them would corrupt the file without being able to
   report what was in there. */

const PDF_INFO_KEYS = {
  Title: { label: "Title", risk: "identity" },
  Author: { label: "Author", risk: "identity" },
  Subject: { label: "Subject", risk: "identity" },
  Keywords: { label: "Keywords", risk: "identity" },
  Creator: { label: "Created with", risk: "device" },
  Producer: { label: "Written by", risk: "trivia" },
  CreationDate: { label: "Created", risk: "time" },
  ModDate: { label: "Last modified", risk: "time" },
  Company: { label: "Company", risk: "identity" },
  SourceModified: { label: "Source modified", risk: "time" },
  Trapped: null,
};

function isPdfFile(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

/* Reading a PDF means finding structures in a byte soup, so the bytes are
   viewed as latin1 text: every byte maps to exactly one character, offsets in
   the string are offsets in the file, and no byte is lost in translation. */
function latin1(bytes, start = 0, end = bytes.length) {
  let out = "";
  const chunk = 0x8000;
  for (let i = start; i < end; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, end)));
  }
  return out;
}

/** Parse a PDF File. Async to match the other readers; reads the whole file. */
async function parsePdfMetadata(file) {
  const result = { fields: [], gps: null, format: "pdf", kind: "document", edits: [], pages: 0 };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = latin1(bytes);

  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text) || /\/Encrypt\s*<</.test(text)) {
    result.encrypted = true;
    result.fields.push({
      label: "Encrypted",
      value: "this PDF is encrypted, so its metadata cannot be read or removed without the password",
      risk: "device",
    });
    return result;
  }

  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
  result.pages = pageMatches ? pageMatches.length : 0;
  if (result.pages) {
    result.fields.push({ label: "Pages", value: String(result.pages), risk: "dimensions" });
  }

  readInfoDictionary(text, result);
  readXmpPackets(text, result);
  readFileIdentifier(text, result);
  return result;
}

/* The information dictionary is the object the trailer's /Info points at. A
   file that has been saved several times has several trailers, so every
   candidate is read and the values found are merged. */
function readInfoDictionary(text, result) {
  const seen = new Set();
  for (const match of text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)) {
    const objectNumber = match[1];
    if (seen.has(objectNumber)) continue;
    seen.add(objectNumber);
    for (const body of findObjectBodies(text, objectNumber)) {
      readInfoKeys(text, body, result);
    }
  }
  // some writers put the dictionary inline in the trailer instead
  if (!result.fields.some((f) => f.label !== "Pages")) {
    const inline = /trailer[\s\S]{0,400}?\/Info\s*<<([\s\S]{0,2000}?)>>/.exec(text);
    if (inline) readInfoKeys(text, { start: inline.index, end: inline.index + inline[0].length }, result);
  }
}

function* findObjectBodies(text, objectNumber) {
  const pattern = new RegExp(`(^|[^0-9])${objectNumber}\\s+\\d+\\s+obj`, "g");
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end > start) yield { start, end };
  }
}

function readInfoKeys(text, body, result) {
  const section = text.slice(body.start, body.end);
  for (const match of section.matchAll(/\/([A-Za-z]+)\s*(\(|<)/g)) {
    const key = match[1];
    const info = PDF_INFO_KEYS[key];
    if (info === undefined || info === null) continue;

    const valueStart = body.start + match.index + match[0].length;
    const span = match[2] === "(" ? findLiteralStringEnd(text, valueStart) : text.indexOf(">", valueStart);
    if (span < 0) continue;

    const raw = text.slice(valueStart, span);
    const value = match[2] === "(" ? decodePdfString(raw) : decodePdfHexString(raw);
    if (!value) continue;
    if (result.fields.some((f) => f.label === info.label && f.value === value)) continue;

    result.fields.push({
      label: info.label,
      value: value.length > 160 ? value.slice(0, 160) + "…" : value,
      risk: info.risk,
      edits: [{ kind: match[2] === "(" ? "space" : "hexZero", start: valueStart, end: span }],
    });
  }
}

/* PDF literal strings nest parentheses and escape with a backslash, so the
   closing delimiter has to be found by walking, not by searching. */
function findLiteralStringEnd(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function decodePdfString(raw) {
  let out = raw.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c] || c));
  // UTF-16 big-endian, which is how anything non-ASCII gets written
  if (out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
    let decoded = "";
    for (let i = 2; i + 1 < out.length; i += 2) {
      decoded += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
    }
    out = decoded;
  }
  return cleanText(out);
}

function decodePdfHexString(raw) {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
    let decoded = "";
    for (let i = 2; i + 1 < out.length; i += 2) {
      decoded += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
    }
    out = decoded;
  }
  return cleanText(out);
}

function cleanText(text) {
  return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/* XMP is XML, and the interesting parts are readable without a parser: the
   tool that wrote it, and any name it recorded. A packet is blanked with
   spaces, which keeps a stream's declared length honest and leaves an empty
   but well-formed hole. */
function readXmpPackets(text, result) {
  for (const match of text.matchAll(/<\?xpacket begin[\s\S]*?<\?xpacket end[^>]*\?>/g)) {
    const packet = match[0];
    const tool = firstXmlValue(packet, ["xmp:CreatorTool", "pdf:Producer", "xmp:MetadataDate"]);
    const author = firstXmlValue(packet, ["dc:creator", "dc:title", "pdf:Author"]);
    result.fields.push({
      label: "XMP metadata",
      value: [
        tool ? `written by ${tool}` : null,
        author ? `names ${author}` : null,
        `${(packet.length / 1024).toFixed(1)} KB of XML`,
      ].filter(Boolean).join(", "),
      risk: author ? "identity" : "device",
      edits: [{ kind: "space", start: match.index, end: match.index + packet.length }],
    });
  }
  // a compressed metadata stream cannot be read, but it can still be reported
  if (!result.fields.some((f) => f.label === "XMP metadata") && /\/Type\s*\/Metadata/.test(text)) {
    result.fields.push({
      label: "XMP metadata",
      value: "present but compressed, so its contents cannot be shown",
      risk: "device",
      edits: compressedMetadataEdits(text),
    });
  }
}

/* For a compressed packet the stream body is zeroed rather than spaced: it is
   binary either way, and a reader that cannot inflate it treats the metadata
   as absent. */
function compressedMetadataEdits(text) {
  const edits = [];
  for (const match of text.matchAll(/\/Type\s*\/Metadata[\s\S]{0,400}?stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end > start) edits.push({ kind: "zero", start, end });
  }
  return edits;
}

function firstXmlValue(packet, tags) {
  for (const tag of tags) {
    const direct = new RegExp(`<${tag}[^>]*>([^<]{1,160})</${tag}>`).exec(packet);
    if (direct) return cleanText(direct[1]);
    const nested = new RegExp(`<${tag}[^>]*>[\\s\\S]{0,200}?<rdf:li[^>]*>([^<]{1,160})</rdf:li>`).exec(packet);
    if (nested) return cleanText(nested[1]);
  }
  return null;
}

/* The trailer's /ID is a pair of hashes that follows a document through every
   save. Two files carrying the same first half came from the same original. */
function readFileIdentifier(text, result) {
  const match = /\/ID\s*\[\s*<([0-9a-fA-F]{16,})>/.exec(text);
  if (!match) return;
  result.fields.push({
    label: "File identifier",
    value: `${match[1].slice(0, 16).toLowerCase()}…, follows this document through every save`,
    risk: "identity",
    edits: [{ kind: "hexZero", start: match.index + match[0].indexOf("<") + 1, end: match.index + match[0].length - 1 }],
  });
}

/** Every edit a full clean applies. */
function allPdfEdits(meta) {
  const edits = [];
  for (const field of meta.fields) if (field.edits) edits.push(...field.edits);
  return edits;
}

/** Writes the cleaned PDF: strings become spaces, hex values become "0"s. */
async function stripPdfFile(file, edits) {
  return applyFileEdits(file, edits, "application/pdf");
}
