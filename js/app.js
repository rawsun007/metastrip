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

/* Full-page drop zone: a photo can be dropped anywhere on the page, not
   just inside the box below. A depth counter avoids the classic flicker
   where dragenter/dragleave fire repeatedly as the drag crosses child
   elements within the page. */
const dropOverlay = document.getElementById("dropOverlay");
let dragDepth = 0;

function isFileDrag(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes("Files");
}

window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("is-active");
  dropzone.classList.add("is-dragover");
});
window.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropOverlay.classList.remove("is-active");
    dropzone.classList.remove("is-dragover");
  }
});
window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("is-active");
  dropzone.classList.remove("is-dragover");
  handleFiles(e.dataTransfer.files);
});

/* Paste a photo from the clipboard anywhere on the page */
document.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === "file" && (item.type.startsWith("image/") || item.type.startsWith("video/"))) {
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
  const files = [...fileList].filter(
    (f) => f.type.startsWith("image/") || isVideoFile(f) || /\.(heic|heif)$/i.test(f.name)
  );
  if (!files.length) return;
  const refused = [];
  for (const file of files) {
    const room = checkStorageRoom(file);
    if (!room.ok) {
      refused.push(room.reason);
      continue;
    }
    const card = await renderCard(file);
    resultsEl.prepend(card);
    trackLoaded(card, file);
  }
  if (refused.length) showStorageNotice(refused[0]);
  if (refused.length === files.length) return;
  updateStripAllBar();
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ----- Strip all ----- */
const stripAllBar = document.getElementById("stripAllBar");
const stripAllBtn = document.getElementById("stripAllBtn");
const stripAllLabel = document.getElementById("stripAllLabel");

function wireSampleButton(btn, path, filename, loadingText, idleText) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = loadingText;
    try {
      const res = await fetch(path);
      const blob = await res.blob();
      const file = new File([blob], filename, { type: "image/jpeg" });
      await handleFiles([file]);
    } catch (err) {
      console.error("sample photo load failed", path, err);
    } finally {
      btn.disabled = false;
      btn.textContent = idleText;
    }
  });
}

wireSampleButton(
  document.getElementById("sampleLeakBtn"),
  "assets/sample-photo.jpg",
  "sample-photo.jpg",
  "Loading...",
  "a leaking one"
);
wireSampleButton(
  document.getElementById("sampleCleanBtn"),
  "assets/sample-clean.jpg",
  "sample-clean.jpg",
  "Loading...",
  "an already-clean one"
);

function updateStripAllBar() {
  const count = resultsEl.children.length;
  stripAllBar.hidden = count < 2;
  if (count >= 2) stripAllLabel.textContent = `${describeLoad(storageUsage())} loaded`;
}

const STRIP_ALL_LABEL = "STRIP ALL & DOWNLOAD ZIP";

stripAllBtn.addEventListener("click", async () => {
  const cards = [...resultsEl.querySelectorAll(".result-card")];
  if (!cards.length) return;
  stripAllBtn.disabled = true;
  try {
    const JSZip = await ensureJSZip();
    const zip = new JSZip();
    const usedNames = new Set();
    let failures = 0;

    for (let i = 0; i < cards.length; i++) {
      stripAllBtn.textContent = `CLEANING ${i + 1} OF ${cards.length}`;
      const card = cards[i];
      const { _msFile: file, _msMeta: meta } = card;
      try {
        const result = await computeCleanResult(file, meta, card);
        const name = dedupeZipName(cleanFilename(file.name, !result.lossless), usedNames);
        zip.file(name, result.blob);
      } catch (err) {
        console.error("strip-all: one photo failed", file?.name, err);
        failures++;
      }
    }

    if (usedNames.size === 0) throw new Error("every photo failed to clean");

    stripAllBtn.textContent = "BUILDING ZIP...";
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    a.download = `metastrip-cleaned-${usedNames.size}-photo${usedNames.size === 1 ? "" : "s"}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);

    stripAllBtn.textContent = failures ? `ZIP READY, ${failures} FAILED` : "ZIP DOWNLOADED";
  } catch (err) {
    console.error(err);
    stripAllBtn.textContent = "SOMETHING FAILED, TRY AGAIN";
  } finally {
    setTimeout(() => {
      stripAllBtn.disabled = false;
      stripAllBtn.textContent = STRIP_ALL_LABEL;
    }, 3500);
  }
});

const icon = (id, cls = "icon") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"></use></svg>`;

/* JSZip loads only the first time "strip all" bundles more than one photo */
let jszipPromise = null;
function ensureJSZip() {
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/jszip.min.js";
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => reject(new Error("could not load the zip library"));
      document.head.appendChild(script);
    });
  }
  return jszipPromise;
}

