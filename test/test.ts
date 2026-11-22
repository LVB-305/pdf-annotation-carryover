// Eindtest in Node: maakt een "oude" PDF met annotaties (op dezelfde manier als iOS Markup: geen
// appearance stream, platte QuadPoints) en een "nieuwe" versie met verschoven en gewijzigde tekst.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfLib from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
	buildIndex,
	buildReport,
	carryOver,
	readAnnotations,
	readPages,
	summarize,
	writeAnnotations,
	type PdfDocument,
} from "../lib/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });

const { PDFDocument, StandardFonts, rgb, PDFHexString } = pdfLib;

/* ---------- testdocumenten ---------- */

const topics = [
	"de brandstofplanning",
	"de gewichtsberekening",
	"de weerbriefing",
	"de NOTAM-controle",
	"de taxiprocedure",
	"de afhandeling van de passagiersdocumenten",
	"de controle van de minimale uitrusting",
	"de de-icing procedure",
];

function para(i: number): string {
	const t = topics[i % topics.length];
	let s =
		`Sectie ${i + 1}. Voor ${t} geldt dat de bemanning minimaal ${10 + i} minuten voor vertrek alle gegevens controleert en onderling bevestigt. ` +
		`Afwijkingen worden onmiddellijk gemeld aan de operationele dienst, waarna ${t} opnieuw wordt uitgevoerd volgens de laatste revisie van het handboek. `;
	if (i === 2)
		s +=
			"Het noodprotocol voor het uitvallen van beide radio’s staat beschreven in bijlage C. ";
	if (i === 6)
		s +=
			"Vlucht­begeleiders melden elke afwijking aan de captain vóór het sluiten van de deuren. ";
	s += `Bij twijfel geldt altijd de strengste interpretatie van de procedure nummer ${100 + i}.`;
	return s;
}

async function buildPdf(paragraphs: string[]): Promise<pdfLib.PDFDocument> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const W = 420,
		H = 595,
		M = 40,
		size = 11,
		lh = 15;
	let page = doc.addPage([W, H]);
	let y = H - M;
	for (const p of paragraphs) {
		const words = p.split(" ");
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
		for (const w of words) {
			const t = line ? `${line} ${w}` : w;
			if (font.widthOfTextAtSize(t, size) > W - 2 * M) {
				flush();
				line = w;
			} else line = t;
		}
		if (line) flush();
		y -= 8;
	}
	return doc;
}

const v1Paras = Array.from({ length: 24 }, (_, i) => para(i));
const INS = 8;
const v2Paras = [
	...Array.from(
		{ length: INS },
		(_, k) =>
			`Revisie-opmerking ${k + 1}. Deze uitgave vervangt alle eerdere uitgaven en is van kracht vanaf de eerste dag van de volgende roosterperiode, zie ook de wijzigingslijst onder punt ${k + 1}.`
	),
	...v1Paras,
];
// A2: wijziging in sectie 6
v2Paras[5 + INS] = v2Paras[5 + INS].replace(
	"minimaal 15 minuten",
	"minimaal 25 minuten"
);
// A3: noodprotocol-zin verwijderd uit sectie 3
v2Paras[2 + INS] = v2Paras[2 + INS].replace(
	"Het noodprotocol voor het uitvallen van beide radio’s staat beschreven in bijlage C. ",
	""
);

/* ---------- pdf.js helpers ---------- */

const open = async (bytes: Uint8Array): Promise<PdfDocument> =>
	(await pdfjs.getDocument({
		data: bytes.slice(),
		useSystemFonts: true,
		isEvalSupported: false,
	}).promise) as PdfDocument;

/* ---------- annotaties in v1 zetten ---------- */

const norm = (s: string): string =>
	s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'");

