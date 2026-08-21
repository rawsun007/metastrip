/* MetaStrip — redacting the picture itself.

   Everything else here removes what is written *about* a file. This removes
   what is visible *in* it, which is the leak metadata stripping cannot touch:
   the face, the number plate, the address on the envelope, the email in the
   screenshot.

   Two deliberate limits, both stated in the UI rather than papered over.

   Automatic face detection is not shipped. Bundling a detection model would
   mean megabytes of weights and a promise this page cannot keep — a missed
   face reads as "no faces here", which is worse than no feature at all. Where
   a browser already exposes its own detector, it is used to place the first
   boxes, and everywhere else you draw them.

   Redacting re-encodes the picture, so it is the one operation here that is
   not lossless. The pixels under a box are gone rather than covered: a
   blackout writes black into the canvas and a pixelate averages each block,
   so there is no layer to peel off. */

const REDACT_BLOCK_SIZE = 16;

function canRedact(meta, file) {
  // needs pixels the browser can actually decode
  if (!file.type.startsWith("image/")) return false;
  return meta.format === "jpeg" || meta.format === "png" || meta.format === "other";
}

/* ---------- the pixel work ---------- */

/** Fills a box with black. Returns the number of pixels changed. */
function blackoutRegion(imageData, box) {
  const { data, width } = imageData;
  const region = clampBox(box, imageData.width, imageData.height);
  let changed = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const at = (y * width + x) * 4;
      data[at] = 0;
      data[at + 1] = 0;
      data[at + 2] = 0;
      data[at + 3] = 255;
      changed++;
    }
  }
  return changed;
}

/** Averages each block in a box, so detail is destroyed rather than hidden. */
function pixelateRegion(imageData, box, blockSize = REDACT_BLOCK_SIZE) {
  const { data, width } = imageData;
  const region = clampBox(box, imageData.width, imageData.height);
  for (let blockY = region.y; blockY < region.y + region.height; blockY += blockSize) {
    for (let blockX = region.x; blockX < region.x + region.width; blockX += blockSize) {
      const maxY = Math.min(blockY + blockSize, region.y + region.height);
      const maxX = Math.min(blockX + blockSize, region.x + region.width);
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = blockY; y < maxY; y++) {
        for (let x = blockX; x < maxX; x++) {
          const at = (y * width + x) * 4;
          r += data[at];
          g += data[at + 1];
          b += data[at + 2];
          count++;
        }
      }
      if (!count) continue;
      const avgR = Math.round(r / count);
      const avgG = Math.round(g / count);
      const avgB = Math.round(b / count);
      for (let y = blockY; y < maxY; y++) {
        for (let x = blockX; x < maxX; x++) {
          const at = (y * width + x) * 4;
          data[at] = avgR;
          data[at + 1] = avgG;
          data[at + 2] = avgB;
          data[at + 3] = 255;
        }
      }
    }
  }
  return region.width * region.height;
}

/* A box drawn by dragging can have negative width, run off the edge, or be a
   stray click. Normalising once here keeps every caller honest. */
function normaliseBox(from, to) {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

function clampBox(box, maxWidth, maxHeight) {
  const x = Math.max(0, Math.min(Math.round(box.x), maxWidth));
  const y = Math.max(0, Math.min(Math.round(box.y), maxHeight));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(box.width), maxWidth - x)),
    height: Math.max(0, Math.min(Math.round(box.height), maxHeight - y)),
  };
}

function isUsefulBox(box) {
  return box.width >= 4 && box.height >= 4;
}

/* ---------- screenshots ----------
   A screenshot has no camera metadata to remove, so the tool would call it
   clean while the interesting part sits in the pixels: names, addresses,
   balances, email threads. No OCR is claimed or performed — this only points
   out that stripping metadata does nothing about what is on screen. */
const SCREEN_SIZES = new Set([
  "1920x1080", "1080x1920", "2560x1440", "1440x2560", "3840x2160",
  "1170x2532", "1179x2556", "1290x2796", "1284x2778", "1242x2688", "828x1792",
  "1440x3120", "1440x3200", "1080x2400", "1080x2340", "1080x2280",
  "2732x2048", "2048x2732", "2360x1640", "1640x2360", "2880x1800", "3024x1964",
]);

function looksLikeScreenshot({ name = "", meta, width = 0, height = 0 }) {
  if (/^(screenshot|screen shot|capture|screencapture|scr_)/i.test(name.trim())) return true;
  const hasCamera = (meta.fields || []).some(
    (f) => f.label === "Camera make" || f.label === "Camera model" || f.label === "Lens model"
  );
  if (hasCamera || meta.gps) return false;
  return width > 0 && height > 0 && SCREEN_SIZES.has(`${width}x${height}`);
}

function screenshotWarningField() {
  return {
    label: "Looks like a screenshot",
    value:
      "there is no camera data to remove, but a screenshot leaks through its pixels — names, addresses, balances. Use REDACT PIXELS for that.",
    risk: "identity",
  };
}

/* ---------- the editor ---------- */

