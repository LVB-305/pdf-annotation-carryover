/**
 * core.ts — core logic for transferring PDF annotations to a new version.
 *
 * No DOM or Next.js dependencies. pdf.js documents (for reading) and pdf-lib (for writing)
 * are supplied externally, so this module can run in a PWA, in Node, or later in a
 * React Native/native shell.
 *
 * Approach: annotations in a PDF are tied to page positions, which break when the
 * layout shifts. Instead, we associate each annotation with TEXT (+ surrounding context),
 * find that text in the new version, and recreate the annotation there.
 */
import type { PDFDocument, PDFPage } from "pdf-lib";

export type PdfLib = typeof import("pdf-lib");

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Minimal structural typing for the parts of pdf.js we use. */
export interface PdfTextItem {
	str?: unknown;
	transform?: number[];
	width?: number;
	height?: number;
	hasEOL?: boolean;
	fontName?: string;
}

export interface PdfAnnotationData {
	subtype: string;
	rect?: number[];
	quadPoints?: unknown;
	color?: ArrayLike<number> | null;
	opacity?: number;
	contents?: string;
	contentsObj?: { str?: string } | null;
}

export interface PdfPageLike {
	view: number[];
	getTextContent(): Promise<{
		items: PdfTextItem[];
		styles?: Record<string, { fontFamily?: string }>;
	}>;
	getAnnotations(params?: { intent?: string }): Promise<PdfAnnotationData[]>;
}

export interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageLike>;
}

export type Kind =
	| "highlight"
	| "underline"
	| "strikeout"
	| "note"
	| "freetext"
	| "other";
export type Status =
	| "exact"
	| "fuzzy"
	| "ambiguous"
	| "notfound"
	| "unsupported";

export interface Options {
	/** Minimum similarity (0..1) for a fuzzy match. */
	minSimilarity: number;
	/** Mark locations with changed/ambiguous text with ⚠ in the note. */
	flagChanged: boolean;
	/** Author to use for annotations. */
	author: string;
}

export interface AnnotationRecord {
	id: string;
	/** Page in the old PDF. */
	page: number;
	oldNumPages: number;
	subtype: string;
	kind: Kind;
	contents: string;
	color: number[] | null;
	opacity: number;
	/** Normalized anchor text and context in the old PDF. */
	text: string;
	before: string;
	after: string;
	status: Status;
	reason: string;
	range: [number, number] | null;
	/** Found range in the new normalized text. */
	match: [number, number] | null;
	score: number;
	anchorIndex?: number;
	offset?: { dx: number; dy: number };
	expected?: number | null;
	/** Why this annotation was or was not found (for review and the report). */
	log: string[];
	/** Window [lo, hi] in the new text where alignment predicts the location (between the two surrounding anchors). */
	expectedRange?: [number, number] | null;
	/** 0..1: alignment confidence (low when text has moved significantly). */
	expectedTrust?: number;
	/** Expected page in the new PDF (also set when no match was found). */
	expectedPage?: number;
	newPage?: number;
	newPos?: { page: number; x: number; y: number };
	/** Annotation positions (PDF points) in the old PDF, on `page`. */
	oldRects: Rect[];
	/** Positions (PDF points) of the proposed annotation in the new PDF. */
	newRects: PageRect[];
	/** Other possible locations in the new text (for repeated text), best first. */
	alternatives: [number, number][];
	/** Currently selected alternative (index in `alternatives`). */
	altIndex: number;
	/** User's decision in the review screen. */
	decision?: "approved" | "rejected";
}

interface RawChar {
	ch: string;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}
export interface RawPage {
	pageNumber: number;
	width: number;
	height: number;
	chars: RawChar[];
}
export interface CharBox {
	page: number;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	v: boolean;
}
interface Shingles {
	head: Map<number, number>;
	next: Int32Array;
}
export interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
export interface PageRect extends Rect {
	page: number;
}

export interface DocIndex {
	text: string;
	box: CharBox[];
	pageStart: number[];
	numPages: number;
	pageSizes: { width: number; height: number }[];
	_shingles: Shingles | null;
}

export interface CarryOverResult {
	/** Output containing all proposed annotations (null if there was nothing to write or `write: false`). */
	bytes: Uint8Array | null;
	results: AnnotationRecord[];
	options: Options;
	/** Text index of the new PDF (needed to write decisions later). */
	index: DocIndex | null;
}

const SHINGLE = 8; // n-gram length for fuzzy preselection
const CONTEXT = 60; // number of context characters before/after a highlight
const MAX_ALTERNATIVES = 30; // number of alternative locations available in review
const MAX_CHAIN = 40; // n-grams occurring more often than this are ignored when voting

/* ------------------------------------------------------------------ */
/* 1. Text and character positions from a pdf.js document              */
/* ------------------------------------------------------------------ */

function mk(ch: string, x: number, y: number, w: number, h: number): RawChar {
	return { ch, x0: x, x1: x + w, y0: y - 0.2 * h, y1: y + 0.85 * h };
}

/** Estimated relative width of a character in a proportional font. */
function charWeight(c: string): number {
	if ("ijl.,;:'!|()[]".includes(c)) return 0.45;
	if ("frt ".includes(c)) return 0.6;
	if ("mwMW".includes(c)) return 1.45;
	if (c >= "A" && c <= "Z") return 1.2;
	return 1;
}

/**
 * Optional measurement of actual character widths (available only in the browser, via canvas).
 * Returns the width of `ch` in font `family`, or null if that font cannot be measured reliably.
 */
export type CharMeasurer = (ch: string, family: string) => number | null;
let measurer: CharMeasurer | null = null;
export function setCharMeasurer(fn: CharMeasurer | null): void {
	measurer = fn;
}

function weightsFor(str: string, family: string | undefined): number[] {
	if (measurer && family) {
		const w: number[] = [];
		for (let i = 0; i < str.length; i++) {
			const m = measurer(str[i], family);
			if (m === null || !(m > 0)) {
				w.length = 0;
				break;
			}
			w.push(m);
		}
		if (w.length === str.length) return w;
	}
	return Array.from({ length: str.length }, (_, i) => charWeight(str[i]));
}

