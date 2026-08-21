/* MetaStrip — a receipt for what was removed.

   "I cleaned it, trust me" is not much use when you are handing a file to a
   client, a court, a journalist or a landlord. This keeps a plain-text record
   of each file cleaned in this session: what was found, what is left, the
   sizes, and a SHA-256 of the bytes before and after so the exact file you
   sent can be matched to the line that describes it.

   It proves nothing about a file that never went through here, and it does
   not need to. It is a note you can hand over, generated on your own machine
   from work that happened on your own machine. */

const receiptEntries = [];
const RECEIPT_HASH_LIMIT = 256 * 1024 * 1024;

/** Records one cleaned file. Hashing is skipped for very large files. */
async function recordCleaned(file, beforeMeta, afterMeta, cleanBlob) {
  const entry = {
    name: file.name,
    at: new Date(),
    format: beforeMeta.format || "unknown",
    kind: beforeMeta.kind || "image",
    bytesBefore: file.size,
    bytesAfter: cleanBlob ? cleanBlob.size : file.size,
    removed: describeFindings(beforeMeta),
    remaining: describeFindings(afterMeta),
  };

  if (file.size <= RECEIPT_HASH_LIMIT) {
    entry.hashBefore = await sha256(file);
    if (cleanBlob) entry.hashAfter = await sha256(cleanBlob);
  } else {
    entry.hashNote = `not hashed, over ${Math.round(RECEIPT_HASH_LIMIT / (1024 * 1024))} MB`;
  }

  receiptEntries.push(entry);
  renderReceipt();
  return entry;
}

/** Records a folder run, which cleans without ever building a card. */
function recordFolderRun(summary) {
  for (const item of summary.items) {
    if (item.status !== "cleaned") continue;
    receiptEntries.push({
      name: item.label,
      at: new Date(),
      format: "folder",
      kind: "folder",
      removed: [`${item.removed} field${item.removed === 1 ? "" : "s"}`],
      remaining: [],
      wroteTo: item.wroteTo,
    });
  }
  renderReceipt();
}

function describeFindings(meta) {
  if (!meta) return [];
  const parts = [];
  if (meta.gps) parts.push(`GPS location ${meta.gps.lat.toFixed(4)}, ${meta.gps.lon.toFixed(4)}`);
  for (const field of meta.fields || []) {
    if (typeof isRemovableField === "function" && !isRemovableField(field)) continue;
    parts.push(field.label);
  }
  return parts;
}

async function sha256(blobOrFile) {
  if (!globalThis.crypto || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await blobOrFile.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- the document ----------
   Plain text on purpose: it pastes into an email, a ticket or a chat without
   turning into an attachment nobody opens. */
function formatReceipt(entries, { generatedAt, version = "MetaStrip" } = {}) {
  const stamp = (generatedAt || new Date()).toISOString().replace("T", " ").replace(/\..*/, " UTC");
  const lines = [
    `${version} — metadata removal receipt`,
    `Generated ${stamp}`,
    "Everything below happened in the browser on this device. Nothing was uploaded.",
    "",
  ];

  if (!entries.length) {
    lines.push("No files cleaned yet.");
    return lines.join("\n");
  }

  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.name}`);
    if (entry.bytesBefore != null) {
      const delta = entry.bytesBefore - (entry.bytesAfter ?? entry.bytesBefore);
      lines.push(
        `   size: ${entry.bytesBefore} bytes -> ${entry.bytesAfter} bytes` +
          (delta > 0 ? ` (${delta} removed)` : delta < 0 ? " (re-encoded)" : " (blanked in place)")
      );
    }
    lines.push(`   removed: ${entry.removed.length ? entry.removed.join(", ") : "nothing found"}`);
    lines.push(`   remaining: ${entry.remaining.length ? entry.remaining.join(", ") : "nothing readable"}`);
    if (entry.wroteTo) lines.push(`   written to: ${entry.wroteTo}`);
    if (entry.hashBefore) lines.push(`   sha256 before: ${entry.hashBefore}`);
    if (entry.hashAfter) lines.push(`   sha256 after:  ${entry.hashAfter}`);
    if (entry.hashNote) lines.push(`   sha256: ${entry.hashNote}`);
    lines.push("");
  });

  const cleaned = entries.length;
  lines.push(`${cleaned} file${cleaned === 1 ? "" : "s"} cleaned in this session.`);
  lines.push("Hashes let whoever receives a file check that it is the one this receipt describes:");
  lines.push("  shasum -a 256 <file>");
  return lines.join("\n");
}

/* ---------- rendering ---------- */

const receiptPanel = typeof document !== "undefined" ? document.getElementById("receiptPanel") : null;

function renderReceipt() {
  if (!receiptPanel) return;
  if (!receiptEntries.length) {
    receiptPanel.hidden = true;
    return;
  }
  receiptPanel.hidden = false;
  const count = receiptEntries.length;
  receiptPanel.innerHTML = `
    <div class="receipt__head">
      <h3 class="receipt__title">${icon("st-shield")} Receipt for ${count} cleaned file${count === 1 ? "" : "s"}</h3>
      <p class="receipt__note">Plain text, with a SHA-256 of each file before and after, so whoever receives one can check it is the file this describes.</p>
    </div>
    <div class="receipt__actions">
      <button class="pill pill--dark" id="receiptCopyBtn" type="button">COPY RECEIPT</button>
      <button class="pill pill--dark" id="receiptSaveBtn" type="button">SAVE AS TXT</button>
    </div>
    <pre class="receipt__body" id="receiptBody" tabindex="0" role="group" aria-label="Receipt text">${escapeHtml(formatReceipt(receiptEntries, {}))}</pre>
  `;
  receiptPanel.querySelector("#receiptCopyBtn").addEventListener("click", copyReceipt);
  receiptPanel.querySelector("#receiptSaveBtn").addEventListener("click", saveReceipt);
}

async function copyReceipt() {
  const button = receiptPanel.querySelector("#receiptCopyBtn");
  try {
    await navigator.clipboard.writeText(formatReceipt(receiptEntries, {}));
    button.textContent = "COPIED";
  } catch (err) {
    console.error(err);
    button.textContent = "COPY BLOCKED BY BROWSER";
  }
  setTimeout(() => (button.textContent = "COPY RECEIPT"), 2500);
}

function saveReceipt() {
  const blob = new Blob([formatReceipt(receiptEntries, {})], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "metastrip-receipt.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
