/* MetaStrip — C2PA Content Credentials.

   Content Credentials are a signed provenance record: who made a file, what
   tool made it, whether AI was involved, and every edit since. They ride in
   a JUMBF container (ISO/IEC 19566-5) which each format carries its own way:
   JPEG in APP11 segments, PNG in a caBX chunk, MP4 and HEIF in a top-level
   uuid box stamped with the C2PA identifier, TIFF and DNG in an IFD tag.

   Removing them is a real privacy need — an identity assertion exports the
   signer's identity, device and timestamps with every copy of the file, and
   once distributed it cannot be retracted. It also destroys the file's
   authenticity claim, which the UI says out loud rather than hiding.

   The claim itself is CBOR, so this file walks the JUMBF tree and decodes the
   subset of CBOR a manifest uses. Where a manifest is truncated or shaped in a
   way the walk cannot follow, it falls back to reading the strings the bytes
   spell out in the clear. Everything reported is something actually found in
   the file; nothing is inferred to fill a gap. */

const C2PA_UUID = [
  0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c,
  0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
];

const XMP_BOX_UUID = [
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8,
  0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
];

function matchesUuid(bytes, offset, uuid) {
  if (offset + uuid.length > bytes.length) return false;
  for (let i = 0; i < uuid.length; i++) if (bytes[offset + i] !== uuid[i]) return false;
  return true;
}

const isC2paUuid = (bytes, offset) => matchesUuid(bytes, offset, C2PA_UUID);
const isXmpUuid = (bytes, offset) => matchesUuid(bytes, offset, XMP_BOX_UUID);

/* ---------- JUMBF ----------
   A JUMBF superbox ('jumb') opens with a description box ('jumd') carrying a
   16-byte type UUID whose first four bytes are the box's code — 'c2pa',
   'c2cl' for a claim, 'c2as' for the assertion store, 'c2cs' for the
   signature — followed by toggles and an optional label. Everything after the
   description box is content: 'cbor', 'json', 'bidb' or 'uuid'. */

function* jumbfBoxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let offset = start;
  let guard = 0;
  while (offset + 8 <= end && guard++ < 4096) {
    let size = view.getUint32(offset);
    const type = asciiRun(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type, start: offset, dataStart: offset + headerSize, end: offset + size };
    offset += size;
  }
}

function readDescriptionBox(bytes, box) {
  const code = asciiRun(bytes, box.dataStart, box.dataStart + 4);
  const toggles = bytes[box.dataStart + 16];
  let label = "";
  if (toggles & 0x02) {
    let i = box.dataStart + 17;
    while (i < box.end && bytes[i] !== 0) label += String.fromCharCode(bytes[i++]);
  }
  return { code, label };
}

/* Walks the tree and hands every content box to `visit` along with the label
   of the superbox holding it, which is what says whether a CBOR blob is a
   claim, an action list or a hash nobody needs to read. */
function walkJumbf(bytes, start, end, visit, depth = 0) {
  if (depth > 8) return;
  for (const box of jumbfBoxes(bytes, start, end)) {
    if (box.type !== "jumb") {
      visit(box, null);
      continue;
    }
    const children = [...jumbfBoxes(bytes, box.dataStart, box.end)];
    const first = children[0];
    const description = first && first.type === "jumd" ? readDescriptionBox(bytes, first) : null;
    for (const child of children.slice(description ? 1 : 0)) {
      if (child.type === "jumb") walkJumbf(bytes, child.start, child.end, visit, depth + 1);
      else visit(child, description);
    }
  }
}

/* ---------- CBOR ----------
   Claims and assertions are CBOR. Only the subset a manifest actually uses is
   decoded: integers, byte and text strings, arrays, maps, tags and simple
   values. Anything unrecognised aborts cleanly rather than guessing. */

function decodeCbor(bytes, start, end) {
  const state = { at: start, end };
  try {
    const value = readCborItem(bytes, state);
    return value;
  } catch {
    return null;
  }
}