/** Reads all characters on each page with an estimated bounding box (in PDF points). */
export async function readPages(
	pdfDoc: PdfDocument,
	onPage: (page: number, total: number) => void = () => {}
): Promise<RawPage[]> {
	const pages: RawPage[] = [];
	for (let p = 1; p <= pdfDoc.numPages; p++) {
		const page = await pdfDoc.getPage(p);
		const tc = await page.getTextContent();
		const chars: RawChar[] = [];
		let last: {
			x: number;
			y: number;
			w: number;
			str: string;
			eol: boolean;
		} | null = null;
		for (const it of tc.items) {
			if (typeof it.str !== "string") continue;
			const str = it.str;
			const tr = it.transform ?? [1, 0, 0, 1, 0, 0];
			const x = tr[4];
			const y = tr[5];
			const width = it.width ?? 0;
			const h = Math.abs(it.height ?? 0) || Math.abs(tr[3]) || 10;
			const n = str.length;
			if (n > 0) {
				if (last && !last.eol) {
					if (Math.abs(last.y - y) > h * 0.5) {
						chars.push(mk("\n", last.x + last.w, last.y, 0, h));
					} else {
						const gap = x - (last.x + last.w);
						if (gap > h * 0.15 && !/\s$/.test(last.str) && !/^\s/.test(str)) {
							chars.push(mk(" ", last.x + last.w, y, gap, h));
						}
					}
				}
				const wts = weightsFor(
					str,
					it.fontName ? tc.styles?.[it.fontName]?.fontFamily : undefined
				);
				let total = 0;
				for (const wt of wts) total += wt;
				let cx = x;
				for (let i = 0; i < n; i++) {
					const cw = (width * wts[i]) / total;
					chars.push(mk(str[i], cx, y, cw, h));
					cx += cw;
				}
				last = { x, y, w: width, str, eol: false };
			}
			if (it.hasEOL) {
				chars.push(mk("\n", x + width, y, 0, h));
				if (last) last.eol = true;
			}
		}
		const view = page.view;
		pages.push({
			pageNumber: p,
			width: view[2] - view[0],
			height: view[3] - view[1],
			chars,
		});
		onPage(p, pdfDoc.numPages);
	}
	return pages;
}

const CHAR_MAP: Record<string, string> = {
	"‘": "'",
	"’": "'",
	"“": '"',
	"”": '"',
	"–": "-",
	"—": "-",
	"−": "-",
};

/**
 * Builds one normalized text string for the entire document, with a reference to the
 * original position for each character. Normalization: lowercase, NFKC (ligatures),
 * standardized quotation marks/dashes, collapsed whitespace, and
 * removal of hyphens at line breaks.
 */
export function buildIndex(pages: RawPage[]): DocIndex {
	const out: string[] = [];
	const box: CharBox[] = [];
	const pageStart: number[] = [0];
	const push = (c: string, b: CharBox) => {
		out.push(c);
		box.push(b);
	};
	const pushSpace = (b: CharBox) => {
		if (out.length && out[out.length - 1] !== " ") push(" ", b);
	};

	for (const pg of pages) {
		pageStart[pg.pageNumber] = out.length;
		for (const r of pg.chars) {
			const b: CharBox = {
				page: pg.pageNumber,
				x0: r.x0,
				x1: r.x1,
				y0: r.y0,
				y1: r.y1,
				v: false,
			};
			if (r.ch === "\n") {
				const l = out.length;
				if (l >= 2 && out[l - 1] === "-" && /\p{L}/u.test(out[l - 2])) {
					out.pop();
					box.pop(); // line-break hyphen: "exam-\nple" => "example"
				} else {
					pushSpace(b);
				}
				continue;
			}
			if (/\s/.test(r.ch) || r.ch === " ") {
				pushSpace(b);
				continue;
			}
			if (r.ch === "­" || r.ch === "​") continue; // soft hyphens
			const mapped = CHAR_MAP[r.ch] ?? r.ch;
			for (const c of mapped.normalize("NFKC").toLowerCase()) push(c, b);
		}
		// separator between pages (without geometry)
		if (out.length && out[out.length - 1] !== " ") {
			push(" ", { page: pg.pageNumber, x0: 0, x1: 0, y0: 0, y1: 0, v: true });
		}
	}
	pageStart[pages.length + 1] = out.length;
	return {
		text: out.join(""),
		box,
		pageStart,
		numPages: pages.length,
		pageSizes: pages.map((p) => ({ width: p.width, height: p.height })),
		_shingles: null,
	};
}

const pageEnd = (idx: DocIndex, p: number): number =>
	idx.pageStart[p + 1] ?? idx.text.length;

/* ------------------------------------------------------------------ */
/* 2. Read annotations from the old document                           */
/* ------------------------------------------------------------------ */

const MARKUP: Record<string, Kind> = {
	Highlight: "highlight",
	Underline: "underline",
	Squiggly: "underline",
	StrikeOut: "strikeout",
};
const NOTE: Record<string, Kind> = { Text: "note", FreeText: "freetext" };
const IGNORE = new Set(["Popup", "Link", "Widget"]);

type Pt = { x: number; y: number };

function bboxPts(pts: Pt[]): Rect {
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	return {
		x0: Math.min(...xs),
		x1: Math.max(...xs),
		y0: Math.min(...ys),
		y1: Math.max(...ys),
	};
}

/** Normalizes the different QuadPoints formats returned by pdf.js to rectangles. */
function quadRects(a: PdfAnnotationData): Rect[] {
	const raw = a.quadPoints as unknown;
	const q: unknown[] | null = Array.isArray(raw)
		? raw
		: ArrayBuffer.isView(raw)
			? Array.from(raw as unknown as ArrayLike<number>)
			: null;
	const rects: Rect[] = [];
	if (q && q.length) {
		const first = q[0];
		if (typeof first === "number") {
			const nums = q as number[];
			for (let i = 0; i + 7 < nums.length; i += 8) {
				const pts: Pt[] = [];
				for (let k = 0; k < 4; k++)
					pts.push({ x: nums[i + 2 * k], y: nums[i + 2 * k + 1] });
				rects.push(bboxPts(pts));
			}
		} else if (Array.isArray(first)) {
			for (const quad of q as Pt[][]) rects.push(bboxPts(quad));
		} else if (first && typeof (first as Pt).x === "number") {
			const pts = q as Pt[];
			for (let i = 0; i + 3 < pts.length; i += 4)
				rects.push(bboxPts(pts.slice(i, i + 4)));
		}
	}
	if (!rects.length && a.rect)
		rects.push({ x0: a.rect[0], y0: a.rect[1], x1: a.rect[2], y1: a.rect[3] });
	return rects;
}

