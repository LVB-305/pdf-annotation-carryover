// Maakt een tweede testpaar waarin dezelfde zin op meerdere plaatsen staat, zodat de matching
// niet kan kiezen (status "dubbelzinnig") en het reviewscherm alternatieven moet tonen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildIndex, readPages, type PdfDocument } from '../lib/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const { PDFDocument, StandardFonts, rgb, PDFHexString } = pdfLib;

const same = 'Controleer vóór elke vlucht of alle instrumenten werken en meld afwijkingen direct aan de operationele dienst van de maatschappij.';

async function build(paras: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const W = 420, H = 595, M = 40, size = 11, lh = 15;
  let page = doc.addPage([W, H]);
  let y = H - M;
  for (const p of paras) {
    let line = '';
    const flush = () => {
      if (y < M + lh) { page = doc.addPage([W, H]); y = H - M; }
      page.drawText(line, { x: M, y, size, font, color: rgb(0, 0, 0) });
      y -= lh; line = '';
    };
    for (const w of p.split(' ')) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) > W - 2 * M) { flush(); line = w; } else line = t;
    }
    if (line) flush();
    y -= 10;
  }
  return doc;
}

const v1 = await (await build(Array.from({ length: 10 }, () => same))).save();
const v2 = await (await build(['Nieuwe inleiding bij deze uitgave.', ...Array.from({ length: 12 }, () => same)])).save();

// markeer de zin in de 6e alinea van v1 (roze)
const open = async (b: Uint8Array) =>
  (await pdfjs.getDocument({ data: b.slice(), useSystemFonts: true, isEvalSupported: false }).promise) as PdfDocument;
const idx = buildIndex(await readPages(await open(v1)));
const doc = await PDFDocument.load(v1);
const needle = 'meld afwijkingen direct aan de operationele dienst';
let at = -1;
for (let k = 0; k < 6; k++) at = idx.text.indexOf(needle, at + 1);
const rects = new Map<string, { page: number; x0: number; x1: number; y0: number; y1: number }>();
for (let i = at; i < at + needle.length; i++) {
  const b = idx.box[i];
  const key = `${b.page}:${Math.round(b.y0)}`;
  const r = rects.get(key) ?? { page: b.page, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
  r.x0 = Math.min(r.x0, b.x0); r.x1 = Math.max(r.x1, b.x1);
  rects.set(key, r);
}
const rs = [...rects.values()];
doc.getPages()[rs[0].page - 1].node.addAnnot(doc.context.register(doc.context.obj({
  Type: 'Annot', Subtype: 'Highlight', C: [1, 0.55, 0.75], F: 4,
  Rect: [Math.min(...rs.map((r) => r.x0)), Math.min(...rs.map((r) => r.y0)), Math.max(...rs.map((r) => r.x1)), Math.max(...rs.map((r) => r.y1))],
  QuadPoints: rs.flatMap((r) => [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0]),
  Contents: PDFHexString.fromText('Welke alinea was dit?'),
})));

fs.writeFileSync(path.join(outDir, 'amb-v1.pdf'), await doc.save());
fs.writeFileSync(path.join(outDir, 'amb-v2.pdf'), v2);
console.log('amb-v1.pdf en amb-v2.pdf geschreven');
