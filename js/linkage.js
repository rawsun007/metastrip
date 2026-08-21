/* MetaStrip — what a set of files says together.

   One photo leaking a camera serial is a fact about that photo. Five photos
   leaking the same serial is a different thing: it ties them to one device,
   which is how an anonymous account gets linked to a named one, and how two
   listings on a marketplace get shown to be the same seller.

   None of this needs any new parsing. It is what the metadata already read
   says when you line the files up next to each other, which is exactly the
   view nobody gets from a tool that handles one file at a time. */

/* Roughly how close two coordinates have to be to count as the same place.
   100 m is a building, not a neighbourhood. */
const SAME_PLACE_METRES = 100;
const SAME_TIME_MINUTES = 30;

/* Fields that identify a device or a person, in the order they matter. */
const LINKING_FIELDS = [
  { label: "Camera serial no.", claim: "came off the same camera body" },
  { label: "Lens serial no.", claim: "were shot with the same lens" },
  { label: "Owner name", claim: "are registered to the same owner" },
  { label: "Artist", claim: "name the same photographer" },
  { label: "Author", claim: "name the same author" },
  { label: "Named author", claim: "name the same author" },
  { label: "Live Photo pairing id", claim: "are halves of the same capture" },
  { label: "Camera identifier", claim: "came off the same camera" },
  { label: "File identifier", claim: "are versions of the same document" },
  { label: "Signed by", claim: "were signed by the same certificate" },
  { label: "Camera model", claim: "were taken on the same model of device" },
  { label: "Camera make", claim: "were taken on the same make of device" },
  { label: "Software", claim: "went through the same software" },
  { label: "Written by", claim: "were written by the same tool" },
  { label: "Made with", claim: "were made with the same tool" },
  { label: "Encoder software", claim: "were encoded by the same software" },
];

/** Findings across a set of { name, meta } entries, strongest first. */
function computeLinkage(entries) {
  const usable = entries.filter((e) => e && e.meta);
  if (usable.length < 2) return [];

  const findings = [];
  for (const { label, claim } of LINKING_FIELDS) {
    for (const group of groupByFieldValue(usable, label)) {
      findings.push({
        kind: label === "Camera model" || label === "Camera make" || /software|tool/.test(claim) ? "weak" : "strong",
        text: `${countFiles(group.files)} ${claim}`,
        detail: `${label}: ${group.value}`,
        files: group.files,
      });
    }
  }

  findings.push(...placeFindings(usable));
  findings.push(...timeFindings(usable));

  // strong links first, then whichever covers more files
  findings.sort((a, b) => (a.kind === b.kind ? b.files.length - a.files.length : a.kind === "strong" ? -1 : 1));
  return findings;
}

function groupByFieldValue(entries, label) {
  const buckets = new Map();
  for (const entry of entries) {
    const field = entry.meta.fields.find((f) => f.label === label);
    if (!field || !field.value) continue;
    const key = String(field.value).trim().toLowerCase();
    if (key.length < 2) continue;
    if (!buckets.has(key)) buckets.set(key, { value: field.value, files: [] });
    buckets.get(key).files.push(entry.name);
  }
  return [...buckets.values()].filter((b) => b.files.length > 1);
}

/* Coordinates get compared pairwise and then merged, so three photos taken
   along one street read as one finding rather than three. */
function placeFindings(entries) {
  const located = entries.filter((e) => e.meta.gps);
  if (located.length < 2) return [];

  const clusters = [];
  for (const entry of located) {
    const home = clusters.find((cluster) =>
      cluster.points.some((point) => metresBetween(point, entry.meta.gps) <= SAME_PLACE_METRES)
    );
    if (home) {
      home.points.push(entry.meta.gps);
      home.files.push(entry.name);
    } else {
      clusters.push({ points: [entry.meta.gps], files: [entry.name] });
    }
  }

  return clusters
    .filter((cluster) => cluster.files.length > 1)
    .map((cluster) => ({
      kind: "strong",
      text: `${countFiles(cluster.files)} were recorded within ${SAME_PLACE_METRES} m of each other`,
      detail: `around ${cluster.points[0].lat.toFixed(4)}, ${cluster.points[0].lon.toFixed(4)}`,
      files: cluster.files,
    }));
}

