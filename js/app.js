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

/* Paste a photo from the clipboard anywhere on the page */
document.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  handleFiles(files);
});

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!files.length) return;
  for (const file of files) {
    const card = await renderCard(file);
    resultsEl.prepend(card);
  }
  updateStripAllBar();
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ----- Strip all ----- */
const stripAllBar = document.getElementById("stripAllBar");
const stripAllBtn = document.getElementById("stripAllBtn");
const stripAllLabel = document.getElementById("stripAllLabel");

const sampleBtn = document.getElementById("sampleBtn");
sampleBtn.addEventListener("click", async () => {
  sampleBtn.disabled = true;
  sampleBtn.textContent = "Loading sample...";
  try {
    const res = await fetch("assets/sample-photo.jpg");
    const blob = await res.blob();
    const file = new File([blob], "sample-photo.jpg", { type: "image/jpeg" });
    await handleFiles([file]);
  } catch (err) {
    console.error("sample photo load failed", err);
  } finally {
    sampleBtn.disabled = false;
    sampleBtn.textContent = "Try a sample photo";
  }
});

function updateStripAllBar() {
  const count = resultsEl.children.length;
  stripAllBar.hidden = count < 2;
  if (count >= 2) stripAllLabel.textContent = `${count} photos loaded`;
}

stripAllBtn.addEventListener("click", async () => {
  const buttons = [...resultsEl.querySelectorAll(".result-card .pill--strip")];
  if (!buttons.length) return;
  stripAllBtn.disabled = true;
  for (let i = 0; i < buttons.length; i++) {
    stripAllBtn.textContent = `STRIPPING ${i + 1} OF ${buttons.length}`;
    buttons[i].click();
    await new Promise((r) => setTimeout(r, 700));
  }
  stripAllBtn.textContent = "ALL CLEANED";
  setTimeout(() => {
    stripAllBtn.disabled = false;
    stripAllBtn.textContent = "STRIP ALL & DOWNLOAD";
  }, 3000);
});

const icon = (id, cls = "icon") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"></use></svg>`;

/* heic2any is 1.3MB, so it loads only the first time a HEIC shows up */
let heicLibPromise = null;
function ensureHeicLib() {
  if (!heicLibPromise) {
    heicLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/heic2any.min.js";
      script.onload = () => resolve(window.heic2any);
      script.onerror = () => reject(new Error("could not load HEIC converter"));
      document.head.appendChild(script);
    });
  }
  return heicLibPromise;
}

async function heicToJpegBlob(file, quality) {
  const heic2any = await ensureHeicLib();
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality });
  return Array.isArray(out) ? out[0] : out;
}

const RISK_META = {
  location: { icon: icon("st-pin") },
  identity: { icon: icon("st-idcard") },
  device: { icon: icon("st-camera") },
  time: { icon: icon("st-clock") },
};

function scoreMeta(meta) {
  if (meta.gps) return { label: "LEAKING", cls: "score-badge--leak" };
  if (meta.fields.length) return { label: "RISKY", cls: "score-badge--risky" };
  return { label: "CLEAN", cls: "score-badge--clean" };
}

function makeBadge(meta) {
  const { label, cls } = scoreMeta(meta);
  const badge = document.createElement("span");
  badge.className = `score-badge ${cls}`;
  badge.textContent = label;
  return badge;
}

