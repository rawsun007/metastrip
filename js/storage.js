/* MetaStrip — storage budget.

   Photos were small enough that the page could hold as many as it liked. A
   video changes that: one 4K clip off a phone can be larger than every
   photo anyone has ever dropped here put together, and the tab will happily
   die trying to hold a handful of them.

   Nothing here uploads or persists anything. It is a budget: what is loaded
   right now, what the page will accept, and an honest meter so a refusal
   never looks like a bug. */

const STORAGE_LIMITS = {
  /* One file. Above this the browser struggles to hand out a Blob URL and a
     download at the same time, and there is nothing useful to show. */
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  /* Everything currently on screen, since each card keeps a live object URL
     and, for video, a decoder attached to it. */
  maxTotalBytes: 6 * 1024 * 1024 * 1024,
  /* Card count matters on its own: twenty video elements will stutter a
     mid-range phone long before the byte budget runs out. */
  maxCards: 20,
};

const loadedBytesByCard = new WeakMap();
let loadedTotal = 0;
let loadedCount = 0;
let loadedVideoCount = 0;

function storageUsage() {
  return {
    bytes: loadedTotal,
    count: loadedCount,
    videos: loadedVideoCount,
    photos: loadedCount - loadedVideoCount,
    limit: STORAGE_LIMITS.maxTotalBytes,
    ratio: loadedTotal / STORAGE_LIMITS.maxTotalBytes,
  };
}

/** Can this file be added right now? Returns a reason when it cannot, so the
    caller can say exactly what happened instead of failing quietly. */
function checkStorageRoom(file) {
  if (file.size > STORAGE_LIMITS.maxFileBytes) {
    return {
      ok: false,
      reason: `${file.name} is ${formatBytes(file.size)}. This page handles up to ${formatBytes(STORAGE_LIMITS.maxFileBytes)} per file, so your browser does not run out of room mid-clean.`,
    };
  }
  if (loadedCount >= STORAGE_LIMITS.maxCards) {
    return {
      ok: false,
      reason: `${STORAGE_LIMITS.maxCards} files are already open, which is as many as one tab handles comfortably. Clean or dismiss a few, then add more.`,
    };
  }
  if (loadedTotal + file.size > STORAGE_LIMITS.maxTotalBytes) {
    return {
      ok: false,
      reason: `${file.name} would push this tab past ${formatBytes(STORAGE_LIMITS.maxTotalBytes)} of open files. Dismiss something first and it will fit.`,
    };
  }
  return { ok: true };
}

function trackLoaded(card, file) {
  loadedBytesByCard.set(card, file.size);
  loadedTotal += file.size;
  loadedCount++;
  if (isVideoFile(file)) loadedVideoCount++;
  renderStorageMeter();
}

function untrackLoaded(card, file) {
  if (!loadedBytesByCard.has(card)) return;
  loadedTotal = Math.max(0, loadedTotal - loadedBytesByCard.get(card));
  loadedBytesByCard.delete(card);
  loadedCount = Math.max(0, loadedCount - 1);
  if (file && isVideoFile(file)) loadedVideoCount = Math.max(0, loadedVideoCount - 1);
  renderStorageMeter();
}

/* ---------- the meter ---------- */

const storageMeter = document.getElementById("storageMeter");
const storageMeterFill = document.getElementById("storageMeterFill");
const storageMeterText = document.getElementById("storageMeterText");

function renderStorageMeter() {
  if (!storageMeter) return;
  const use = storageUsage();
  storageMeter.hidden = use.count === 0;
  if (!use.count) return;
  const percent = Math.min(100, use.ratio * 100);
  storageMeterFill.style.width = `${percent.toFixed(1)}%`;
  storageMeter.classList.toggle("storage-meter--warn", use.ratio >= 0.75);
  storageMeterText.textContent =
    `${describeLoad(use)} open, ${formatBytes(use.bytes)} of ${formatBytes(use.limit)} this tab will hold. Nothing is uploaded or saved.`;
}

function describeLoad({ photos, videos }) {
  const parts = [];
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  return parts.join(" and ") || "nothing";
}

/* ---------- refusals ---------- */

const storageNotice = document.getElementById("storageNotice");
let noticeTimer = null;

function showStorageNotice(message) {
  if (!storageNotice) return;
  storageNotice.textContent = message;
  storageNotice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    storageNotice.hidden = true;
  }, 9000);
}

/* ---------- keeping playback cheap ----------
   Several decoding videos at once is the other way this page falls over, so
   only the clip being watched ever plays. */
function pauseOtherVideos(playing) {
  for (const other of document.querySelectorAll(".result-card__preview--video")) {
    if (other !== playing && !other.paused) other.pause();
  }
}

document.addEventListener(
  "play",
  (e) => {
    if (e.target instanceof HTMLVideoElement) pauseOtherVideos(e.target);
  },
  true
);
