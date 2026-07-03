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
    const card = renderCard(file);
    resultsEl.prepend(card);
  }
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCard(file) {
  const card = document.createElement("article");
  card.className = "result-card";

  const preview = document.createElement("img");
  preview.className = "result-card__preview";
  preview.alt = `Preview of ${file.name}`;
  preview.src = URL.createObjectURL(file);
  preview.addEventListener("load", () => URL.revokeObjectURL(preview.src), { once: true });

  const body = document.createElement("div");
  body.innerHTML = `
    <h3 class="result-card__name">${escapeHtml(file.name)}</h3>
    <p class="result-card__sub">${escapeHtml(file.type || "unknown type")} · ${formatBytes(file.size)}</p>
  `;

  card.append(preview, body);
  return card;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