async function renderCard(file) {
  const card = document.createElement("article");
  card.className = "result-card";

  const preview = document.createElement("img");
  preview.className = "result-card__preview";
  preview.alt = `Preview of ${file.name}`;

  const body = document.createElement("div");
  body.className = "result-card__body";
  body.innerHTML = `
    <h3 class="result-card__name">${escapeHtml(file.name)}</h3>
    <p class="result-card__sub">${escapeHtml(file.type || "unknown type")}, ${formatBytes(file.size)}</p>
  `;

  let meta = { fields: [], gps: null, format: "other" };
  try {
    meta = parseMetadata(await file.arrayBuffer());
  } catch (err) {
    console.error("metadata parse failed", err);
  }

  if (meta.format === "heic") {
    // browsers other than Safari cannot show HEIC, so preview via conversion
    heicToJpegBlob(file, 0.5)
      .then((blob) => { preview.src = URL.createObjectURL(blob); })
      .catch(() => { preview.alt = "HEIC preview unavailable"; });
  } else {
    preview.src = URL.createObjectURL(file);
    preview.addEventListener("load", () => URL.revokeObjectURL(preview.src), { once: true });
  }

  if (meta.gps) {
    const { lat, lon, alt } = meta.gps;
    const alert = document.createElement("div");
    alert.className = "gps-alert";
    alert.innerHTML = `
      <div>
        <strong>${icon("st-pin", "icon icon--alert")} THIS PHOTO LEAKS YOUR LOCATION</strong>
        <p>${lat.toFixed(6)}, ${lon.toFixed(6)}${alt != null ? `, ${alt.toFixed(0)}m altitude` : ""}</p>
      </div>
      <div class="gps-alert__actions">
        <button class="pill pill--dark gps-alert__minimap-btn" type="button">SHOW MINI MAP</button>
        <a class="pill pill--dark" href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">OPEN THE MAP</a>
      </div>
    `;
    alert.querySelector(".gps-alert__minimap-btn").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.remove();
      alert.after(buildMiniMap(lat, lon));
    });
    body.appendChild(alert);
  }

  if (meta.fields.length || meta.gps) {
    const list = document.createElement("dl");
    list.className = "meta-list";
    const rows = [];
    if (meta.gps) rows.push({ label: "GPS location", value: `${meta.gps.lat.toFixed(6)}, ${meta.gps.lon.toFixed(6)}`, risk: "location", isGps: true });
    meta.fields.forEach((f, i) => rows.push({ ...f, fieldIndex: i }));
    for (const f of rows) {
      const riskIcon = (RISK_META[f.risk] || RISK_META.device).icon;
      const row = document.createElement("div");
      row.className = "meta-list__row";
      const removable = f.isGps || (f.ranges || f.chunkRange);
      row.innerHTML = `
        <dt>
          <label class="meta-check">
            <input type="checkbox" checked ${removable ? "" : "disabled"}
              ${f.isGps ? 'data-gps="1"' : `data-field="${f.fieldIndex}"`} />
            <span></span>
          </label>
          ${riskIcon} ${escapeHtml(f.label)}
        </dt>
        <dd>${escapeHtml(f.value)}</dd>
      `;
      list.appendChild(row);
    }
    const hint = document.createElement("p");
    hint.className = "meta-list__hint";
    hint.textContent = "Everything ticked gets removed. Untick anything you want to keep.";
    body.append(list, hint);
  } else {
    const clean = document.createElement("p");
    clean.className = "meta-clean";
    clean.innerHTML =
      meta.format === "other"
        ? `${icon("st-warn")} This format is not fully supported yet, so something may still be hiding in there.`
        : `${icon("st-shield")} Nothing readable in here. This photo already looks clean.`;
    body.appendChild(clean);
  }

  body.appendChild(buildActions(file, meta));

  const media = document.createElement("div");
  media.className = "result-card__media";
  media.append(preview, makeBadge(meta));

  card.append(media, body);
  return card;
}

/* Mini map: one OpenStreetMap tile, loaded only when asked, with the
   pin placed at the exact fraction of the tile the coordinates fall on. */
function tileMath(lat, lon, zoom) {
  const n = 2 ** zoom;
  const xFloat = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xFloat);
  const y = Math.floor(yFloat);
  return { x, y, px: (xFloat - x) * 256, py: (yFloat - y) * 256 };
}

function buildMiniMap(lat, lon) {
  const zoom = 14;
  const { x, y, px, py } = tileMath(lat, lon, zoom);
  const map = document.createElement("div");
  map.className = "mini-map";
  map.innerHTML = `
    <div class="mini-map__frame">
      <img src="https://tile.openstreetmap.org/${zoom}/${x}/${y}.png" width="256" height="256"
           alt="Map around the location this photo leaks" loading="lazy" />
      <span class="mini-map__pin" style="left:${px.toFixed(0)}px; top:${py.toFixed(0)}px">${icon("st-pin", "icon icon--pin")}</span>
    </div>
    <p class="mini-map__credit">Map tile from OpenStreetMap, fetched only because you asked.</p>
  `;
  return map;
}

