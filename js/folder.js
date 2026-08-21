/* MetaStrip — cleaning a whole folder.

   Paid tools cap the free tier at a handful of files at a time. A browser
   with the File System Access API can do the lot without uploading anything:
   pick a folder, and every supported file in it is read, cleaned and written
   out, one at a time, so memory stays flat whether it is ten files or a
   thousand.

   Originals are never overwritten. Cleaned copies go into a new
   metastrip-clean folder that mirrors the structure of what was picked, so a
   mistake costs nothing and the before and after sit side by side. */

const OUTPUT_DIR_NAME = "metastrip-clean";
const FOLDER_FILE_LIMIT = 1000;
const FOLDER_DEPTH_LIMIT = 8;

function folderModeSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/* Walks a directory handle depth first and yields the files worth opening.
   Takes any object with an async entries() iterator, which is what makes it
   testable without a real disk behind it. */
async function* walkDirectory(handle, path = "", depth = 0) {
  if (depth > FOLDER_DEPTH_LIMIT) return;
  for await (const [name, entry] of handle.entries()) {
    // never walk into our own output, or a cleaned copy would be cleaned again
    if (name === OUTPUT_DIR_NAME) continue;
    if (entry.kind === "directory") {
      yield* walkDirectory(entry, path ? `${path}/${name}` : name, depth + 1);
    } else if (entry.kind === "file" && isCleanableName(name)) {
      yield { name, path, entry };
    }
  }
}

/* Which files this tool has something to say about. Deliberately by extension:
   a folder walk should not have to open every file to find out. */
const CLEANABLE_EXT =
  /\.(jpe?g|png|heic|heif|webp|avif|gif|tiff?|dng|cr2|cr3|nef|nrw|arw|orf|raf|rw2|pef|srw|mp4|m4v|mov|qt|webm|mkv|3gp|3g2|pdf|mp3|m4a|m4b|aac|wav|wave|flac|ogg|oga|opus|aiff|aif)$/i;

function isCleanableName(name) {
  return CLEANABLE_EXT.test(name) && !name.startsWith(".");
}

/* Mirrors a relative path inside the output folder, creating as it goes. */
async function ensureOutputDirectory(root, path) {
  let dir = await root.getDirectoryHandle(OUTPUT_DIR_NAME, { create: true });
  if (!path) return dir;
  for (const part of path.split("/")) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

/** Cleans every supported file under `root`. Reports progress as it goes. */
async function cleanFolder(root, { onProgress, shouldStop } = {}) {
  const summary = { cleaned: 0, alreadyClean: 0, failed: 0, seen: 0, bytesRemoved: 0, items: [] };

  for await (const found of walkDirectory(root)) {
    if (shouldStop && shouldStop()) {
      summary.stopped = true;
      break;
    }
    if (summary.seen >= FOLDER_FILE_LIMIT) {
      summary.hitLimit = true;
      break;
    }
    summary.seen++;
    const label = found.path ? `${found.path}/${found.name}` : found.name;
    if (onProgress) onProgress({ label, ...summary });

    try {
      const file = await found.entry.getFile();
      const meta = await readMetadata(file);
      const removable = meta.fields.filter(isRemovableField).length + (meta.gps ? 1 : 0);
      if (!removable) {
        summary.alreadyClean++;
        summary.items.push({ label, status: "already clean" });
        continue;
      }

      const result = await computeCleanResult(file, meta, null);
      const outDir = await ensureOutputDirectory(root, found.path);
      const outName = cleanFilename(found.name, !result.lossless);
      const fileHandle = await outDir.getFileHandle(outName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(result.blob);
      await writable.close();

      summary.cleaned++;
      summary.bytesRemoved += Math.max(0, file.size - result.blob.size);
      summary.items.push({ label, status: "cleaned", removed: removable, wroteTo: `${OUTPUT_DIR_NAME}/${found.path ? `${found.path}/` : ""}${outName}` });
    } catch (err) {
      console.error("folder clean failed for", label, err);
      summary.failed++;
      summary.items.push({ label, status: "failed", reason: String(err && err.message ? err.message : err) });
    }
  }
  return summary;
}

/* ---------- wiring ---------- */

const folderBtn = document.getElementById("folderBtn");
const folderPanel = document.getElementById("folderPanel");
const folderStatus = document.getElementById("folderStatus");
const folderStopBtn = document.getElementById("folderStopBtn");

let folderStopRequested = false;

if (folderBtn) {
  if (!folderModeSupported()) {
    // Safari and Firefox have no directory picker; a button that cannot work
    // is worse than no button
    folderBtn.hidden = true;
  } else {
    folderBtn.addEventListener("click", runFolderMode);
  }
}

if (folderStopBtn) {
  folderStopBtn.addEventListener("click", () => {
    folderStopRequested = true;
    folderStopBtn.disabled = true;
    folderStopBtn.textContent = "STOPPING…";
  });
}

async function runFolderMode() {
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: "readwrite", id: "metastrip" });
  } catch {
    return; // the picker was dismissed, which is not an error
  }

  folderStopRequested = false;
  folderBtn.disabled = true;
  folderPanel.hidden = false;
  folderStopBtn.hidden = false;
  folderStopBtn.disabled = false;
  folderStopBtn.textContent = "STOP";
  setFolderStatus("Reading the folder…");

  try {
    const summary = await cleanFolder(root, {
      shouldStop: () => folderStopRequested,
      onProgress: ({ label, seen }) => setFolderStatus(`Cleaning ${seen}: ${label}`),
    });
    setFolderStatus(describeFolderSummary(summary));
    lastFolderSummary = summary;
    if (typeof renderReceipt === "function") renderReceipt();
  } catch (err) {
    console.error(err);
    setFolderStatus("That folder could not be read. Nothing was changed.");
  } finally {
    folderBtn.disabled = false;
    folderStopBtn.hidden = true;
  }
}

let lastFolderSummary = null;

function setFolderStatus(text) {
  if (folderStatus) folderStatus.textContent = text;
}

function describeFolderSummary(summary) {
  const parts = [];
  if (summary.cleaned) {
    parts.push(`${summary.cleaned} file${summary.cleaned === 1 ? "" : "s"} cleaned into ${OUTPUT_DIR_NAME}/`);
  }
  if (summary.alreadyClean) parts.push(`${summary.alreadyClean} already clean`);
  if (summary.failed) parts.push(`${summary.failed} could not be read`);
  if (!summary.seen) return "Nothing in that folder was a photo, video, document or audio file.";
  let text = `${parts.join(", ")}. Your originals were not touched.`;
  if (summary.bytesRemoved) text += ` ${formatBytes(summary.bytesRemoved)} of metadata removed.`;
  if (summary.stopped) text += " Stopped early, so the rest is untouched.";
  if (summary.hitLimit) text += ` Stopped at ${FOLDER_FILE_LIMIT} files, which is as many as one run handles.`;
  return text;
}