function readCborItem(bytes, state) {
  if (state.at >= state.end) throw new Error("cbor: past end");
  const initial = bytes[state.at++];
  const major = initial >> 5;
  const minor = initial & 0x1f;

  if (major === 7) {
    if (minor === 20) return false;
    if (minor === 21) return true;
    if (minor === 22 || minor === 23) return null;
    if (minor === 25) { state.at += 2; return 0; }
    if (minor === 26) { state.at += 4; return 0; }
    if (minor === 27) { state.at += 8; return 0; }
    return null;
  }

  const indefinite = minor === 31;
  const length = indefinite ? -1 : readCborLength(bytes, state, minor);

  switch (major) {
    case 0: return length;
    case 1: return -1 - length;
    case 2: {
      if (indefinite) return readCborChunks(bytes, state, 2);
      const slice = bytes.subarray(state.at, state.at + length);
      state.at += length;
      return slice;
    }
    case 3: {
      if (indefinite) return readCborChunks(bytes, state, 3);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(state.at, state.at + length));
      state.at += length;
      return text;
    }
    case 4: {
      const out = [];
      if (indefinite) {
        while (bytes[state.at] !== 0xff) out.push(readCborItem(bytes, state));
        state.at++;
        return out;
      }
      for (let i = 0; i < length; i++) out.push(readCborItem(bytes, state));
      return out;
    }
    case 5: {
      const out = {};
      if (indefinite) {
        while (bytes[state.at] !== 0xff) {
          const key = readCborItem(bytes, state);
          out[String(key)] = readCborItem(bytes, state);
        }
        state.at++;
        return out;
      }
      for (let i = 0; i < length; i++) {
        const key = readCborItem(bytes, state);
        out[String(key)] = readCborItem(bytes, state);
      }
      return out;
    }
    case 6: return readCborItem(bytes, state); // tag: the tag number is not needed
    default: throw new Error("cbor: bad major type");
  }
}

function readCborLength(bytes, state, minor) {
  if (minor < 24) return minor;
  if (minor === 24) return bytes[state.at++];
  if (minor === 25) {
    const v = (bytes[state.at] << 8) | bytes[state.at + 1];
    state.at += 2;
    return v;
  }
  if (minor === 26) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const v = view.getUint32(state.at);
    state.at += 4;
    return v;
  }
  if (minor === 27) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const v = view.getUint32(state.at) * 2 ** 32 + view.getUint32(state.at + 4);
    state.at += 8;
    return v;
  }
  throw new Error("cbor: reserved length");
}

function readCborChunks(bytes, state, major) {
  const parts = [];
  while (bytes[state.at] !== 0xff) parts.push(readCborItem(bytes, state));
  state.at++;
  return major === 3 ? parts.join("") : parts;
}

/* ---------- reading the manifest ---------- */

/* The digital source type is the field that answers "was this generated".
   Values come from the IPTC vocabulary the C2PA spec points at. */
const SOURCE_TYPES = [
  { token: "compositeWithTrainedAlgorithmicMedia", label: "partly AI generated, composited with model output" },
  { token: "trainedAlgorithmicMedia", label: "AI generated by a trained model" },
  { token: "algorithmicMedia", label: "generated by an algorithm, not a camera" },
  { token: "digitalCapture", label: "captured by a camera" },
  { token: "digitalCreation", label: "created in software" },
  { token: "minorHumanEdits", label: "captured, with minor human edits" },
];

const ACTION_LABELS = {
  "c2pa.created": "created",
  "c2pa.opened": "opened",
  "c2pa.edited": "edited",
  "c2pa.cropped": "cropped",
  "c2pa.resized": "resized",
  "c2pa.filtered": "filtered",
  "c2pa.color_adjustments": "colour adjusted",
  "c2pa.drawing": "drawn on",
  "c2pa.placed": "another asset placed into it",
  "c2pa.removed": "content removed",
  "c2pa.redacted": "redacted",
  "c2pa.converted": "converted",
  "c2pa.published": "published",
  "c2pa.transcoded": "transcoded",
  "c2pa.repackaged": "repackaged",
  "c2pa.unknown": "an unrecorded change",
};

