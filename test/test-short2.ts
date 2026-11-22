// Zware variant: dezelfde korte frase overal, en de tekst vlak om elke markering is gewijzigd.
// Alleen de uitlijning (positie t.o.v. unieke tekst eromheen) kan hier nog de juiste plek bepalen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfLib from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
	buildIndex,
	carryOver,
	readPages,
	type PdfDocument,
} from "../lib/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const { PDFDocument, StandardFonts, rgb, PDFHexString } = pdfLib;

const topics = [
	"fuel planning",
	"weather briefing",
	"NOTAM review",
	"taxi procedure",
	"de-icing",
	"weight and balance",
	"runway analysis",
	"passenger handling",
	"crew rest",
	"alternate selection",
	"engine start",
	"pushback",
	"cabin securing",
	"door closure",
	"ATC clearance",
	"takeoff data",
	"noise abatement",
	"MEL review",
	"catering",
	"ground power",
	"cargo loading",
	"security check",
	"APU usage",
	"brake cooling",
	"tyre pressure",
	"deviation reporting",
];
const old = topics.map(
	(t, i) =>
		`Section ${i + 1} covers ${t} in detail and lists the responsibilities of every crew member involved. Always check the Flight status board.`
);
const neu = topics.map(
	(t, i) =>
		`Section ${i + 1} covers ${t} in detail and lists the responsibilities of every crew member involved. Verify the Flight status display now.`
);

async function build(paras: string[]) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const W = 420,
		H = 595,
		M = 40,
		size = 11,
		lh = 15;
	let page = doc.addPage([W, H]);
	let y = H - M;
	for (const p of paras) {
		let line = "";
		const flush = () => {
			if (y < M + lh) {
				page = doc.addPage([W, H]);
				y = H - M;
			}
			page.drawText(line, { x: M, y, size, font, color: rgb(0, 0, 0) });
			y -= lh;
			line = "";
		};
		for (const w of p.split(" ")) {
			const t = line ? `${line} ${w}` : w;
			if (font.widthOfTextAtSize(t, size) > W - 2 * M) {
				flush();
				line = w;
			} else line = t;
		}
		if (line) flush();
		y -= 10;
	}
	return doc;
}
const open = async (b: Uint8Array) =>
	(await pdfjs.getDocument({
		data: b.slice(),
		useSystemFonts: true,
		isEvalSupported: false,
	}).promise) as PdfDocument;

const v1 = await (await build(old)).save();
const v2 = await (
	await build([
		"Nieuwe uitgave met extra inleiding.",
		...neu.slice(0, 9),
		"Nieuwe alinea over iets anders dat hier is toegevoegd.",
		...neu.slice(9, 18),
		"Nog een toegevoegde alinea.",
		...neu.slice(18),
	])
).save();

const targets = [6, 14, 21]; // sectie 7, 15, 22
const idx1 = buildIndex(await readPages(await open(v1)));
const doc = await PDFDocument.load(v1);
for (const t of targets) {
	const sec = idx1.text.indexOf(`section ${t + 1} covers`);
	const at = idx1.text.indexOf("flight", sec);
	const rects = new Map<
		string,
		{ page: number; x0: number; x1: number; y0: number; y1: number }
	>();
	for (let i = at; i < at + 6; i++) {
		const b = idx1.box[i];
		const k = `${b.page}:${Math.round(b.y0)}`;
		const r = rects.get(k) ?? {
			page: b.page,
			x0: b.x0,
			x1: b.x1,
			y0: b.y0,
			y1: b.y1,
		};
		r.x0 = Math.min(r.x0, b.x0);
		r.x1 = Math.max(r.x1, b.x1);
		rects.set(k, r);
	}
	const rs = [...rects.values()];
	doc.getPages()[rs[0].page - 1].node.addAnnot(
		doc.context.register(
			doc.context.obj({
				Type: "Annot",
				Subtype: "Highlight",
				C: [1, 0.9, 0.2],
				F: 4,
				Rect: [
					Math.min(...rs.map((r) => r.x0)),
					Math.min(...rs.map((r) => r.y0)),
					Math.max(...rs.map((r) => r.x1)),
					Math.max(...rs.map((r) => r.y1)),
				],
				QuadPoints: rs.flatMap((r) => [
					r.x0,
					r.y1,
					r.x1,
					r.y1,
					r.x0,
					r.y0,
					r.x1,
					r.y0,
				]),
				Contents: PDFHexString.fromText(`sectie ${t + 1}`),
			})
		)
	);
}
const v1a = await doc.save();
fs.writeFileSync(path.join(outDir, "short2-v1.pdf"), v1a);
fs.writeFileSync(path.join(outDir, "short2-v2.pdf"), v2);

const res = await carryOver({
	oldDoc: await open(v1a),
	newDoc: await open(v2),
	newBytes: v2,
	pdfLib,
	write: false,
});
const idx2 = res.index!;
let failed = 0;
for (const r of res.results) {
	const n = Number(r.contents.replace("sectie ", ""));
	const m = r.match;
	// de markering hoort in sectie n te staan: de laatste "section N covers" vóór de match
	let sec = -1;
	if (m) {
		const re = /section (\d+) covers/g;
		let x: RegExpExecArray | null;
		while ((x = re.exec(idx2.text)) && x.index < m[0]) sec = Number(x[1]);
	}
	const ok = sec === n;
	console.log(
		`${ok ? "OK  " : "FAIL"} sectie ${n}: ${r.status}, gevonden in sectie ${sec}, alternatieven: ${r.alternatives.length}`
	);
	if (!ok) failed++;
}
if (failed) {
	console.error(`${failed} fout(en)`);
	process.exit(1);
}
console.log("Korte markeringen (zware variant): alles geslaagd");
