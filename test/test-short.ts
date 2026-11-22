// Korte markeringen ("Flight") die vaak voorkomen: de context vóór/na moet de juiste plaats bepalen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildIndex, carryOver, readPages, type PdfDocument } from '../lib/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const { PDFDocument, StandardFonts, rgb, PDFHexString } = pdfLib;

const sentences = [
  'The Flight crew must complete the briefing before engine start.',
  'Each Flight plan is checked against the latest weather report.',
  'In-Flight entertainment systems are disabled during takeoff and landing.',
  'During Flight the captain monitors fuel consumption every ten minutes.',
  'The Flight deck door remains locked for the whole sector.',
  'Report any Flight delay longer than thirty minutes to operations.',
  'A Flight log entry is required after every landing.',
  'Flights to remote airports need an extra alternate.',
  'The Flight manager approves deviations from the standard route.',
  'Cancel the Flight when the runway state is below minimum.',
];

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

const open = async (b: Uint8Array) =>
  (await pdfjs.getDocument({ data: b.slice(), useSystemFonts: true, isEvalSupported: false }).promise) as PdfDocument;

const v1 = await (await build(sentences)).save();
// v2: volgorde omgekeerd (positie helpt niet meer), nieuwe alinea's, en kleine woordwijzigingen naast de markeringen
const changed = sentences.map((s) => s.replace('must complete', 'has to complete').replace('Report any', 'Always report any'));
const v2 = await (await build(['Nieuwe uitgave. Alle Flight procedures zijn herzien.', ...[...changed].reverse(), 'Slotopmerking over Flight en Flights.'])).save();

// markeer "Flight" in zinnen 1 (index 0), 4 (index 3), 6 (index 5), 10 (index 9); let op: zin 3 heeft "In-Flight" (index 2)
const targets = [0, 3, 5, 9];
const idx1 = buildIndex(await readPages(await open(v1)));
const doc = await PDFDocument.load(v1);
const found: number[] = [];
for (const t of targets) {
  const key = sentences[t].replace(/[’]/g, "'").toLowerCase();
  const ctxStart = idx1.text.indexOf(key.slice(0, 30));
  if (ctxStart < 0) throw new Error('zin niet gevonden: ' + sentences[t]);
  const at = idx1.text.indexOf('flight', ctxStart);
  found.push(at);
  const rects = new Map<string, { page: number; x0: number; x1: number; y0: number; y1: number }>();
  for (let i = at; i < at + 6; i++) {
    const b = idx1.box[i];
    const k = `${b.page}:${Math.round(b.y0)}`;
    const r = rects.get(k) ?? { page: b.page, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
    r.x0 = Math.min(r.x0, b.x0); r.x1 = Math.max(r.x1, b.x1);
    rects.set(k, r);
  }
  const rs = [...rects.values()];
  doc.getPages()[rs[0].page - 1].node.addAnnot(doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Highlight', C: [1, 0.9, 0.2], F: 4,
    Rect: [Math.min(...rs.map((r) => r.x0)), Math.min(...rs.map((r) => r.y0)), Math.max(...rs.map((r) => r.x1)), Math.max(...rs.map((r) => r.y1))],
    QuadPoints: rs.flatMap((r) => [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0]),
    Contents: PDFHexString.fromText(`zin ${t + 1}`),
  })));
}
const v1a = await doc.save();
fs.writeFileSync(path.join(outDir, 'short-v1.pdf'), v1a);
fs.writeFileSync(path.join(outDir, 'short-v2.pdf'), v2);

const res = await carryOver({ oldDoc: await open(v1a), newDoc: await open(v2), newBytes: v2, pdfLib, write: false });
const idx2 = res.index!;
let failed = 0;
for (const r of res.results) {
  const t = Number(r.contents.replace('zin ', '')) - 1;
  const m = r.match;
  const around = m ? idx2.text.slice(Math.max(0, m[0] - 12), m[1] + 22) : '(geen)';
  const expectedFrag = changed[t].replace(/[’]/g, "'").toLowerCase().split('flight')[0].slice(-12) + 'flight';
  const ok = !!m && idx2.text.slice(m[0] - 12, m[1]).includes(expectedFrag.slice(-14)) || (!!m && around.includes(expectedFrag.slice(-10)));
  console.log(`${ok ? 'OK  ' : 'FAIL'} zin ${t + 1}: ${r.status} → "${around}"`);
  if (!ok) failed++;
}
if (failed) { console.error(`${failed} fout(en)`); process.exit(1); }
console.log('Korte markeringen: alles geslaagd');
