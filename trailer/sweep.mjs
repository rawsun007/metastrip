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

// The reader also reports the stream's own structure. Every video has a
// duration, a frame size and a codec, and none of them can be taken out
// without taking out the video, so they are shown but not counted. It files
// the codec under "device"; for a film rendered in a browser and encoded
// with x264 it names the encoder software, not anybody's camera.
const STRUCTURE = new Set(["Duration", "Frame size", "Video codec", "Audio codec"]);
const fields = meta.fields || [];
const telling = fields.filter((f) => !STRUCTURE.has(f.label));
for (const f of fields) console.log(`${telling.includes(f) ? "LEAK " : "     "} ${f.label}: ${f.value}  [${f.risk}]`);
if (meta.gps) console.log(`LEAK  GPS: ${meta.gps.lat}, ${meta.gps.lon}`);
const n = telling.length + (meta.gps ? 1 : 0);
console.log(n === 0 ? `clean: MetaStrip finds nothing in ${path.basename(file)}` : `${n} leak(s) in ${path.basename(file)}`);
process.exit(n === 0 ? 0 : 1);