function dedupeZipName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) {
    i++;
    candidate = `${stem}-${i}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

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
  settings: { icon: icon("st-aperture") },
  dimensions: { icon: icon("st-resize") },
};

/* Duration, frame size and codec are read out of boxes every player needs,
   so they are shown but never counted as a leak and never offered for
   removal. Only a field that can actually be removed scores. */
function isRemovableField(f) {
  return Boolean(f.ranges || f.chunkRange || (f.edits && f.edits.length));
}

function scoreMeta(meta) {
  if (meta.gps) return { label: "LEAKING", cls: "score-badge--leak" };
  if (meta.fields.some(isRemovableField)) return { label: "RISKY", cls: "score-badge--risky" };
  return { label: "CLEAN", cls: "score-badge--clean" };
}

function makeBadge(meta) {
  const { label, cls } = scoreMeta(meta);
  const badge = document.createElement("span");
  badge.className = `score-badge ${cls}`;
  badge.textContent = label;
  return badge;
}

/* One door for both worlds. A photo is small enough to read whole; a video
   is read by slicing, so it stays async either way. */
async function readMetadata(file) {
  if (isVideoFile(file)) return parseVideoMetadata(file);
  return parseMetadata(await file.arrayBuffer());
}

async function renderCard(file) {
  const card = document.createElement("article");
  card.className = "result-card";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "result-card__dismiss";
  dismissBtn.type = "button";
  dismissBtn.innerHTML = "&times;";
  dismissBtn.setAttribute("aria-label", `Remove ${file.name} from the list`);
  dismissBtn.addEventListener("click", () => {
    card.classList.add("is-removing");
    card.addEventListener(
      "animationend",
      () => {
        if (card._msObjectUrl) URL.revokeObjectURL(card._msObjectUrl);
        untrackLoaded(card, file);
        card.remove();
        updateStripAllBar();
      },
      { once: true }
    );
  });
  card.appendChild(dismissBtn);

  const isVideo = isVideoFile(file);
  const preview = document.createElement(isVideo ? "video" : "img");
  preview.className = isVideo ? "result-card__preview result-card__preview--video" : "result-card__preview";
  if (isVideo) {
    // metadata only: the browser reads the header for the poster frame and
    // leaves the rest of the file on disk until playback is asked for
    preview.preload = "metadata";
    preview.controls = true;
    preview.muted = true;
    preview.playsInline = true;
    preview.setAttribute("aria-label", `Preview of ${file.name}`);
  } else {
    preview.alt = `Preview of ${file.name}`;
  }

  const body = document.createElement("div");
  body.className = "result-card__body";
  body.innerHTML = `
    <h3 class="result-card__name">${escapeHtml(file.name)}</h3>
    <p class="result-card__sub">${escapeHtml(file.type || "unknown type")}, ${formatBytes(file.size)}</p>
  `;

  let meta = { fields: [], gps: null, format: "other" };
  try {
    meta = await readMetadata(file);
  } catch (err) {
    console.error("metadata parse failed", err);
  }

  if (meta.format === "heic") {
    // browsers other than Safari cannot show HEIC, so preview via conversion
    heicToJpegBlob(file, 0.5)
      .then((blob) => { preview.src = URL.createObjectURL(blob); })
      .catch(() => { preview.alt = "HEIC preview unavailable"; });
  } else if (isVideo) {
    // a video needs its URL for as long as the card lives, so it is released
    // when the card goes away instead of on first load
    card._msObjectUrl = URL.createObjectURL(file);
    preview.src = card._msObjectUrl;
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
    alert.querySelector(".gps-alert__minimap-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "LOADING MAP...";
      try {
        const L = await ensureLeaflet();
        const mapEl = miniMapShell();
        btn.remove();
        alert.after(mapEl); // attach to the document first, so Leaflet sees real layout size
        initMiniMap(L, mapEl.querySelector(".mini-map__frame"), lat, lon);
      } catch (err) {
        console.error("mini map failed to load", err);
        btn.disabled = false;
        btn.textContent = "SHOW MINI MAP";
      }
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
      const removable = f.isGps || isRemovableField(f);
      row.innerHTML = `
        <dt>
          <label class="meta-check">
            <input type="checkbox" checked ${removable ? "" : "disabled"}
              aria-label="Remove ${escapeHtml(f.label)}${removable ? "" : ", not removable in this format"}"
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
    hint.innerHTML = `Everything ticked gets removed. Untick anything you want to keep. <button class="meta-list__copy-json" type="button">Copy as JSON</button>`;
    hint.querySelector(".meta-list__copy-json").addEventListener("click", async (e) => {
      const copyBtn = e.currentTarget;
      const exportData = {
        file: file.name,
        gps: meta.gps ? { lat: meta.gps.lat, lon: meta.gps.lon, altitude: meta.gps.alt ?? null } : null,
        fields: meta.fields.map((f) => ({ label: f.label, value: f.value })),
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
        copyBtn.textContent = "Copied";
      } catch (err) {
        console.error(err);
        copyBtn.textContent = "Copy blocked by browser";
      } finally {
        setTimeout(() => (copyBtn.textContent = "Copy as JSON"), 2500);
      }
    });
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
  card._msFile = file; // read by the strip-all zip flow, no need to simulate clicks
  card._msMeta = meta;
  return card;
}

