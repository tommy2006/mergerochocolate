// Text layer of a PDF (filed statements, annual reports) without a browser: pdf.js legacy build, text content only.
// Scanned PDFs have no text layer; the caller falls back to Claude's document reader for those.
let pdfjsMod = null;
const pdfjs = async () => pdfjsMod || (pdfjsMod = await import("pdfjs-dist/legacy/build/pdf.mjs"));
const PAGE_BREAK = "\n\f\n";

export async function pdfText(buffer, { maxPages = 60 } = {}) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      pages.push(c.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim());
      page.cleanup();
    }
    return { pages: doc.numPages, read: pages.length, text: pages.join(PAGE_BREAK) };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// The pages a model needs to read an income statement: those mentioning P&L terms (Nordic languages, German, English)
// first, the rest only while the budget allows. Keeps page order.
const PL_TERMS = /(resultatregnskap|driftsresultat|avskrivning|tuloslaskelma|liikevoitto|poistot|resultaträkning|rörelseresultat|avskrivningar|resultatopgørelse|afskrivning|gewinn- und verlust|abschreibung|income statement|operating (?:profit|result)|depreciation|ebitda)/gi;
export function statementWindow(text, { maxChars = 28000 } = {}) {
  const pages = String(text || "").split(PAGE_BREAK).map((p, i) => ({ i, p, hits: (p.match(PL_TERMS) || []).length }));
  const ranked = [...pages].sort((a, b) => b.hits - a.hits || a.i - b.i);
  const keep = [];
  let size = 0;
  for (const x of ranked) {
    if (!x.p || size + x.p.length > maxChars) continue;
    keep.push(x);
    size += x.p.length;
  }
  return keep.sort((a, b) => a.i - b.i).map((x) => `--- page ${x.i + 1} ---\n${x.p}`).join("\n\n");
}
