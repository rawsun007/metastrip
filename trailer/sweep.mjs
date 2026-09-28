/* sweep.mjs: what does MetaStrip itself find in a video?

     node sweep.mjs reel/untracked.mp4

   Loads the site's own readers from ../js into a VM context, the way
   tests/run.mjs does, and runs parseVideoMetadata() over the file. A trailer
   about hidden metadata should carry none, so bake.sh fails if this finds
   anything that says who made the file, where, when, or with what. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const JS_DIR = path.join(import.meta.dirname, "..", "js");
const ctx = vm.createContext({ console, File, Blob, DataView, Uint8Array, TextDecoder, TextEncoder });
for (const name of ["score.js", "aitags.js", "c2pa.js", "edits.js", "exif.js", "stripper.js", "video.js"]) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, name), "utf8"), ctx, { filename: name });
}
const file = process.argv[2];
const bytes = fs.readFileSync(file);
ctx.__file = new File([bytes], path.basename(file), { type: "video/mp4" });
const meta = await vm.runInContext("parseVideoMetadata(__file)", ctx);

// Judged the way the site judges it, with score.js rather than a rule of
// our own: scoreMeta() is the badge a visitor would see, and countRemovable()
// is what a strip would take out. Duration, frame size and codec are shown
// but are not removable, so the site never counts them, and neither does this.
const fields = meta.fields || [];
const badge = vm.runInContext("scoreMeta", ctx)(meta).label;
const removable = vm.runInContext("countRemovable", ctx)(meta);
const isRemovable = vm.runInContext("isRemovableField", ctx);
for (const f of fields) console.log(`${isRemovable(f) ? "LEAK " : "     "} ${f.label}: ${f.value}  [${f.risk}]`);
if (meta.gps) console.log(`LEAK  GPS: ${meta.gps.lat}, ${meta.gps.lon}`);
const n = removable;
console.log(`badge ${badge}, ${removable} removable`);
console.log(n === 0 && badge === "CLEAN" ? `clean: MetaStrip finds nothing to strip in ${path.basename(file)}` : `${n} removable in ${path.basename(file)}`);
process.exit(n === 0 && badge === "CLEAN" ? 0 : 1);