/* Mini map: a real interactive Leaflet map, loaded only when asked, so the
   pin sits exactly at the true coordinates instead of wherever a single
   static tile happens to put it. Leaflet and its CSS are lazily fetched
   the first time a mini map is opened. */
let leafletPromise = null;
function ensureLeaflet() {
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "vendor/leaflet/leaflet.css";
      document.head.appendChild(css);

      const script = document.createElement("script");
      script.src = "vendor/leaflet/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => reject(new Error("could not load the map library"));
      document.head.appendChild(script);
    });
  }
  return leafletPromise;
}

function miniMapShell() {
  const wrap = document.createElement("div");
  wrap.className = "mini-map";
  wrap.innerHTML = `
    <div class="mini-map__frame"></div>
    <p class="mini-map__credit">Map tiles from OpenStreetMap, fetched only because you asked. Drag or use the buttons to look around.</p>
  `;
  return wrap;
}

/* Must run only after `frame` is attached to the document. Leaflet reads
   the container's real layout size on init; on a detached node that size
   is zero, which throws off centering until the map is visible. */
// Plain geometric strokes instead of the "+"/"−" text glyphs Leaflet
// ships by default: those two characters sit at different optical centers
// in most fonts, which is what made the buttons look misaligned. A cross
// and a single bar drawn on the same baseline can't ever disagree.
const ZOOM_IN_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2 L8 14 M2 8 L14 8" stroke="#0a0a0a" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ZOOM_OUT_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 8 L14 8" stroke="#0a0a0a" stroke-width="2.4" stroke-linecap="round"/></svg>';
const RECENTER_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="#0a0a0a" stroke-width="2.4"/><circle cx="12" cy="12" r="2" fill="#0a0a0a"/><path d="M12 1 L12 4.5 M12 19.5 L12 23 M1 12 L4.5 12 M19.5 12 L23 12" stroke="#0a0a0a" stroke-width="2.4" stroke-linecap="round"/></svg>';