interface LineRect {
	page: number;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

async function annotateV1(bytes: Uint8Array): Promise<Uint8Array> {
	const idx = buildIndex(await readPages(await open(bytes)));
	const doc = await PDFDocument.load(bytes);
	const ctx = doc.context;
	const pages = doc.getPages();

	const rectsAt = (s: number, e: number): LineRect[] => {
		const byLine = new Map<string, LineRect>();
		for (let i = s; i < e; i++) {
			const b = idx.box[i];
			const key = `${b.page}:${Math.round(b.y0)}`;
			const r = byLine.get(key) ?? {
				page: b.page,
				x0: b.x0,
				x1: b.x1,
				y0: b.y0,
				y1: b.y1,
			};
			r.x0 = Math.min(r.x0, b.x0);
			r.x1 = Math.max(r.x1, b.x1);
			byLine.set(key, r);
		}
		return [...byLine.values()];
	};

	const addHighlight = (rs: LineRect[], color: number[], note?: string) => {
		const page = pages[rs[0].page - 1];
		const quads = rs.flatMap((r) => [
			r.x0,
			r.y1,
			r.x1,
			r.y1,
			r.x0,
			r.y0,
			r.x1,
			r.y0,
		]);
		const rect = [
			Math.min(...rs.map((r) => r.x0)),
			Math.min(...rs.map((r) => r.y0)),
			Math.max(...rs.map((r) => r.x1)),
			Math.max(...rs.map((r) => r.y1)),
		];
		const d = ctx.obj({
			Type: "Annot",
			Subtype: "Highlight",
			Rect: rect,
			QuadPoints: quads,
			C: color,
			F: 4,
			...(note ? { Contents: PDFHexString.fromText(note) } : {}),
		});
		page.node.addAnnot(ctx.register(d));
	};

	const highlight = (phrase: string, note?: string, color = [1, 0.9, 0]) => {
		const p = norm(phrase);
		const s = idx.text.indexOf(p);
		if (s < 0) throw new Error(`frase ontbreekt in v1: ${phrase}`);
		addHighlight(rectsAt(s, s + p.length), color, note);
	};

	// A1: unieke zin, verschuift naar een andere pagina
	highlight(
		"Bij twijfel geldt altijd de strengste interpretatie van de procedure nummer 113",
		"Belangrijk: strengste interpretatie"
	);
	// A2: wijziging van 15 -> 25 minuten
	highlight(
		"de bemanning minimaal 15 minuten voor vertrek alle gegevens controleert"
	);
	// A3: verwijderde zin
	highlight(
		"Het noodprotocol voor het uitvallen van beide radio’s staat beschreven in bijlage C.",
		"Leren!"
	);
	// A4: herhaalde zin in sectie 10: context en uitlijning moeten de juiste plek kiezen
	{
		const s10 = idx.text.indexOf("sectie 10.");
		const rep =
			"afwijkingen worden onmiddellijk gemeld aan de operationele dienst";
		const at = idx.text.indexOf(rep, s10);
		addHighlight(rectsAt(at, at + rep.length), [0.6, 1, 0.6]);
	}
	// A5: woord met zacht koppelteken in sectie 7
	highlight(
		"begeleiders melden elke afwijking aan de captain vóór het sluiten van de deuren",
		"woord met koppelteken"
	);
	// A6: sticky note naast sectie 12
	{
		const s = idx.text.indexOf("sectie 12.");
		const b = idx.box[s];
		pages[b.page - 1].node.addAnnot(
			ctx.register(
				ctx.obj({
					Type: "Annot",
					Subtype: "Text",
					Rect: [8, b.y0 - 4, 28, b.y0 + 16],
					Contents: PDFHexString.fromText("Nakijken met instructeur"),
					Name: "Comment",
					C: [1, 0.8, 0],
					F: 28,
				})
			)
		);
	}
	// A7: tekenwerk (niet ondersteund)
	pages[0].node.addAnnot(
		ctx.register(
			ctx.obj({
				Type: "Annot",
				Subtype: "Ink",
				Rect: [50, 50, 150, 100],
				InkList: [[50, 50, 100, 100, 150, 60]],
				C: [1, 0, 0],
				F: 4,
			})
		)
	);

	return doc.save();
}

/* ---------- uitvoeren ---------- */

const v1Plain = await (await buildPdf(v1Paras)).save();
const v1 = await annotateV1(v1Plain);
const v2 = await (await buildPdf(v2Paras)).save();
fs.writeFileSync(path.join(outDir, "v1-annotated.pdf"), v1);
fs.writeFileSync(path.join(outDir, "v2-plain.pdf"), v2);

const oldDoc = await open(v1);
const newDoc = await open(v2);
const t0 = Date.now();
const res = await carryOver({ oldDoc, newDoc, newBytes: v2, pdfLib });
const ms = Date.now() - t0;
if (!res.bytes) throw new Error("geen uitvoer");
fs.writeFileSync(path.join(outDir, "v2-annotated.pdf"), res.bytes);
fs.writeFileSync(
	path.join(outDir, "rapport.md"),
	buildReport(res.results, { oldName: "v1.pdf", newName: "v2.pdf" })
);

console.log(`Verwerkt in ${ms} ms:`, summarize(res.results));
for (const r of res.results) {
	console.log(
		` - ${r.id.padEnd(6)} ${r.kind.padEnd(9)} ${r.status.padEnd(11)} p${r.page}->${r.newPage ?? "-"}  ${r.text.slice(0, 60)}`
	);
}

/* ---------- controles ---------- */

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
	console.log(`${ok ? "OK  " : "FAIL"} ${name} ${extra}`);
	if (!ok) failed++;
};

// lees het resultaat opnieuw in en kijk waar de annotaties echt terechtkomen
const outDoc = await open(res.bytes);
const outIdx = buildIndex(await readPages(outDoc));
const outAnn = await readAnnotations(outDoc, outIdx);
const from = (a: { range: [number, number] | null }) => a.range?.[0] ?? -1;
const sec = (n: number) => outIdx.text.indexOf(`sectie ${n}.`);

const A1 = res.results.find((r) => r.text.includes("procedure nummer 113"))!;
check("A1 exact", A1.status === "exact", `p${A1.page}->p${A1.newPage}`);
check(
	"A1 landt op de juiste tekst",
	outAnn.some((a) => a.text.includes("procedure nummer 113"))
);
check(
	"A1 notitie bewaard",
	outAnn.some(
		(a) =>
			a.text.includes("procedure nummer 113") &&
			a.contents.includes("strengste interpretatie")
	)
);