function anchorMarkup(
	idx: DocIndex,
	rec: AnnotationRecord,
	a: PdfAnnotationData
): void {
	const rects = quadRects(a);
	const lo = idx.pageStart[rec.page];
	const hi = pageEnd(idx, rec.page);
	const sel: number[] = [];
	for (let i = lo; i < hi; i++) {
		const b = idx.box[i];
		if (b.v) continue;
		const cx = (b.x0 + b.x1) / 2;
		const cy = (b.y0 + b.y1) / 2;
		const bw = b.x1 - b.x0;
		for (const r of rects) {
			if (cy < r.y0 - 1 || cy > r.y1 + 1) continue;
			// Include a character if at least half of it lies under the highlight (for short highlights, an adjacent
			// punctuation mark or digit might otherwise be included, e.g. "4." instead of "4")
			const inside =
				bw > 0.01
					? (Math.min(b.x1, r.x1 + 0.5) - Math.max(b.x0, r.x0 - 0.5)) / bw >=
						0.5
					: cx >= r.x0 - 1 && cx <= r.x1 + 1;
			if (inside) {
				sel.push(i);
				break;
			}
		}
	}
	let s = -1;
	let e = -1;
	for (const i of sel) {
		if (idx.text[i] === " ") continue;
		if (s < 0) s = i;
		e = i + 1;
	}
	// If a highlight starts or ends just inside a word, extend it to the word boundary (max. 3 characters)
	if (s > 0) {
		let k = s;
		while (
			k > lo &&
			s - k < 3 &&
			isAlnum(idx.text[k - 1]) &&
			isAlnum(idx.text[k])
		)
			k--;
		if (!(isAlnum(idx.text[k - 1]) && isAlnum(idx.text[k]))) s = k;
	}
	if (e > 0) {
		let k = e;
		while (
			k < hi &&
			k - e < 3 &&
			isAlnum(idx.text[k - 1]) &&
			isAlnum(idx.text[k])
		)
			k++;
		if (!(isAlnum(idx.text[k - 1]) && isAlnum(idx.text[k]))) e = k;
	}
	// Very short highlights: edge punctuation (".", ",", ")") is almost never part of what was intended
	if (s >= 0 && e - s <= 4) {
		while (s < e - 1 && !isAlnum(idx.text[s])) s++;
		while (e > s + 1 && !isAlnum(idx.text[e - 1])) e--;
	}
	if (s < 0 || e - s < 1) {
		rec.status = "unsupported";
		rec.reason =
			"No text was found under the highlight, for example on a scanned page or image.";
		return;
	}
	rec.kind = MARKUP[a.subtype];
	rec.range = [s, e];
	rec.text = idx.text.slice(s, e);
	rec.before = idx.text.slice(Math.max(0, s - CONTEXT), s);
	rec.after = idx.text.slice(e, e + CONTEXT);
	rec.log.push(
	`Old PDF, page ${rec.page}: ${sel.length} characters under the highlight → “${rec.text}” (${rec.text.length} characters)`
	);
	rec.log.push(
		`Context before: “${rec.before.slice(-40)}” | after: “${rec.after.slice(0, 40)}”`
	);
}