function initMiniMap(L, frame, lat, lon) {
  const map = L.map(frame, {
    center: [lat, lon],
    zoom: 15,
    zoomControl: false,
    scrollWheelZoom: false,
    attributionControl: true,
  });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

  const pinIcon = L.divIcon({
    html: icon("st-pin", "icon icon--pin"),
    className: "mini-map__marker",
    iconSize: [34, 36],
    iconAnchor: [17, 36],
  });
  L.marker([lat, lon], { icon: pinIcon, keyboard: false }).addTo(map);

  L.control
    .zoom({ position: "topleft", zoomInTitle: "Zoom in", zoomOutTitle: "Zoom out", zoomInText: ZOOM_IN_SVG, zoomOutText: ZOOM_OUT_SVG })
    .addTo(map);

  const RecenterControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control mini-map__recenter");
      const link = L.DomUtil.create("a", "", container);
      link.href = "#";
      link.title = "Back to the leaked location";
      link.setAttribute("aria-label", "Back to the leaked location");
      link.innerHTML = RECENTER_SVG;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(link, "click", (e) => {
        L.DomEvent.preventDefault(e);
        map.setView([lat, lon], 15);
      });
      return container;
    },
  });
  new RecenterControl().addTo(map);

  // re-check size once layout has definitely settled, then recenter exactly
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.setView([lat, lon], 15);
  });

  // let two-finger touch scroll the page normally, but wheel-zoom once the
  // visitor has actually clicked into the map, so it doesn't hijack scroll
  frame.addEventListener("click", () => map.scrollWheelZoom.enable(), { once: true });

  return map;
}

/* Shared by the per-card strip button and the strip-all zip flow, so both
   respect the same selective-strip checkboxes and HEIC handling.
   Returns a Blob rather than raw bytes: a video is assembled from slices of
   the original File, so nothing here ever holds a whole clip in memory. */
async function computeCleanResult(file, meta, card) {
  if (meta.kind === "video") return computeCleanVideo(file, meta, card);
  const buffer = await file.arrayBuffer();
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
  return { blob: new Blob([result.bytes], { type: result.lossless ? file.type : "image/jpeg" }), lossless: result.lossless };
}

/* Videos never round-trip through an ArrayBuffer: the edit list is byte
   ranges, and the result is slices of the file on disk. */