/** Reads what a manifest store says. Returns null when it says nothing. */
function analyzeC2paManifest(bytes, start, end) {
  const limit = Math.min(end, bytes.length);
  if (limit - start < 8) return null;

  const analysis = {
    size: limit - start,
    generator: null,
    sourceType: null,
    actions: [],
    signer: findCertificateCommonName(bytes, start, limit),
    ingredients: 0,
    authors: [],
  };

  let sawJumbf = false;
  walkJumbf(bytes, start, limit, (box, description) => {
    const label = (description && description.label) || "";
    const code = (description && description.code) || "";
    if (description) sawJumbf = true;
    if (label.startsWith("c2pa.ingredient")) analysis.ingredients++;

    if (box.type === "cbor") {
      const value = decodeCbor(bytes, box.dataStart, box.end);
      if (value) readClaimObject(value, label || code, analysis);
    } else if (box.type === "json") {
      try {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(box.dataStart, box.end));
        readClaimObject(JSON.parse(text), label || code, analysis);
      } catch {
        // a JSON assertion that will not parse tells us nothing; move on
      }
    }
  });

  // a truncated or unknown-shaped manifest still gets read for the strings it
  // spells out in the clear, so detection never depends on a clean parse
  if (!analysis.generator || !analysis.sourceType) readManifestStrings(bytes, start, limit, analysis);
  analysis.parsed = sawJumbf;
  return analysis;
}

/* Pulls the interesting values out of a decoded claim or assertion. The same
   reader handles both, because the keys do not collide. */
function readClaimObject(value, label, analysis) {
  if (!value || typeof value !== "object") return;

  if (typeof value.claim_generator === "string" && !analysis.generator) {
    analysis.generator = tidy(value.claim_generator);
  }
  const info = value.claim_generator_info;
  if (!analysis.generator && Array.isArray(info) && info.length && typeof info[0] === "object") {
    const first = info[0];
    analysis.generator = tidy([first.name, first.version].filter(Boolean).join(" "));
  }

  for (const action of collectActions(value)) {
    if (typeof action === "string") {
      if (!analysis.actions.includes(action)) analysis.actions.push(action);
      continue;
    }
    if (!action || typeof action !== "object") continue;
    if (typeof action.action === "string" && !analysis.actions.includes(action.action)) {
      analysis.actions.push(action.action);
    }
    if (typeof action.softwareAgent === "string" && !analysis.generator) {
      analysis.generator = tidy(action.softwareAgent);
    } else if (action.softwareAgent && typeof action.softwareAgent === "object" && !analysis.generator) {
      analysis.generator = tidy([action.softwareAgent.name, action.softwareAgent.version].filter(Boolean).join(" "));
    }
    if (typeof action.digitalSourceType === "string") matchSourceType(action.digitalSourceType, analysis);
  }
  if (typeof value.digitalSourceType === "string") matchSourceType(value.digitalSourceType, analysis);

  // schema.org CreativeWork assertions are where a real name usually appears
  const authors = value.author || (value.data && value.data.author);
  if (Array.isArray(authors)) {
    for (const author of authors) {
      const name = typeof author === "string" ? author : author && author.name;
      if (name && !analysis.authors.includes(name)) analysis.authors.push(tidy(name));
    }
  }
  if (label.startsWith("c2pa.ingredient") && !analysis.ingredients) analysis.ingredients = 1;
}

function collectActions(value) {
  if (Array.isArray(value.actions)) return value.actions;
  if (value.data && Array.isArray(value.data.actions)) return value.data.actions;
  return [];
}

function matchSourceType(raw, analysis) {
  for (const { token, label } of SOURCE_TYPES) {
    if (raw.includes(token)) {
      // a more specific claim already recorded wins over a vaguer one
      if (!analysis.sourceType) analysis.sourceType = label;
      return;
    }
  }
}