function anchorNote(
	idx: DocIndex,
	rec: AnnotationRecord,
	a: PdfAnnotationData
): void {
	const r = a.rect;
	if (!r) {
		rec.status = "unsupported";
		rec.reason = "Note without a position.";
		return;
	}
	const cx = (r[0] + r[2]) / 2;
	const cy = (r[1] + r[3]) / 2;
	const lo = idx.pageStart[rec.page];
	const hi = pageEnd(idx, rec.page);
	let best = -1;
	let bestD = Infinity;
	for (let i = lo; i < hi; i++) {
		const b = idx.box[i];
		if (b.v || idx.text[i] === " ") continue;
		const dx = (b.x0 + b.x1) / 2 - cx;
		const dy = (b.y0 + b.y1) / 2 - cy;
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	if (best < 0) {
		rec.status = "unsupported";
		rec.reason = "There is no text on the page to anchor the note to.";
		return;
	}
	let s = Math.max(lo, best - 20);
	let e = Math.min(hi, best + 20);
	while (s < best && idx.text[s] === " ") s++;
	while (e > best + 1 && idx.text[e - 1] === " ") e--;
	const b = idx.box[best];
	rec.kind = NOTE[a.subtype];
	rec.range = [s, e];
	rec.anchorIndex = best;
	rec.text = idx.text.slice(s, e);
	rec.before = idx.text.slice(Math.max(0, s - CONTEXT), s);
	rec.after = idx.text.slice(e, e + CONTEXT);
	rec.offset = { dx: cx - (b.x0 + b.x1) / 2, dy: cy - (b.y0 + b.y1) / 2 };
	rec.log.push(
		`Note on old page ${rec.page}, anchored to text “${rec.text}”`
	);
}

/** Reads all (supported) annotations from the old document and anchors them to text. */
export async function readAnnotations(
	pdfDoc: PdfDocument,
	idx: DocIndex
): Promise<AnnotationRecord[]> {
	const out: AnnotationRecord[] = [];
	let n = 0;
	for (let p = 1; p <= pdfDoc.numPages; p++) {
		const page = await pdfDoc.getPage(p);
		const anns = await page.getAnnotations({ intent: "any" });
		for (const a of anns) {
			if (IGNORE.has(a.subtype)) continue;
			const rec: AnnotationRecord = {
				id: `p${p}-${n++}`,
				page: p,
				oldNumPages: pdfDoc.numPages,
				subtype: a.subtype,
				kind: "other",
				contents: (
					(a.contentsObj && a.contentsObj.str) ||
					a.contents ||
					""
				).trim(),
				color: a.color ? Array.from(a.color).map((v) => v / 255) : null,
				opacity: typeof a.opacity === "number" ? a.opacity : 1,
				text: "",
				before: "",
				after: "",
				status: "notfound",
				reason: "",
				range: null,
				match: null,
				score: 0,
				oldRects: a.rect || a.quadPoints ? quadRects(a) : [],
				newRects: [],
				alternatives: [],
				altIndex: 0,
				log: [],
			};
			if (MARKUP[a.subtype]) anchorMarkup(idx, rec, a);
			else if (NOTE[a.subtype]) anchorNote(idx, rec, a);
			else {
				rec.status = "unsupported";
				rec.reason = `${a.subtype} annotation (drawing or other type) cannot be transferred automatically.`;
			}
			out.push(rec);
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* 3. Match annotations in the new document                            */
/* ------------------------------------------------------------------ */

function bigrams(s: string): Map<string, number> {
	const m = new Map<string, number>();
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.substr(i, 2);
		m.set(g, (m.get(g) || 0) + 1);
	}
	return m;
}

/** Dice coefficient on bigrams: 0..1, robust to small changes. */
function dice(a: string, b: string): number {
	if (!a.length || !b.length) return 0;
	const A = bigrams(a);
	const B = bigrams(b);
	let inter = 0;
	let total = 0;
	for (const c of A.values()) total += c;
	for (const c of B.values()) total += c;
	for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0);
	return total ? (2 * inter) / total : 0;
}

const isAlnum = (c: string | undefined): boolean =>
	!!c && /[\p{L}\p{N}]/u.test(c);

/** Number of matching characters at the end of a and b (moving left from the highlight). */
function suffixRun(a: string, b: string): number {
	let n = 0;
	while (
		n < a.length &&
		n < b.length &&
		a[a.length - 1 - n] === b[b.length - 1 - n]
	)
		n++;
	return n;
}

/** Number of matching characters at the start of a and b (moving right from the highlight). */
function prefixRun(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

const NEAR = 20;
const RUN_CAP = 40;

/**
 * How closely does the context around [s, e) match the context around the original highlight?
 * Combines (1) bigram similarity of the full context, (2) the same for characters immediately next to the highlight,
 * and (3) the number of exactly matching characters directly before/after it. (2) and (3) matter most for
 * short highlights (e.g. a frequently occurring word).
 */
function contextScore(
	idx: DocIndex,
	a: AnnotationRecord,
	s: number,
	e: number
): number {
	if (!a.before && !a.after) return 0.5;
	const b = idx.text.slice(Math.max(0, s - a.before.length), s);
	const f = idx.text.slice(e, e + a.after.length);
	const sides: number[] = [];
	if (a.before) {
		const run =
			Math.min(suffixRun(a.before, b), RUN_CAP) /
			Math.min(a.before.length, RUN_CAP);
		sides.push(
			0.3 * dice(a.before, b) +
				0.3 * dice(a.before.slice(-NEAR), b.slice(-NEAR)) +
				0.4 * run
		);
	}
	if (a.after) {
		const run =
			Math.min(prefixRun(a.after, f), RUN_CAP) /
			Math.min(a.after.length, RUN_CAP);
		sides.push(
			0.3 * dice(a.after, f) +
				0.3 * dice(a.after.slice(0, NEAR), f.slice(0, NEAR)) +
				0.4 * run
		);
	}
	return sides.reduce((x, y) => x + y, 0) / sides.length;
}

/** If the text starts/ends at a word boundary in the old PDF, it must do so in the new one too ("flight" ≠ "inflight"). */
function boundaryOk(
	idx: DocIndex,
	a: AnnotationRecord,
	s: number,
	e: number
): boolean {
	const first = a.text[0];
	const last = a.text[a.text.length - 1];
	if (
		isAlnum(first) &&
		!isAlnum(a.before.slice(-1)) &&
		isAlnum(idx.text[s - 1])
	)
		return false;
	if (isAlnum(last) && !isAlnum(a.after[0]) && isAlnum(idx.text[e]))
		return false;
	return true;
}

function pageOf(idx: DocIndex, s: number): number {
	for (let i = s; i < idx.box.length; i++)
		if (!idx.box[i].v) return idx.box[i].page;
	return idx.numPages;
}

function pageDistance(idx: DocIndex, a: AnnotationRecord, s: number): number {
	const rel = pageOf(idx, s) / idx.numPages - a.page / a.oldNumPages;
	return Math.abs(rel);
}

/** Penalty for distance from the expected location (from alignment), or based on page ratio otherwise. */
function posPenalty(idx: DocIndex, a: AnnotationRecord, s: number): number {
	if (typeof a.expected === "number") {
		const t = a.expectedTrust ?? 1;
		const [lo, hi] = a.expectedRange ?? [a.expected, a.expected];
		if (s >= lo && s <= hi) {
			// Inside the window between the surrounding anchors: small penalty relative to the window size
			return (
				t * 0.3 * Math.min(1, Math.abs(s - a.expected) / Math.max(40, hi - lo))
			);
		}
		// Outside the window: much less likely, but not impossible (text may have moved)
		const out = s < lo ? lo - s : s - hi;
		return t * (0.35 + Math.min(0.25, out / 3000));
	}
	return 0.5 * pageDistance(idx, a, s);
}

function findAll(text: string, needle: string, cap = 5000): number[] {
	const res: number[] = [];
	let i = text.indexOf(needle);
	while (i !== -1 && res.length < cap) {
		res.push(i);
		i = text.indexOf(needle, i + 1);
	}
	return res;
}

function hash8(str: string, from: number): number {
	let h = 0;
	for (let k = 0; k < SHINGLE; k++)
		h = (Math.imul(h, 31) + str.charCodeAt(from + k)) | 0;
	return h;
}

function ensureShingles(idx: DocIndex): Shingles {
	if (idx._shingles) return idx._shingles;
	const n = idx.text.length;
	const head = new Map<number, number>();
	const next = new Int32Array(Math.max(n, 1)).fill(-1);
	for (let i = 0; i + SHINGLE <= n; i++) {
		const h = hash8(idx.text, i);
		const prev = head.get(h);
		next[i] = prev === undefined ? -1 : prev;
		head.set(h, i);
	}
	idx._shingles = { head, next };
	return idx._shingles;
}

/** Longest increasing subsequence by the second element (new position). */
function lis(pairs: [number, number][]): [number, number][] {
	const tails: number[] = [];
	const tailIdx: number[] = [];
	const prev: number[] = new Array(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		const v = pairs[k][1];
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < v) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = v;
		tailIdx[lo] = k;
		prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
	}
	const res: [number, number][] = [];
	for (
		let k = tails.length ? tailIdx[tails.length - 1] : -1;
		k >= 0;
		k = prev[k]
	)
		res.push(pairs[k]);
	return res.reverse();
}

/**
 * Aligns the old and new documents using unique text fragments. Returns a function that maps
 * a position in the old text to its expected position in the new text (or null).
 * This helps choose the right occurrence of repeated text, even when pages have been added.
 */
export interface Expected {
	pos: number;
	lo: number;
	hi: number;
	trust: number;
}

export function buildAlignment(
	oldIdx: DocIndex,
	newIdx: DocIndex
): (pos: number) => Expected | null {
	// An anchor is a text fragment of SHINGLE characters that occurs exactly once in both the old and new text.
	// (Verifying 24 characters was too strict: a small change next to "Rule 9:" broke the anchor.)
	const nw = ensureShingles(newIdx);
	const od = ensureShingles(oldIdx);
	const pairs: [number, number][] = [];
	for (let i = 0; i + SHINGLE <= oldIdx.text.length; i++) {
		const h = hash8(oldIdx.text, i);
		if (od.head.get(h) !== i || od.next[i] !== -1) continue; // not unique in the old text
		const p = nw.head.get(h);
		if (p === undefined || nw.next[p] !== -1) continue; // not unique in the new text
		if (newIdx.text.substr(p, SHINGLE) !== oldIdx.text.substr(i, SHINGLE))
			continue;
		pairs.push([i, p]);
	}
	const anchors = lis(pairs);
	// If many anchors are out of order (moved sections), the alignment is less reliable.
	const trust = pairs.length
		? Math.min(1, Math.max(0, (anchors.length / pairs.length - 0.5) / 0.4))
		: 0;
	return (pos: number) => {
		if (!anchors.length) return null;
		// First anchor at or after pos, and the anchor before it
		let lo = 0;
		let hi = anchors.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (anchors[mid][0] < pos) lo = mid + 1;
			else hi = mid;
		}
		const after = anchors[lo]; // may be undefined
		const before = lo > 0 ? anchors[lo - 1] : undefined;
		const fromBefore = before ? before[1] + (pos - before[0]) : undefined;
		const fromAfter = after ? after[1] - (after[0] - pos) : undefined;
		// Window: the new text between the two anchors (the text in between may have changed)
		const winLo = before ? before[1] : Math.max(0, (fromAfter ?? 0) - 2000);
		const winHi = after ? after[1] : (fromBefore ?? 0) + 2000;
		let exp: number;
		if (fromBefore !== undefined && fromAfter !== undefined) {
			// Use the estimate from the nearest anchor
			exp = pos - before![0] <= after![0] - pos ? fromBefore : fromAfter;
		} else exp = (fromBefore ?? fromAfter)!;
		exp = Math.min(Math.max(exp, winLo), winHi);
		return { pos: exp, lo: winLo, hi: Math.max(winHi, winLo), trust };
	};
}

/** Sellers' algorithm: approximate substring match. Returns {dist, end} (end exclusive). */
function sellers(p: string, t: string): { dist: number; end: number } {
	const m = p.length;
	const n = t.length;
	let prev = new Int32Array(m + 1);
	let cur = new Int32Array(m + 1);
	for (let i = 0; i <= m; i++) prev[i] = i;
	let best = prev[m];
	let bestEnd = 0;
	for (let j = 1; j <= n; j++) {
		cur[0] = 0;
		const tj = t.charCodeAt(j - 1);
		for (let i = 1; i <= m; i++) {
			const cost = p.charCodeAt(i - 1) === tj ? 0 : 1;
			cur[i] = Math.min(prev[i - 1] + cost, prev[i] + 1, cur[i - 1] + 1);
		}
		if (cur[m] < best) {
			best = cur[m];
			bestEnd = j;
		}
		const tmp = prev;
		prev = cur;
		cur = tmp;
	}
	return { dist: best, end: bestEnd };
}

const rev = (s: string): string => Array.from(s).reverse().join("");

/** Best approximate location of `pattern` in `text[from, to)`. */
function approxSearch(
	pattern: string,
	text: string,
	from: number,
	to: number
): { dist: number; s: number; e: number } | null {
	const region = text.slice(from, to);
	const fw = sellers(pattern, region);
	if (fw.end === 0) return null;
	const back = sellers(rev(pattern), rev(region.slice(0, fw.end)));
	const start = fw.end - back.end;
	return { dist: fw.dist, s: from + start, e: from + fw.end };
}

function trimRange(idx: DocIndex, s: number, e: number): [number, number] {
	while (s < e && idx.text[s] === " ") s++;
	while (e > s && idx.text[e - 1] === " ") e--;
	return [s, e];
}

interface Located {
	status: "exact" | "fuzzy" | "ambiguous";
	s: number;
	e: number;
	score: number;
	/** All plausible locations (best first); populated only for repeated text. */
	alternatives?: [number, number][];
}

function fuzzyLocate(
	idx: DocIndex,
	a: AnnotationRecord,
	opts: Options
): Located | null {
	const T = a.text;
	const m = T.length;
	if (m < 6) {
		a.log.push(`Fuzzy search skipped: text is too short (${m} < 6 characters)`);
		return null;
	}
	const candidates: { start: number; sum: number }[] = [];
	const w = Math.ceil(0.3 * m) + 8;

	if (m >= SHINGLE) {
		const { head, next } = ensureShingles(idx);
		const votes = new Map<number, number>();
		for (let j = 0; j + SHINGLE <= m; j++) {
			let pos = head.get(hash8(T, j));
			let len = 0;
			const hits: number[] = [];
			while (pos !== undefined && pos !== -1 && len <= MAX_CHAIN) {
				hits.push(pos);
				pos = next[pos];
				len++;
			}
			if (len > MAX_CHAIN) continue;
			for (const p of hits) votes.set(p - j, (votes.get(p - j) || 0) + 1);
		}
		const keys = [...votes.keys()].sort((x, y) => x - y);
		// Sliding window [k, k+w]: count the votes
		const windows: { start: number; sum: number }[] = [];
		let hiIdx = 0;
		let sum = 0;
		for (let lo = 0; lo < keys.length; lo++) {
			if (hiIdx < lo) {
				hiIdx = lo;
				sum = 0;
			}
			while (hiIdx < keys.length && keys[hiIdx] <= keys[lo] + w) {
				sum += votes.get(keys[hiIdx]) ?? 0;
				hiIdx++;
			}
			windows.push({ start: keys[lo], sum });
			sum -= votes.get(keys[lo]) ?? 0;
		}
		const minVotes = Math.max(2, Math.round(0.1 * (m - SHINGLE + 1)));
		windows.sort((x, y) => y.sum - x.sum);
		for (const win of windows) {
			if (win.sum < minVotes || candidates.length >= 30) break;
			if (candidates.some((c) => Math.abs(c.start - win.start) <= w)) continue;
			candidates.push(win);
		}
	}

	const evaluate = (fromPos: number, toPos: number) => {
		const from = Math.max(0, fromPos);
		const to = Math.min(idx.text.length, toPos);
		const r = approxSearch(T, idx.text, from, to);
		if (!r) return null;
		const [s, e] = trimRange(idx, r.s, r.e);
		if (e <= s) return null;
		const sim = 1 - r.dist / m;
		const ctx = contextScore(idx, a, s, e);
		return {
			s,
			e,
			sim,
			ctx,
			total: 0.6 * sim + 0.4 * ctx - posPenalty(idx, a, s),
		};
	};

	let best: ReturnType<typeof evaluate> = null;
	for (const c of candidates) {
		const r = evaluate(c.start - 10, c.start + w + m + 10);
		if (r && (!best || r.total > best.total)) best = r;
	}
	if (!best) {
		// No n-gram hits: search around the expected location
		const exp =
			typeof a.expected === "number"
				? a.expected
				: Math.round((a.page / a.oldNumPages) * idx.text.length);
		const from = Math.max(0, exp - 4000);
		const to = Math.min(idx.text.length, exp + 4000 + m);
		if ((to - from) * m <= 6e6) best = evaluate(from, to);
	}
	if (!best) {
		a.log.push("Fuzzy search: no candidates");
		return null;
	}
	a.log.push(
		`Fuzzy search: best similarity ${Math.round(best.sim * 100)}% (minimum ${Math.round(opts.minSimilarity * 100)}%), context ${Math.round(best.ctx * 100)}%`
	);
	if (best.sim < opts.minSimilarity) return null;
	return { status: "fuzzy", s: best.s, e: best.e, score: best.sim };
}

/**
 * For short text that has itself changed (e.g. "4" became "5"): find the location where the text before and after
 * it still appears, with a short fragment in between. That fragment is the changed highlight.
 */
function contextLocate(idx: DocIndex, a: AnnotationRecord): Located | null {
	const m = a.text.length;
	for (const N of [40, 25, 15, 10]) {
		const b = a.before.slice(-N);
		const f = a.after.slice(0, N);
		if (b.length < Math.min(N, 8) || f.length < Math.min(N, 8)) continue;
		const found: { s: number; e: number; pen: number }[] = [];
		for (const p of findAll(idx.text, b, 3000)) {
			const from = p + b.length;
			const k = idx.text.slice(from, from + m + 8 + f.length).indexOf(f);
			if (k < 0) continue;
			const [s, e] = trimRange(idx, from, from + k);
			if (e > s) found.push({ s, e, pen: posPenalty(idx, a, s) });
		}
		a.log.push(
			`Context-only search (${b.length}+${f.length} characters): ${found.length} location(s)`
		);
		if (found.length) {
			found.sort((x, y) => x.pen - y.pen);
			const best = found[0];
			a.log.push(
				`→ changed text at the highlight location: “${idx.text.slice(best.s, best.e)}”`
			);
			return {
				status: "fuzzy",
				s: best.s,
				e: best.e,
				score: 0.5,
				alternatives: found
					.slice(0, MAX_ALTERNATIVES)
					.map((x): [number, number] => [x.s, x.e]),
			};
		}
	}
	return null;
}

function locate(
	idx: DocIndex,
	a: AnnotationRecord,
	opts: Options,
	claimed: Set<number>
): Located | null {
	const all = findAll(idx.text, a.text);
	if (!all.length) {
		// Edge punctuation (e.g. "4." or "(UM)") may differ in the new version: search for the core text
		const lead = /^[^\p{L}\p{N}]+/u.exec(a.text)?.[0] ?? "";
		const trail = /[^\p{L}\p{N}]+$/u.exec(a.text.slice(lead.length))?.[0] ?? "";
		const core = a.text.slice(lead.length, a.text.length - trail.length);
		if ((lead || trail) && core) {
			a.log.push(
				`No exact match with punctuation; searching again for “${core}”`
			);
			const tmp: AnnotationRecord = {
				...a,
				text: core,
				before: a.before + lead,
				after: trail + a.after,
			};
			const r = locateCore(idx, tmp, opts, claimed);
			if (r) return r;
		}
	}
	return locateCore(idx, a, opts, claimed);
}

function locateCore(
	idx: DocIndex,
	a: AnnotationRecord,
	opts: Options,
	claimed: Set<number>
): Located | null {
	const all = findAll(idx.text, a.text);
	let occ = all;
	const whole = all.filter((s) => boundaryOk(idx, a, s, s + a.text.length));
	if (whole.length) occ = whole; // fall back to partial-word matches only if there are no whole-word matches
	if (typeof a.expected === "number") {
		const [lo, hi] = a.expectedRange ?? [a.expected, a.expected];
		a.log.push(
			`Alignment: expected around character position ${a.expected} (window ${lo}–${hi}, confidence ${Math.round((a.expectedTrust ?? 1) * 100)}%)`
		);
	} else {
		a.log.push(
			"Alignment: no fixed points found; only page ratio used"
		);
	}
	a.log.push(
		`Exact matches for “${a.text}” in the new PDF: ${all.length}${all.length !== whole.length && all.length ? ` (${whole.length} as whole words)` : ""}`
	);
	if (occ.length) {
		const scored = occ
			.map((s) => {
				const e = s + a.text.length;
				const ctx = contextScore(idx, a, s, e);
				const pen = posPenalty(idx, a, s);
				let score = ctx - pen;
				if (claimed.has(s)) score -= 0.3;
				return { s, e, score, ctx, pen };
			})
			.sort((x, y) => y.score - x.score);
		for (const [i, x] of scored.slice(0, 5).entries()) {
			a.log.push(
				`  #${i + 1}: page ${pageOf(idx, x.s)}, “…${idx.text.slice(Math.max(0, x.s - 25), x.s)}[${a.text}]${idx.text.slice(x.e, x.e + 25)}…” score ${x.score.toFixed(2)} (context ${x.ctx.toFixed(2)} − position ${x.pen.toFixed(2)})`
			);
		}
		const best = scored[0];
		// All exact matches are far from the location expected by alignment: perhaps the text itself
		// changed (e.g. "4" became "7") while the surrounding text is still in the expected location
		if (
			a.text.length <= 20 &&
			best.pen >= 0.35 &&
			(a.expectedTrust ?? 1) >= 0.6
		) {
			a.log.push(
				"All exact matches are outside the expected window; searching by context only"
			);
			const cx = contextLocate(idx, a);
			if (cx && posPenalty(idx, a, cx.s) < 0.35) return cx;
		}
		const margin = a.text.length < 20 ? 0.12 : 0.08; // short text is more likely to be ambiguous
		const ambiguous =
			scored.length > 1 && best.score - scored[1].score < margin;
		if (scored.length > 1)
			a.log.push(
				`Difference between best and second: ${(best.score - scored[1].score).toFixed(2)} (threshold ${margin}) → ${ambiguous ? "ambiguous" : "clear"}`
			);
		const alternatives = scored
			.slice(0, MAX_ALTERNATIVES)
			.map((x): [number, number] => [x.s, x.e]);
		return {
			status: ambiguous ? "ambiguous" : "exact",
			s: best.s,
			e: best.e,
			score: 1,
			alternatives,
		};
	}
	const fz = fuzzyLocate(idx, a, opts);
	if (fz) return fz;
	if (a.text.length <= 20) {
		const cx = contextLocate(idx, a);
		if (cx) return cx;
	}
	return null;
}

/**
 * Records where the annotation belongs in the new text (range [s, e)) and calculates the positions
 * in PDF points for display and writing. Also used to select another alternative later.
 */
export function applyMatch(
	idx: DocIndex,
	a: AnnotationRecord,
	s: number,
	e: number
): void {
	a.match = [s, e];
	a.newPage = pageOf(idx, s);
	a.newPos = undefined;
	a.newRects = [];
	if (
		(a.kind === "note" || a.kind === "freetext") &&
		a.range &&
		a.offset &&
		a.anchorIndex !== undefined
	) {
		let k = Math.min(Math.max(s + (a.anchorIndex - a.range[0]), s), e - 1);
		while (k < e - 1 && idx.box[k].v) k++;
		const b = idx.box[k];
		a.newPos = {
			page: b.page,
			x: (b.x0 + b.x1) / 2 + a.offset.dx,
			y: (b.y0 + b.y1) / 2 + a.offset.dy,
		};
		a.newPage = b.page;
		a.newRects = [
			{
				page: b.page,
				x0: a.newPos.x - 10,
				y0: a.newPos.y - 10,
				x1: a.newPos.x + 10,
				y1: a.newPos.y + 10,
			},
		];
	} else {
		for (const lines of linesFor(idx, s, e).values()) a.newRects.push(...lines);
	}
}

/** Finds the location of each annotation in the new document. Mutates and returns `annots`. */
export function matchAnnotations(
	annots: AnnotationRecord[],
	idx: DocIndex,
	opts: Options,
	onProgress: (done: number, total: number) => void = () => {}
): AnnotationRecord[] {
	const claimed = new Set<number>();
	annots.forEach((a, i) => {
		onProgress(i + 1, annots.length);
		if (a.status === "unsupported") return;
		const m = locate(idx, a, opts, claimed);
		if (!m) {
			a.status = "notfound";
			a.reason ||=
				"The text no longer appears in the new PDF, even with its surrounding text. See diagnostics.";
			return;
		}
		a.status = m.status;
		a.score = m.score;
		a.alternatives = m.alternatives ?? [];
		a.altIndex = 0;
		claimed.add(m.s);
		applyMatch(idx, a, m.s, m.e);
	});
	return annots;
}

/* ------------------------------------------------------------------ */
/* 4. Write annotations to the new PDF (pdf-lib)                       */
/* ------------------------------------------------------------------ */

const num = (v: number): number => Math.round(v * 1000) / 1000;

interface Line {
	page: number;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

/** Converts the matched range to lines (rectangles) for each page. */
function linesFor(idx: DocIndex, s: number, e: number): Map<number, Line[]> {
	const byPage = new Map<number, Line[]>();
	let cur: Line | null = null;
	for (let i = s; i < e; i++) {
		const b = idx.box[i];
		if (b.v) {
			cur = null;
			continue;
		}
		const h: number = cur ? cur.y1 - cur.y0 : 0;
		if (
			cur &&
			cur.page === b.page &&
			Math.abs(b.y0 - cur.y0) < h * 0.4 &&
			b.x0 >= cur.x1 - h
		) {
			cur.x1 = Math.max(cur.x1, b.x1);
			cur.x0 = Math.min(cur.x0, b.x0);
			cur.y0 = Math.min(cur.y0, b.y0);
			cur.y1 = Math.max(cur.y1, b.y1);
		} else {
			const line: Line = {
				page: b.page,
				x0: b.x0,
				x1: b.x1,
				y0: b.y0,
				y1: b.y1,
			};
			cur = line;
			const list = byPage.get(b.page);
			if (list) list.push(line);
			else byPage.set(b.page, [line]);
		}
	}
	return byPage;
}

const DEFAULT_COLOR: Record<string, number[]> = {
	highlight: [1, 0.9, 0.2],
	underline: [0.85, 0.1, 0.1],
	strikeout: [0.85, 0.1, 0.1],
};

function warning(a: AnnotationRecord, opts: Options): string {
	// Approved in the review screen: the user has checked it, so no warning is needed
	if (!opts.flagChanged || a.decision === "approved") return a.contents;
	let prefix = "";
	if (a.status === "fuzzy")
		prefix = "[⚠ Text changed in the new version; review]";
	else if (a.status === "ambiguous")
		prefix = "[⚠ Multiple locations possible; review]";
	if (!prefix) return a.contents;
	const old =
		a.kind === "note" || a.kind === "freetext"
			? ""
			: ` Original: “${a.text.slice(0, 200)}”`;
	return `${prefix}${old}${a.contents ? "\n" + a.contents : ""}`;
}

function addMarkup(
	pdfLib: PdfLib,
	doc: PDFDocument,
	pages: PDFPage[],
	a: AnnotationRecord,
	idx: DocIndex,
	opts: Options
): void {
	if (!a.match) return;
	const { PDFHexString, PDFString } = pdfLib;
	const ctx = doc.context;
	const color = (
		a.color ||
		DEFAULT_COLOR[a.kind] ||
		DEFAULT_COLOR.highlight
	).map(num);
	const opacity = a.kind === "highlight" ? Math.min(1, a.opacity || 1) : 1;
	const contents = warning(a, opts);

	for (const [pageNo, lines] of linesFor(idx, a.match[0], a.match[1])) {
		const page = pages[pageNo - 1];
		if (!page) continue;
		const quads: number[] = [];
		const ops: string[] = [];
		let rx0 = Infinity;
		let ry0 = Infinity;
		let rx1 = -Infinity;
		let ry1 = -Infinity;
		for (const l of lines) {
			quads.push(l.x0, l.y1, l.x1, l.y1, l.x0, l.y0, l.x1, l.y0);
			rx0 = Math.min(rx0, l.x0);
			ry0 = Math.min(ry0, l.y0);
			rx1 = Math.max(rx1, l.x1);
			ry1 = Math.max(ry1, l.y1);
			const w = l.x1 - l.x0;
			const h = l.y1 - l.y0;
			if (a.kind === "highlight")
				ops.push(`${num(l.x0)} ${num(l.y0)} ${num(w)} ${num(h)} re f`);
			else {
				const y = a.kind === "strikeout" ? l.y0 + h * 0.45 : l.y0 + h * 0.12;
				ops.push(`${num(l.x0)} ${num(y)} m ${num(l.x1)} ${num(y)} l S`);
			}
		}
		const rect = [rx0, ry0, rx1, ry1].map(num);
		const [r, g, b] = color;
		const content =
			a.kind === "highlight"
				? `/GS0 gs ${r} ${g} ${b} rg\n${ops.join("\n")}`
				: `/GS0 gs ${r} ${g} ${b} RG 0.8 w\n${ops.join("\n")}`;
		const ap = ctx.stream(content, {
			Type: "XObject",
			Subtype: "Form",
			FormType: 1,
			BBox: rect,
			Resources: {
				ExtGState: {
					GS0: {
						Type: "ExtGState",
						BM: a.kind === "highlight" ? "Multiply" : "Normal",
						ca: opacity,
						CA: opacity,
					},
				},
			},
		});
		const subtype =
			a.kind === "highlight"
				? "Highlight"
				: a.kind === "underline"
					? "Underline"
					: "StrikeOut";
		const annot = ctx.obj({
			Type: "Annot",
			Subtype: subtype,
			Rect: rect,
			QuadPoints: quads.map(num),
			C: color,
			CA: opacity,
			F: 4,
			Contents: PDFHexString.fromText(contents),
			T: PDFHexString.fromText(opts.author),
			M: PDFString.fromDate(new Date()),
			AP: { N: ctx.register(ap) },
		});
		page.node.addAnnot(ctx.register(annot));
	}
}

function addNote(
	pdfLib: PdfLib,
	doc: PDFDocument,
	pages: PDFPage[],
	a: AnnotationRecord,
	opts: Options
): void {
	if (!a.newPos) return;
	const { PDFHexString, PDFString } = pdfLib;
	const ctx = doc.context;
	const page = pages[a.newPos.page - 1];
	if (!page) return;
	const mb = page.getMediaBox();
	const size = 20;
	const x = Math.min(
		Math.max(a.newPos.x - size / 2, mb.x),
		mb.x + mb.width - size
	);
	const y = Math.min(
		Math.max(a.newPos.y - size / 2, mb.y),
		mb.y + mb.height - size
	);
	const rect = [x, y, x + size, y + size].map(num);
	const color = (a.color || [1, 0.84, 0.1]).map(num);
	const ap = ctx.stream(
		`${color.join(" ")} rg 0.45 0.35 0 RG 0.8 w ${num(x)} ${num(y)} ${size} ${size} re B\n` +
			`0.3 0.22 0 RG 1 w ${num(x + 4)} ${num(y + 14)} m ${num(x + 16)} ${num(y + 14)} l S ` +
			`${num(x + 4)} ${num(y + 10)} m ${num(x + 16)} ${num(y + 10)} l S ${num(x + 4)} ${num(y + 6)} m ${num(x + 12)} ${num(y + 6)} l S`,
		{ Type: "XObject", Subtype: "Form", FormType: 1, BBox: rect }
	);
	let contents = warning(a, opts);
	if (a.kind === "freetext")
		contents = `[Free text, converted to a note]\n${contents}`;
	const annot = ctx.obj({
		Type: "Annot",
		Subtype: "Text",
		Rect: rect,
		Name: "Comment",
		C: color,
		F: 28,
		Open: false,
		Contents: PDFHexString.fromText(contents),
		T: PDFHexString.fromText(opts.author),
		M: PDFString.fromDate(new Date()),
		AP: { N: ctx.register(ap) },
	});
	page.node.addAnnot(ctx.register(annot));
}

/** Writes all matched annotations to (a copy of) the new PDF. */
export async function writeAnnotations(
	pdfLib: PdfLib,
	bytes: Uint8Array,
	idx: DocIndex,
	results: AnnotationRecord[],
	opts: Options
): Promise<Uint8Array> {
	const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
	const pages = doc.getPages();
	for (const a of results) {
		if (!a.match || a.decision === "rejected") continue;
		if (a.kind === "note" || a.kind === "freetext")
			addNote(pdfLib, doc, pages, a, opts);
		else addMarkup(pdfLib, doc, pages, a, idx, opts);
	}
	return doc.save();
}

/* ------------------------------------------------------------------ */
/* 5. Report and main function                                         */
/* ------------------------------------------------------------------ */

export interface Summary {
	total: number;
	exact: number;
	fuzzy: number;
	ambiguous: number;
	notfound: number;
	unsupported: number;
}

export function summarize(results: AnnotationRecord[]): Summary {
	const s: Summary = {
		total: results.length,
		exact: 0,
		fuzzy: 0,
		ambiguous: 0,
		notfound: 0,
		unsupported: 0,
	};
	for (const r of results) s[r.status]++;
	return s;
}

export const STATUS_LABEL: Record<Status, string> = {
	exact: "Transferred",
	fuzzy: "Transferred, text changed",
	ambiguous: "Transferred, multiple locations possible",
	notfound: "Not found",
	unsupported: "Unsupported",
};

const KIND_LABEL: Record<Kind, string> = {
	highlight: "Highlight",
	underline: "Underline",
	strikeout: "Strikethrough",
	note: "Note",
	freetext: "Free text",
	other: "Annotation",
};
export const kindLabel = (k: Kind): string => KIND_LABEL[k] ?? "Annotation";

export function buildReport(
	results: AnnotationRecord[],
	meta: { oldName?: string; newName?: string } = {}
): string {
	const s = summarize(results);
	const lines: string[] = [];
	lines.push("# Annotation Carryover");
	if (meta.oldName || meta.newName)
		lines.push(`\n${meta.oldName || "?"} → ${meta.newName || "?"}`);
	lines.push(
		`\n**${s.total}** annotations: ${s.exact} transferred, ${s.fuzzy} with changed text, ${s.ambiguous} ambiguous, ${s.notfound} not found, ${s.unsupported} unsupported.`
	);
	const section = (title: string, status: Status) => {
		const items = results.filter((r) => r.status === status);
		if (!items.length) return;
		lines.push(`\n## ${title} (${items.length})`);
		for (const r of items) {
			const where = r.newPage ? ` → new page ${r.newPage}` : "";
			const decision =
				r.decision === "approved"
					? " (approved)"
					: r.decision === "rejected"
						? " (rejected, not added)"
						: "";
			lines.push(
				`\n- **${kindLabel(r.kind)}**, old page ${r.page}${where}${decision}`
			);
			if (r.text) lines.push(`  - Text: “${r.text}”`);
			if (r.contents)
				lines.push(`  - Note: ${r.contents.replace(/\n/g, " ")}`);
			if (r.reason) lines.push(`  - ${r.reason}`);
			if (r.log.length) {
				lines.push("  - Diagnostics:");
				for (const l of r.log) lines.push(`    - ${l.trim()}`);
			}
		}
	};
	section("Not found: review manually", "notfound");
	section("Text changed: review", "fuzzy");
	section("Multiple locations possible: review", "ambiguous");
	section("Unsupported", "unsupported");
	return lines.join("\n") + "\n";
}

export interface CarryOverParams {
	/** pdf.js document for the old PDF (with annotations). */
	oldDoc: PdfDocument;
	/** pdf.js document for the new PDF. */
	newDoc: PdfDocument;
	/** Raw bytes of the new PDF (pdf.js consumes its buffer, so pass it a copy). */
	newBytes: Uint8Array;
	pdfLib: PdfLib;
	options?: Partial<Options>;
	onProgress?: (text: string, fraction: number) => void;
	/** false: only find and propose matches; write nothing (the review screen writes them later). Defaults to true. */
	write?: boolean;
}

/** Full flow: read, align, match, and optionally write. */
export async function carryOver({
	oldDoc,
	newDoc,
	newBytes,
	pdfLib,
	options = {},
	onProgress = () => {},
	write = true,
}: CarryOverParams): Promise<CarryOverResult> {
	const opts: Options = {
		minSimilarity: 0.7,
		flagChanged: true,
		author: "Annotation Carryover",
		...options,
	};
	onProgress("Reading old PDF", 0.05);
	const oldIdx = buildIndex(
		await readPages(oldDoc, (p, n) =>
			onProgress(`Reading old PDF (${p}/${n})`, 0.05 + 0.2 * (p / n))
		)
	);
	const annots = await readAnnotations(oldDoc, oldIdx);
	if (!annots.length)
		return { bytes: null, results: [], options: opts, index: null };
	onProgress("Reading new PDF", 0.3);
	const newIdx = buildIndex(
		await readPages(newDoc, (p, n) =>
			onProgress(`Reading new PDF (${p}/${n})`, 0.3 + 0.3 * (p / n))
		)
	);
	onProgress("Finding annotations", 0.65);
	const expectedPos = buildAlignment(oldIdx, newIdx);
	for (const a of annots) {
		const ex = a.range ? expectedPos(a.range[0]) : null;
		a.expected = ex ? ex.pos : null;
		a.expectedRange = ex ? [ex.lo, ex.hi] : null;
		a.expectedTrust = ex ? ex.trust : 0;
	}
	matchAnnotations(annots, newIdx, opts);
	for (const a of annots) {
		// Expected page in the new PDF; useful even when no match was found
		const last = Math.max(0, newIdx.text.length - 1);
		a.expectedPage =
			typeof a.expected === "number"
				? pageOf(newIdx, Math.min(Math.max(a.expected, 0), last))
				: Math.min(
						newIdx.numPages,
						Math.max(1, Math.round((a.page / a.oldNumPages) * newIdx.numPages))
					);
	}
	let bytes: Uint8Array | null = null;
	if (write) {
		onProgress("Writing annotations", 0.85);
		bytes = await writeAnnotations(pdfLib, newBytes, newIdx, annots, opts);
	}
	onProgress("Done", 1);
	return { bytes, results: annots, options: opts, index: newIdx };
}
