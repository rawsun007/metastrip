/* MetaStrip — deciding what a badge should say.

   The badge is a claim about risk, not an inventory. Three states, and the
   line between them matters more than it looks:

     LEAKING  coordinates are in the file
     RISKY    something in here points at you or your device
     CLEAN    nothing readable that does

   The trap is treating "removable" and "risky" as the same thing. A file
   whose only metadata is the name of the muxer that wrote it is not risky in
   any sense a person cares about. Lavf62.3.100 says a version of ffmpeg
   touched the file. It does not say who you are, what you shot it on, when,
   or where. Badging that RISKY next to a photo carrying your home address
   makes the badge meaningless, and a privacy tool that cries wolf teaches
   people to ignore it.

   So tool strings are their own tier. Still listed, still removable, still
   ticked by default. Just not a reason to raise an alarm. */

/* Fields that can actually be taken out of the file. Duration, frame size
   and codec come from boxes every player needs, so they are shown but never
   offered for removal and never scored. */
function isRemovableField(field) {
  return Boolean(field.ranges || field.chunkRange || field.chunkRanges || (field.edits && field.edits.length));
}

/* "Some software touched this file" is the weakest thing metadata can say.
   It is worth removing and not worth an alarm. */
function isTrivia(field) {
  return field.risk === "trivia";
}

function isScoredField(field) {
  return isRemovableField(field) && !isTrivia(field);
}

/** The badge for a parsed file. */
function scoreMeta(meta) {
  if (meta.gps) return { label: "LEAKING", cls: "score-badge--leak" };
  if ((meta.fields || []).some(isScoredField)) return { label: "RISKY", cls: "score-badge--risky" };
  return { label: "CLEAN", cls: "score-badge--clean" };
}

/** How many things a strip would actually take out, alarming or not. */
function countRemovable(meta) {
  return (meta.fields || []).filter(isRemovableField).length + (meta.gps ? 1 : 0);
}

/* A file that scores CLEAN can still have a tool string in it, and saying
   "nothing in here" when there is visibly a row on screen reads as a lie. */
function describeCleanState(meta) {
  const trivia = (meta.fields || []).filter((f) => isTrivia(f) && isRemovableField(f));
  if (!trivia.length) return null;
  const names = trivia.map((f) => f.label.toLowerCase());
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Nothing in here points at you. The ${list} ${names.length === 1 ? "is" : "are"} still listed, and still goes when you strip it.`;
}