const A2 = res.results.find((r) => r.text.includes("minimaal 15 minuten"))!;
check(
	"A2 fuzzy (gewijzigd getal)",
	A2.status === "fuzzy",
	`score ${A2.score.toFixed(2)}`
);
check(
	"A2 landt in sectie 6 met nieuwe tekst",
	outAnn.some(
		(a) =>
			a.text.includes("minimaal 25 minuten") &&
			from(a) > sec(6) &&
			from(a) < sec(7)
	)
);
check(
	"A2 warning in note",
	outAnn.some(
		(a) =>
			a.text.includes("minimaal 25 minuten") && a.contents.includes("changed")
	)
);

const A3 = res.results.find((r) => r.text.includes("noodprotocol"))!;
check(
	"A3 niet gevonden (zin verwijderd)",
	A3.status === "notfound",
	`status ${A3.status}`
);

const A4 = res.results.find((r) => r.text.startsWith("afwijkingen worden"))!;
check(
	"A4 herhaalde zin: juiste sectie",
	A4.status !== "notfound" &&
		outAnn.some(
			(a) =>
				a.text.startsWith("afwijkingen worden") &&
				from(a) > sec(10) &&
				from(a) < sec(11)
		),
	`status ${A4.status}`
);

const close = (c: number[] | null, want: number[]) =>
	!!c && c.every((v, i) => Math.abs(v - want[i]) < 0.01);
const outA1 = outAnn.find((a) => a.text.includes("procedure nummer 113"));
check(
	"Kleur A1 (geel) behouden",
	close(outA1?.color ?? null, [1, 0.9, 0]),
	JSON.stringify(outA1?.color)
);
const outA4 = outAnn.find(
	(a) =>
		a.text.startsWith("afwijkingen worden") &&
		from(a) > sec(10) &&
		from(a) < sec(11)
);
check(
	"Kleur A4 (groen) behouden",
	close(outA4?.color ?? null, [0.6, 1, 0.6]),
	JSON.stringify(outA4?.color)
);
const outA2 = outAnn.find((a) => a.text.includes("minimaal 25 minuten"));
check(
	"Kleur A2 (fuzzy) behouden",
	close(outA2?.color ?? null, [1, 0.9, 0]),
	JSON.stringify(outA2?.color)
);

const A5 = res.results.find((r) => r.text.includes("melden elke afwijking"))!;
check(
	"A5 afgebroken woord gevonden",
	A5.status === "exact" || A5.status === "fuzzy",
	`status ${A5.status}`
);

const A6 = res.results.find((r) => r.kind === "note")!;
check("A6 notitie overgezet", !!A6.newPos && A6.status !== "notfound");
const noteOut = outAnn.find(
	(a) => a.kind === "note" && a.contents.includes("instructeur")
);
check(
	"A6 notitie staat bij sectie 12",
	!!noteOut && /sectie 1[123]/.test(noteOut.text),
	noteOut?.text ?? ""
);

const A7 = res.results.find((r) => r.subtype === "Ink")!;
check("A7 tekenwerk als niet ondersteund gemeld", A7.status === "unsupported");

/* ---------- reviewbeslissingen ---------- */

check(
	"Posities voor de viewer aanwezig",
	A2.oldRects.length > 0 && A2.newRects.length > 0,
	`${A2.oldRects.length} oud / ${A2.newRects.length} nieuw`
);
check(
	"Verwachte pagina ingevuld (ook bij niet gevonden)",
	typeof A3.expectedPage === "number",
	`p${A3.expectedPage}`
);

async function annotationsAfter(decision: "approved" | "rejected" | undefined) {
	const rec = res.results.map((r) => (r === A2 ? { ...r, decision } : r));
	const bytes = await writeAnnotations(
		pdfLib,
		v2,
		res.index!,
		rec,
		res.options
	);
	const doc = await open(bytes);
	const idx2 = buildIndex(await readPages(doc));
	return readAnnotations(doc, idx2);
}
const rejectedOut = await annotationsAfter("rejected");
check(
	"Geweigerde annotatie wordt niet geschreven",
	!rejectedOut.some((a) => a.text.includes("minimaal 25 minuten"))
);
const approvedOut = await annotationsAfter("approved");
const approvedA2 = approvedOut.find((a) =>
	a.text.includes("minimaal 25 minuten")
);
check(
	"Goedgekeurde annotatie staat erin zonder ⚠",
	!!approvedA2 && !approvedA2.contents.includes("⚠"),
	JSON.stringify(approvedA2?.contents)
);
const pendingOut = await annotationsAfter(undefined);
check(
	"Niet-beoordeelde annotatie staat erin met ⚠",
	pendingOut.some(
		(a) => a.text.includes("minimaal 25 minuten") && a.contents.includes("⚠")
	)
);

if (failed) {
	console.error(`\n${failed} controle(s) mislukt`);
	process.exit(1);
}
console.log("\nAlle controles geslaagd. Uitvoer: test/out/");
