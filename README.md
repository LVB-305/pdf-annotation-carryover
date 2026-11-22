# Annotation Carryover (Next.js + TypeScript PWA)

Transfers highlights (highlight, underline, strikethrough) and notes from an old PDF to a new version of the same PDF. Everything runs locally in the browser (pdf.js for reading and pdf-lib for writing), so nothing is uploaded. After the first visit, the app also works offline.

## Quickly on your iPhone

The `out/` folder is the ready-to-use static site. Upload that folder to an HTTPS host:

- **Netlify**: drag `out/` into app.netlify.com/drop
- **Cloudflare Pages**: "Direct upload" with `out/`
- **GitHub Pages / Vercel**: also supported; see below for a subfolder

Open the URL in Safari, wait a few seconds (the app loads everything for offline use), then choose Share → *Add to Home Screen*.

## Development

```bash
npm install
npm run dev          # development server (service worker disabled in dev)
npm run build        # static export to out/
npm run start        # serve out/ locally
npm run typecheck    # check app and service worker
npm test             # end-to-end test in Node; writes examples to test/out/
```

Hosting from a subfolder (for example `https://name.github.io/annotations/`):
`NEXT_PUBLIC_BASE_PATH=/annotations npm run build`

## Structure

| Path | Role |
|---|---|
| `lib/core.ts` | Core logic with no DOM or Next dependencies. pdf.js and pdf-lib are supplied externally, so the module can also be used in Node or in a React Native/native shell |
| `lib/loaders.ts` | Loads pdf.js (standalone file in `public/vendor`) and pdf-lib only when needed |
| `components/AnnotationCarryover.tsx` | Client-side UI |
| `components/ServiceWorkerRegister.tsx` | Registers the service worker and preloads libraries for offline use |
| `sw/sw.ts` | Service worker in TypeScript, bundled to `public/sw.js` by `scripts/prepare-assets.ts` |
| `test/test.ts` | End-to-end test that generates old/new PDFs and verifies the result |

## How it works

PDF annotations are tied to page coordinates, which break when the layout shifts. Therefore:

1. **Read**: extract the highlighted text and 60 characters of context before and after each annotation (notes use the nearest text as an anchor).
2. **Align**: link the old and new documents through unique text fragments to estimate where an old position belongs in the new version.
3. **Search**: try exact text matching first (when there are multiple matches, the best context and closest expected position win), then fuzzy matching.
4. **Write**: recreate the annotation as a standard PDF annotation with its appearance, making it visible in Files, Preview, Acrobat, PDF Expert, and other apps.
5. **Report**: list everything that could not be transferred exactly for review.

Statuses: *Transferred*, *Changed text* (⚠ in the note), *Ambiguous* (⚠), *Not found*, *Unsupported* (drawing work, shapes).

## Known limitations

- Only PDFs with a text layer (not scans or PDFs without OCR).
- Text positions are estimated from pdf.js item widths (not exact font metrics), so a highlight may differ by a few points.
- Multi-column layouts and tables may have a different reading order, making matching less reliable.
- Very repetitive text can produce a fuzzy match in the wrong place; these matches are marked with ⚠.
- Drawing work (Ink), shapes, and stamps are not transferred; free text becomes a note.
- Existing annotations in the new PDF are left untouched; only new annotations are added.
- Tested with generated PDFs, not yet with real documents or annotations from PDF Expert/Acrobat.

## Next steps

- Share via the Share Sheet or "Open in..." (requires a native shell).
- Reuse old annotations from a previous transfer (chains of versions).
- Diff view (old and new text side by side) in the report.

## Reviewing uncertain matches

After transfer, a review screen appears for everything that was not transferred exactly:

- The **old PDF** on the left and **new PDF** on the right (stacked on a phone), with the annotation outlined.
- A word-by-word diff of the highlighted old and new text.
- **Approve** (removes ⚠), **Reject** (does not add the annotation), or no action (adds the annotation with ⚠).
- For ambiguous matches, **Choose another location** to browse candidates.
- **Approve All** completes the review quickly. Not-found annotations show only the old position.

Additional repeated-sentence test pair: `npx tsx test/make-ambiguous.ts` (writes `test/out/amb-v1.pdf` and `amb-v2.pdf`).

## Flow and short highlights

- The app uses three steps: **Choose → Review → Save**, with **Start New Document** at the bottom.
  If everything is transferred exactly, the review step is skipped.
- During position matching, context immediately before and after a highlight has more weight (exact matches directly adjacent to the highlight), and a match inside another word ("inflight") does not count.
  Short highlights are more likely to be marked ambiguous for review.
- Word position within a line is calculated in the browser using real character widths (canvas).
- `npm test` also runs `test/test-short.ts` (the short highlight "Flight" in several locations).