/** Opens the redaction editor for one file. Resolves when it closes. */
async function openRedactor(file, card) {
  const bitmap = await createImageBitmap(file);
  const overlay = buildRedactorShell(file.name);
  document.body.appendChild(overlay);
  document.body.classList.add("is-locked");

  const canvas = overlay.querySelector(".redactor__canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  context.drawImage(bitmap, 0, 0);
  const original = context.getImageData(0, 0, canvas.width, canvas.height);

  const boxes = [];
  let mode = "blackout";
  let dragFrom = null;
  let dragTo = null;

  const status = overlay.querySelector(".redactor__status");
  const repaint = () => {
    const working = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    for (const box of boxes) {
      if (box.mode === "pixelate") pixelateRegion(working, box);
      else blackoutRegion(working, box);
    }
    context.putImageData(working, 0, 0);
    if (dragFrom && dragTo) {
      context.save();
      context.strokeStyle = "#fb4903";
      context.lineWidth = Math.max(2, canvas.width / 400);
      context.setLineDash([8, 6]);
      const preview = normaliseBox(dragFrom, dragTo);
      context.strokeRect(preview.x, preview.y, preview.width, preview.height);
      context.restore();
    }
    status.textContent = boxes.length
      ? `${boxes.length} area${boxes.length === 1 ? "" : "s"} redacted. The pixels underneath are gone, not covered.`
      : "Drag across anything you want gone: a face, a plate, an address, a name on screen.";
  };

  const toImagePoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    dragFrom = toImagePoint(event);
    dragTo = dragFrom;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    dragTo = toImagePoint(event);
    repaint();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragFrom) return;
    const box = normaliseBox(dragFrom, toImagePoint(event));
    dragFrom = null;
    dragTo = null;
    if (isUsefulBox(box)) boxes.push({ ...box, mode });
    repaint();
  });

  overlay.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      overlay.querySelectorAll("[data-mode]").forEach((other) => other.classList.toggle("is-on", other === button));
    });
  });

  overlay.querySelector(".redactor__undo").addEventListener("click", () => {
    boxes.pop();
    repaint();
  });

  // where the browser has its own detector, use it for a first pass
  const autoBtn = overlay.querySelector(".redactor__auto");
  if (typeof window.FaceDetector === "function") {
    autoBtn.addEventListener("click", async () => {
      autoBtn.disabled = true;
      autoBtn.textContent = "LOOKING…";
      try {
        const detector = new window.FaceDetector({ fastMode: true });
        const faces = await detector.detect(canvas);
        for (const face of faces) {
          const b = face.boundingBox;
          boxes.push({ x: b.x, y: b.y, width: b.width, height: b.height, mode });
        }
        autoBtn.textContent = faces.length ? `FOUND ${faces.length}` : "FOUND NONE, DRAW THEM";
      } catch (err) {
        console.error("face detection failed", err);
        autoBtn.textContent = "DETECTION UNAVAILABLE";
      } finally {
        repaint();
        setTimeout(() => {
          autoBtn.disabled = false;
          autoBtn.textContent = "FIND FACES";
        }, 2500);
      }
    });
  } else {
    autoBtn.hidden = true;
  }

  const close = () => {
    overlay.remove();
    document.body.classList.remove("is-locked");
    bitmap.close();
  };

  overlay.querySelector(".redactor__cancel").addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", function onKey(event) {
    if (event.key !== "Escape") return;
    document.removeEventListener("keydown", onKey);
    close();
  });

  overlay.querySelector(".redactor__save").addEventListener("click", async () => {
    if (!boxes.length) {
      status.textContent = "Nothing is redacted yet, so there is nothing to save.";
      return;
    }
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.94));
    if (!blob) {
      status.textContent = "This browser could not export the picture.";
      return;
    }
    const name = file.name.replace(/(\.[^.]+)?$/, `-redacted.${type === "image/png" ? "png" : "jpg"}`);
    downloadBlob(blob, name);
    if (typeof recordCleaned === "function") {
      const after = await readMetadata(new File([blob], name, { type }));
      const before = card && card._msMeta ? card._msMeta : { fields: [], gps: null };
      const entry = await recordCleaned(new File([blob], name, { type }), before, after, blob);
      entry.removed = [...entry.removed, `${boxes.length} redacted area${boxes.length === 1 ? "" : "s"}`];
      if (typeof renderReceipt === "function") renderReceipt();
    }
    close();
  });

  repaint();
}

function buildRedactorShell(filename) {
  const overlay = document.createElement("div");
  overlay.className = "redactor";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", `Redact areas of ${filename}`);
  overlay.innerHTML = `
    <div class="redactor__panel">
      <div class="redactor__bar">
        <button class="pill pill--light is-on" type="button" data-mode="blackout">BLACK OUT</button>
        <button class="pill pill--light" type="button" data-mode="pixelate">PIXELATE</button>
        <button class="pill pill--dark redactor__auto" type="button">FIND FACES</button>
        <button class="pill pill--dark redactor__undo" type="button">UNDO</button>
        <span class="redactor__spacer"></span>
        <button class="pill pill--dark redactor__cancel" type="button">CANCEL</button>
        <button class="pill pill--strip redactor__save" type="button">SAVE REDACTED COPY</button>
      </div>
      <div class="redactor__stage"><canvas class="redactor__canvas"></canvas></div>
      <p class="redactor__status"></p>
      <p class="redactor__note">Saving re-encodes the picture, so this is the one thing here that is not lossless. Your original file is untouched, and the copy carries no metadata at all.</p>
    </div>
  `;
  return overlay;
}