/* Haversine, which is exact enough at these distances and needs no lookup. */
function metresBetween(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

const TIME_LABELS = ["Taken", "Recorded", "Digitized", "Created", "Modified", "Last modified"];

function timeFindings(entries) {
  const stamped = [];
  for (const entry of entries) {
    const stamp = firstTimestamp(entry.meta);
    if (stamp) stamped.push({ name: entry.name, at: stamp });
  }
  if (stamped.length < 2) return [];
  stamped.sort((a, b) => a.at - b.at);

  const runs = [[stamped[0]]];
  for (const item of stamped.slice(1)) {
    const run = runs[runs.length - 1];
    const gap = (item.at - run[run.length - 1].at) / 60000;
    if (gap <= SAME_TIME_MINUTES) run.push(item);
    else runs.push([item]);
  }

  return runs
    .filter((run) => run.length > 1)
    .map((run) => ({
      kind: "weak",
      text: `${countFiles(run.map((r) => r.name))} were recorded within ${Math.max(
        1,
        Math.round((run[run.length - 1].at - run[0].at) / 60000)
      )} minutes of each other`,
      detail: `starting ${run[0].at.toISOString().replace("T", " ").replace(/\..*/, "")} UTC`,
      files: run.map((r) => r.name),
    }));
}

/* Metadata timestamps come in several shapes: EXIF's colon-separated date,
   ISO from video and PDF, and PDF's own D: prefix. */
function firstTimestamp(meta) {
  for (const label of TIME_LABELS) {
    const field = meta.fields.find((f) => f.label === label);
    if (!field) continue;
    const parsed = parseLooseDate(field.value);
    if (parsed) return parsed;
  }
  return null;
}

function parseLooseDate(value) {
  const text = String(value).trim();
  const exif = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (exif) {
    const [, y, mo, d, h, mi, s] = exif;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  const pdf = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(text);
  if (pdf) {
    const [, y, mo, d, h, mi, s] = pdf;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  return null;
}

function countFiles(files) {
  const unique = [...new Set(files)];
  return `${unique.length} file${unique.length === 1 ? "" : "s"}`;
}

/* ---------- rendering ---------- */

const linkPanel = typeof document !== "undefined" ? document.getElementById("linkPanel") : null;

function renderLinkage() {
  if (!linkPanel) return;
  const entries = [...document.querySelectorAll(".result-card")].map((card) => ({
    name: card._msFile ? card._msFile.name : "",
    meta: card._msMeta,
  }));
  const findings = computeLinkage(entries).slice(0, 6);

  if (!findings.length) {
    linkPanel.hidden = true;
    linkPanel.innerHTML = "";
    return;
  }

  const strong = findings.filter((f) => f.kind === "strong").length;
  linkPanel.hidden = false;
  linkPanel.innerHTML = `
    <h3 class="link-panel__title">${icon("st-idcard")} These files are linked to each other</h3>
    <p class="link-panel__lead">${
      strong
        ? "Even with the pictures cropped and the names changed, this is enough to prove they belong together."
        : "Softer than a serial number, but still enough to group them."
    }</p>
    <ul class="link-panel__list">
      ${findings
        .map(
          (finding) => `
        <li class="link-panel__item link-panel__item--${finding.kind}">
          <strong>${escapeHtml(finding.text)}</strong>
          <span>${escapeHtml(finding.detail)}</span>
          <span class="link-panel__files">${escapeHtml(finding.files.join(", "))}</span>
        </li>`
        )
        .join("")}
    </ul>
    <p class="link-panel__note">Cleaning every file removes what ties them together.</p>
  `;
}
