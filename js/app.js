/* MetaStrip — app wiring: upload, preview, results */

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const resultsEl = document.getElementById("results");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("is-dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
  })
);
dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  for (const file of files) {
    const card = await renderCard(file);
    resultsEl.prepend(card);
  }
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

const RISK_META = {
  location: { icon: "📍", chip: "chip--location" },
  identity: { icon: "🪪", chip: "chip--identity" },
  device: { icon: "📷", chip: "chip--device" },
  time: { icon: "🕑", chip: "chip--time" },
};

async function renderCard(file) {
  const card = document.createElement("article");
  card.className = "result-card";

  const preview = document.createElement("img");
  preview.className = "result-card__preview";
  preview.alt = `Preview of ${file.name}`;
  preview.src = URL.createObjectURL(file);
  preview.addEventListener("load", () => URL.revokeObjectURL(preview.src), { once: true });

  const body = document.createElement("div");
  body.className = "result-card__body";
  body.innerHTML = `
    <h3 class="result-card__name">${escapeHtml(file.name)}</h3>
    <p class="result-card__sub">${escapeHtml(file.type || "unknown type")} · ${formatBytes(file.size)}</p>
  `;

  let meta = { fields: [], gps: null, format: "other" };
  try {
    meta = parseMetadata(await file.arrayBuffer());
  } catch (err) {
    console.error("metadata parse failed", err);
  }

  if (meta.gps) {
    const { lat, lon, alt } = meta.gps;
    const alert = document.createElement("div");
    alert.className = "gps-alert";
    alert.innerHTML = `
      <div>
        <strong>📍 THIS PHOTO LEAKS YOUR LOCATION</strong>
        <p>${lat.toFixed(6)}, ${lon.toFixed(6)}${alt != null ? ` · ${alt.toFixed(0)}m altitude` : ""}</p>
      </div>
      <a class="pill pill--dark" href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">SEE ON MAP ↗</a>
    `;
    body.appendChild(alert);
  }

  if (meta.fields.length || meta.gps) {
    const list = document.createElement("dl");
    list.className = "meta-list";
    for (const f of meta.fields) {
      const { icon } = RISK_META[f.risk] || RISK_META.device;
      const row = document.createElement("div");
      row.className = "meta-list__row";
      row.innerHTML = `
        <dt>${icon} ${escapeHtml(f.label)}</dt>
        <dd>${escapeHtml(f.value)}</dd>
      `;
      list.appendChild(row);
    }
    body.appendChild(list);
  } else {
    const clean = document.createElement("p");
    clean.className = "meta-clean";
    clean.textContent =
      meta.format === "other"
        ? "⚠️ Format not fully supported yet — metadata may still be present."
        : "✅ No readable metadata found. This photo looks clean already.";
    body.appendChild(clean);
  }

  body.appendChild(buildActions(file, meta));

  card.append(preview, body);
  return card;
}

function buildActions(file, meta) {
  const actions = document.createElement("div");
  actions.className = "result-card__actions";

  const btn = document.createElement("button");
  btn.className = "pill pill--strip";
  btn.textContent = "✂️ STRIP & DOWNLOAD";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "STRIPPING…";
    try {
      const buffer = await file.arrayBuffer();
      let result = stripMetadata(buffer);
      if (!result) result = await stripViaCanvas(file);
      if (!result) throw new Error("unsupported format");

      const blob = new Blob([result.bytes], { type: result.lossless ? file.type : "image/jpeg" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = cleanFilename(file.name, !result.lossless);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);

      const saved = file.size - blob.size;
      btn.textContent = "✅ CLEANED";
      note.textContent = result.lossless
        ? `Lossless — pixels untouched. ${saved > 0 ? formatBytes(saved) + " of metadata removed." : "Metadata removed."}`
        : "Re-encoded via canvas (format has no lossless path). Metadata gone.";
    } catch (err) {
      console.error(err);
      btn.textContent = "❌ FAILED — TRY ANOTHER FILE";
    } finally {
      btn.disabled = false;
      setTimeout(() => (btn.textContent = "✂️ STRIP & DOWNLOAD"), 4000);
    }
  });

  const note = document.createElement("span");
  note.className = "result-card__note";
  note.textContent =
    meta.format === "other" ? "Will re-encode to JPEG to remove metadata." : "Lossless — zero quality loss.";

  actions.append(btn, note);
  return actions;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