function tidy(text) {
  const clean = String(text).replace(/[\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
}

/* Fallback for manifests this parser cannot walk: read what the bytes spell
   out. Only used to fill gaps the structured read left. */
function readManifestStrings(bytes, start, end, analysis) {
  const strings = printableStrings(bytes, start, end, 4);
  if (!analysis.sourceType) {
    for (const { token, label } of SOURCE_TYPES) {
      if (strings.some((s) => s.includes(token))) {
        analysis.sourceType = label;
        break;
      }
    }
  }
  for (const s of strings) {
    const match = /c2pa\.[a-z_]+/.exec(s);
    if (match && ACTION_LABELS[match[0]] && !analysis.actions.includes(match[0])) {
      analysis.actions.push(match[0]);
    }
  }
  if (!analysis.generator) {
    const versioned = strings.find((s) => /^[\w.+-]+\/\d+\.\d+/.test(s));
    if (versioned) analysis.generator = tidy(versioned);
  }
}

/* The signing certificate is DER inside the manifest, and DER spells out the
   common name in the clear: OID 2.5.4.3 (06 03 55 04 03) then a string. */
function findCertificateCommonName(bytes, start, end) {
  for (let i = start; i + 7 < end; i++) {
    if (bytes[i] !== 0x06 || bytes[i + 1] !== 0x03) continue;
    if (bytes[i + 2] !== 0x55 || bytes[i + 3] !== 0x04 || bytes[i + 4] !== 0x03) continue;
    const tag = bytes[i + 5];
    if (tag !== 0x0c && tag !== 0x13 && tag !== 0x16) continue;
    const length = bytes[i + 6];
    if (length < 1 || length > 64 || i + 7 + length > end) continue;
    const value = asciiRun(bytes, i + 7, i + 7 + length);
    if (value.length >= 2) return value;
  }
  return null;
}

function asciiRun(bytes, start, end) {
  let s = "";
  for (let i = start; i < end; i++) {
    const c = bytes[i];
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : "";
  }
  return s.trim();
}

function printableStrings(bytes, start, end, minLength) {
  const out = [];
  let current = "";
  for (let i = start; i < end; i++) {
    const c = bytes[i];
    if (c >= 32 && c < 127) {
      current += String.fromCharCode(c);
      continue;
    }
    if (current.length >= minLength) out.push(current);
    current = "";
  }
  if (current.length >= minLength) out.push(current);
  return out;
}

/* ---------- turning it into card rows ----------
   One removable row for the manifest itself, then plain rows for what it
   says. The detail rows carry no ranges of their own: they are facts about
   the same blob, so removing it removes all of them at once, and offering
   four tick boxes that all do the same thing would be a lie. */
function c2paFields(analysis, removal) {
  if (!analysis) return [];
  const fields = [
    {
      label: "Content Credentials",
      value: `signed provenance record, ${formatManifestSize(analysis.size)}`,
      risk: "identity",
      ...removal,
    },
  ];
  if (analysis.generator) {
    fields.push({ label: "Made with", value: analysis.generator, risk: "device" });
  }
  if (analysis.sourceType) {
    fields.push({ label: "Origin claim", value: analysis.sourceType, risk: "identity" });
  }
  if (analysis.signer) {
    fields.push({ label: "Signed by", value: analysis.signer, risk: "identity" });
  }
  if (analysis.authors.length) {
    fields.push({ label: "Named author", value: analysis.authors.join(", "), risk: "identity" });
  }
  if (analysis.actions.length) {
    fields.push({
      label: "Edit history",
      value: analysis.actions.map((a) => ACTION_LABELS[a] || a).join(", "),
      risk: "identity",
    });
  }
  if (analysis.ingredients) {
    fields.push({
      label: "Source files",
      value: `${analysis.ingredients} earlier file${analysis.ingredients === 1 ? "" : "s"} recorded as an ingredient`,
      risk: "identity",
    });
  }
  return fields;
}

function formatManifestSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