function buildActions(file, meta) {
  const actions = document.createElement("div");
  actions.className = "result-card__actions";

  const btn = document.createElement("button");
  btn.className = "pill pill--strip";
  btn.innerHTML = `${icon("st-scissors")} STRIP & DOWNLOAD`;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.innerHTML = "STRIPPING…";
    try {
      const buffer = await file.arrayBuffer();
      const card = actions.closest(".result-card");
      const boxes = card ? [...card.querySelectorAll(".meta-check input:not(:disabled)")] : [];
      const keepingSome = boxes.length > 0 && boxes.some((b) => !b.checked);

      let result;
      if (keepingSome) {
        // in-place redaction works for JPEG, PNG and HEIC alike
        const remove = [];
        for (const b of boxes) {
          if (!b.checked) continue;
          if (b.dataset.gps) remove.push(meta.gps);
          else remove.push(meta.fields[Number(b.dataset.field)]);
        }
        result = selectiveStrip(buffer, remove);
      } else if (meta.format === "heic") {
        const jpeg = await heicToJpegBlob(file, 0.92);
        result = { bytes: new Uint8Array(await jpeg.arrayBuffer()), lossless: false };
      } else {
        result = stripMetadata(buffer);
        if (!result) result = await stripViaCanvas(file);
      }
      if (!result) throw new Error("unsupported format");

      const blob = new Blob([result.bytes], { type: result.lossless ? file.type : "image/jpeg" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = cleanFilename(file.name, !result.lossless);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);

      const saved = file.size - blob.size;
      btn.innerHTML = `${icon("st-shield")} CLEANED`;
      note.textContent = result.lossless
        ? `Done. Pixels untouched${saved > 0 ? ", " + formatBytes(saved) + " of metadata gone" : ""}.`
        : "Done. This format needed a fresh re-encode, and the metadata is gone.";
      showComparison(actions, meta, await blob.arrayBuffer());
    } catch (err) {
      console.error(err);
      btn.innerHTML = `${icon("st-warn")} THAT ONE FAILED, TRY ANOTHER`;
    } finally {
      btn.disabled = false;
      setTimeout(() => (btn.innerHTML = `${icon("st-scissors")} STRIP & DOWNLOAD`), 4000);
    }
  });

  const copyBtn = document.createElement("button");
  copyBtn.className = "pill pill--copy";
  copyBtn.textContent = "COPY CLEAN";
  copyBtn.title = "Copies the stripped image to your clipboard";
  copyBtn.addEventListener("click", async () => {
    copyBtn.disabled = true;
    copyBtn.textContent = "COPYING…";
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error("clipboard unsupported");
      const buffer = await file.arrayBuffer();
      let result = stripMetadata(buffer);
      if (!result) result = await stripViaCanvas(file);
      if (!result) throw new Error("unsupported format");

      // Clipboards only reliably accept PNG, so redraw the clean bytes as PNG.
      // Pixels come from the stripped file, so nothing sensitive rides along.
      const cleanBlob = new Blob([result.bytes], { type: result.lossless ? file.type : "image/jpeg" });
      const pngBlob = await toPngBlob(cleanBlob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      copyBtn.textContent = "COPIED, PASTE AWAY";
    } catch (err) {
      console.error(err);
      copyBtn.textContent = "COPY BLOCKED BY BROWSER";
    } finally {
      setTimeout(() => {
        copyBtn.disabled = false;
        copyBtn.textContent = "COPY CLEAN";
      }, 3000);
    }
  });

  const note = document.createElement("span");
  note.className = "result-card__note";
  note.textContent =
    meta.format === "heic"
      ? "Converts to a clean JPEG, or untick fields to redact the HEIC in place."
      : meta.format === "other"
        ? "This format will get a fresh JPEG re-encode."
        : "Lossless. Zero quality loss.";

  actions.append(btn, copyBtn, note);
  return actions;
}

async function toPngBlob(blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("png conversion failed");
  return png;
}

function showComparison(actionsEl, beforeMeta, cleanBuffer) {
  const card = actionsEl.closest(".result-card");
  if (!card || card.querySelector(".strip-compare")) return;

  let afterMeta = { fields: [], gps: null };
  try {
    afterMeta = parseMetadata(cleanBuffer);
  } catch (err) {
    console.error("post-strip parse failed", err);
  }

  const describe = (m) => {
    const parts = [];
    if (m.gps) parts.push("location");
    if (m.fields.length) parts.push(`${m.fields.length} ${m.fields.length === 1 ? "field" : "fields"}`);
    return parts.length ? parts.join(" and ") : "nothing";
  };

  const compare = document.createElement("div");
  compare.className = "strip-compare";
  compare.innerHTML = `
    <div class="strip-compare__col strip-compare__col--before">
      <span>BEFORE</span>
      <strong>${describe(beforeMeta)}</strong>
    </div>
    <div class="strip-compare__col strip-compare__col--after">
      <span>AFTER</span>
      <strong>${describe(afterMeta)}</strong>
    </div>
  `;
  actionsEl.after(compare);

  const badge = card.querySelector(".score-badge");
  if (badge) {
    const fresh = makeBadge(afterMeta);
    badge.replaceWith(fresh);
    fresh.classList.add("score-badge--flip");
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ----- PWA: service worker + shared photos from the Android share sheet ----- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

(async function pickUpSharedPhotos() {
  if (!/[?&]shared=/.test(location.search) || !("caches" in window)) return;
  try {
    const inbox = await caches.open("share-inbox");
    const keys = await inbox.keys();
    const files = [];
    for (const req of keys) {
      const res = await inbox.match(req);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get("X-Name") || "shared.jpg");
      files.push(new File([blob], name, { type: blob.type }));
      await inbox.delete(req);
    }
    history.replaceState(null, "", location.pathname);
    if (files.length) handleFiles(files);
  } catch (err) {
    console.error("shared photo pickup failed", err);
  }
})();