async function computeCleanVideo(file, meta, card) {
  const boxes = card ? [...card.querySelectorAll(".meta-check input:not(:disabled)")] : [];
  const keepingSome = boxes.length > 0 && boxes.some((b) => !b.checked);

  let edits;
  if (keepingSome) {
    edits = [];
    for (const b of boxes) {
      if (!b.checked) continue;
      const field = b.dataset.gps ? meta.gps : meta.fields[Number(b.dataset.field)];
      if (field && field.edits) edits.push(...field.edits);
    }
  } else {
    edits = allVideoEdits(meta);
  }
  if (!edits.length) throw new Error("nothing to strip");
  return stripVideoFile(file, edits);
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
      const card = actions.closest(".result-card");
      const result = await computeCleanResult(file, meta, card);

      const blob = result.blob;
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
      await showComparison(actions, meta, blob, file);
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
  // clipboards take images, not clips
  if (meta.kind === "video") copyBtn.style.display = "none";
  copyBtn.title = "Copies the stripped image to your clipboard";
  copyBtn.addEventListener("click", async () => {
    copyBtn.disabled = true;
    copyBtn.textContent = "COPYING…";
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error("clipboard unsupported");
      const result = await computeCleanResult(file, meta, actions.closest(".result-card"));

      // Clipboards only reliably accept PNG, so redraw the clean bytes as PNG.
      // Pixels come from the stripped file, so nothing sensitive rides along.
      const pngBlob = await toPngBlob(result.blob);
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

  const shareBtn = document.createElement("button");
  shareBtn.className = "pill pill--copy";
  shareBtn.textContent = "SHARE";
  shareBtn.title = "Share the cleaned photo to another app";
  shareBtn.style.display = "none"; // shown only if this browser can actually share files
  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    shareBtn.textContent = "SHARING…";
    try {
      const card = actions.closest(".result-card");
      const result = await computeCleanResult(file, meta, card);
      const shareFile = new File([result.blob], cleanFilename(file.name, !result.lossless), { type: result.blob.type });
      await navigator.share({ files: [shareFile], title: "Cleaned with MetaStrip" });
      shareBtn.textContent = "SHARED";
    } catch (err) {
      if (err.name === "AbortError") {
        shareBtn.textContent = "SHARE"; // the visitor just closed the share sheet, not a real failure
      } else {
        console.error(err);
        shareBtn.textContent = "SHARE FAILED";
      }
    } finally {
      shareBtn.disabled = false;
      setTimeout(() => (shareBtn.textContent = "SHARE"), 3000);
    }
  });
  // File sharing is only reliable on Android Chrome and mobile Safari; feature-detect
  // rather than showing a button that silently does nothing everywhere else.
  if (navigator.canShare) {
    try {
      const probe = new File(["x"], "probe.jpg", { type: "image/jpeg" });
      if (navigator.canShare({ files: [probe] })) shareBtn.style.display = "";
    } catch {
      // canShare threw on this browser, leave the button hidden
    }
  }

  const note = document.createElement("span");
  note.className = "result-card__note";
  note.textContent =
    meta.kind === "video"
      ? "Lossless. Metadata boxes are blanked in place, so every frame and every playback offset stays exactly as it was."
      : meta.format === "heic"
        ? "Converts to a clean JPEG, or untick fields to redact the HEIC in place."
        : meta.format === "other"
          ? "This format will get a fresh JPEG re-encode."
          : "Lossless. Zero quality loss.";

  actions.append(btn, copyBtn, shareBtn, note);
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

async function showComparison(actionsEl, beforeMeta, cleanBlob, originalFile) {
  const card = actionsEl.closest(".result-card");
  if (!card || card.querySelector(".strip-compare")) return;

  let afterMeta = { fields: [], gps: null };
  try {
    afterMeta = await readMetadata(new File([cleanBlob], originalFile.name, { type: cleanBlob.type }));
  } catch (err) {
    console.error("post-strip parse failed", err);
  }

  const describe = (m) => {
    const parts = [];
    if (m.gps) parts.push("location");
    const count = m.fields.filter(isRemovableField).length;
    if (count) parts.push(`${count} ${count === 1 ? "field" : "fields"}`);
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

  // Celebrate at the button the person actually clicked, not the thumbnail
  // badge in the corner — that's off-screen from their attention half the
  // time, which is exactly why this got reported as "I don't see anything."
  if (scoreMeta(afterMeta).label === "CLEAN") {
    const stripBtn = actionsEl.querySelector(".pill--strip");
    if (stripBtn) celebrateCleanAt(stripBtn, actionsEl);
  }
}

/* A one-shot confetti burst anchored on a specific element's true rendered
   position within a positioned ancestor, purely for the dopamine hit of
   watching LEAKING flip to CLEAN. Respects reduced-motion. */
const CONFETTI_COLORS = ["#fb4903", "#ffd731", "#4da2ff", "#55db9c", "#e9ccff", "#5c4ade"];

function celebrateCleanAt(targetEl, positionedParent) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const parentRect = positionedParent.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const x = targetRect.left - parentRect.left + targetRect.width / 2;
  const y = targetRect.top - parentRect.top + targetRect.height / 2;

  const burst = document.createElement("div");
  burst.className = "confetti-burst";
  burst.style.left = `${x}px`;
  burst.style.top = `${y}px`;
  const count = 16;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const distance = 50 + Math.random() * 46;
    const size = 7 + Math.random() * 6;
    piece.style.setProperty("--tx", `${Math.cos(angle) * distance}px`);
    piece.style.setProperty("--ty", `${Math.sin(angle) * distance}px`);
    piece.style.setProperty("--rot", `${(Math.random() - 0.5) * 360}deg`);
    piece.style.width = `${size}px`;
    piece.style.height = `${size}px`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDelay = `${Math.random() * 60}ms`;
    burst.appendChild(piece);
  }
  positionedParent.appendChild(burst);
  setTimeout(() => burst.remove(), 900);
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
