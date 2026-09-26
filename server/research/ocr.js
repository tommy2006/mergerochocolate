// OCR for scanned statement PDFs, entirely on this machine: poppler's pdftoppm renders the pages, tesseract reads them.
// Keeps the data-sovereignty promise: no document leaves the server, the text then goes to the Verda-hosted model.
// Debian/Ubuntu: apt-get install tesseract-ocr tesseract-ocr-nor tesseract-ocr-fin tesseract-ocr-swe tesseract-ocr-dan poppler-utils
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LANGS = { NO: ["nor", "eng"], FI: ["fin", "eng"], SE: ["swe", "eng"], DK: ["dan", "eng"], DE: ["deu", "eng"], AT: ["deu", "eng"], CH: ["deu", "eng"] };
let avail = null;

function probe(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout || ""}${r.stderr || ""}`.trim();
  } catch { return null; }
}

export function ocrAvailable({ force = false } = {}) {
  if (avail && !force) return avail;
  const pdftoppm = probe("pdftoppm", ["-v"]);
  const tesseract = probe("tesseract", ["--version"]);
  const langs = tesseract ? (probe("tesseract", ["--list-langs"]) || "").split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]{3,}$/.test(l)) : [];
  avail = {
    ok: Boolean(pdftoppm && tesseract),
    tesseract: tesseract ? tesseract.split("\n")[0] : null, pdftoppm: pdftoppm ? pdftoppm.split("\n")[0] : null, langs,
    reason: !tesseract ? "tesseract is not installed (apt-get install tesseract-ocr tesseract-ocr-nor poppler-utils)" : !pdftoppm ? "pdftoppm (poppler-utils) is not installed" : "",
  };
  return avail;
}

// Language models for a country, limited to what tesseract has; English is always a fallback.
export function langsFor(country) {
  const have = new Set(ocrAvailable().langs);
  const want = LANGS[String(country || "").toUpperCase()] || ["eng"];
  const picked = want.filter((l) => have.has(l));
  return (picked.length ? picked : have.has("eng") ? ["eng"] : [...have].slice(0, 1)).join("+") || "eng";
}

const run = (cmd, args, { timeoutMs = 120000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", (e) => { clearTimeout(t); reject(e); });
  child.on("close", (code) => { clearTimeout(t); if (code === 0) resolve(out); else reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 200)}`)); });
});

// Renders up to maxPages at `dpi` and reads them `concurrency` at a time. Returns page texts joined with form feeds,
// the same shape pdfText() gives, so statementWindow() can pick the income-statement pages.
export async function ocrPdf(buffer, { country, langs, maxPages = 40, dpi = 170, concurrency = 4, log = () => {} } = {}) {
  const a = ocrAvailable();
  if (!a.ok) throw new Error(a.reason);
  const lang = langs || langsFor(country);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mergero-ocr-"));
  const t0 = Date.now();
  try {
    const pdf = path.join(dir, "in.pdf");
    await fs.writeFile(pdf, buffer);
    await run("pdftoppm", ["-r", String(dpi), "-gray", "-png", "-f", "1", "-l", String(maxPages), pdf, path.join(dir, "p")], { timeoutMs: 180000 });
    const files = (await fs.readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort((x, y) => Number(x.match(/\d+/)[0]) - Number(y.match(/\d+/)[0]));
    const texts = new Array(files.length).fill("");
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (next < files.length) {
        const k = next++;
        texts[k] = await run("tesseract", [path.join(dir, files[k]), "stdout", "-l", lang, "--psm", "6"], { timeoutMs: 120000 })
          .catch((e) => { log(`ocr page ${k + 1}: ${e.message}`); return ""; });
      }
    }));
    const text = texts.map((t) => t.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()).join("\n\f\n");
    log(`ocr: ${files.length} page(s), ${lang}, ${text.length} chars in ${Math.round((Date.now() - t0) / 1000)} s`);
    return { pages: files.length, lang, text, ms: Date.now() - t0 };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
