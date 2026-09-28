/* The camera: loads stage.html in headless Chrome and photographs it.

     node camera.mjs proof 1.2 7.5 ...   single frames into proofs/, for review
     node camera.mjs roll [from] [to]     every frame into frames/

   Each frame is stage.draw(t) followed by a screenshot, so a frame depends on
   its time and nothing else: no clock, no animation loop, no randomness that is
   not seeded. Rolling the same range twice gives the same pictures. */
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const beats = JSON.parse(fs.readFileSync("beats.json", "utf8"));
fs.writeFileSync("stage.built.html", fs.readFileSync("stage.html", "utf8").replace("BEATS_JSON", JSON.stringify(beats)));

const [mode = "roll", ...rest] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  // file access so the stage can read ../assets and ../js straight from the repo
  args: ["--allow-file-access-from-files", "--hide-scrollbars", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("STAGE ERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("STAGE", m.text()); });
await page.goto("file://" + process.cwd() + "/stage.built.html", { waitUntil: "networkidle0" });
await page.evaluate(() => window.stageReady);

const shoot = async (t, file) => {
  await page.evaluate((t) => window.draw(t), t);
  await page.screenshot({ path: file, type: "jpeg", quality: 95 });
};

if (mode === "proof") {
  fs.mkdirSync("proofs", { recursive: true });
  for (const f of fs.readdirSync("proofs")) fs.unlinkSync("proofs/" + f);
  for (const [i, t] of rest.map(Number).entries()) await shoot(t, `proofs/${String(i).padStart(2, "0")}_${t.toFixed(2)}s.jpg`);
} else {
  const total = Math.round(beats.duration * beats.fps);
  const from = +(rest[0] ?? 0), to = +(rest[1] ?? total);
  fs.mkdirSync("frames", { recursive: true });
  for (let f = from; f < to; f++) {
    await shoot(f / beats.fps, `frames/${String(f).padStart(5, "0")}.jpg`);
    if (f % 150 === 0) console.log(`frame ${f}/${total}`);
  }
}
await browser.close();
