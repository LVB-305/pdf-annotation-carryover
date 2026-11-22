'use client';

import { useEffect, useRef, useState } from 'react';

/** Minimal typing for the pdf.js functionality needed to draw a page. */
interface Viewport { width: number; height: number; convertToViewportRectangle(rect: number[]): number[] }
interface RenderTask { promise: Promise<void>; cancel(): void }
interface RenderablePage {
  getViewport(o: { scale: number }): Viewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: Viewport }): RenderTask;
}
export interface RenderableDoc { numPages: number; getPage(n: number): Promise<RenderablePage> }

export interface PageOverlay { page: number; x0: number; y0: number; x1: number; y1: number }

interface Props {
  doc: RenderableDoc;
  /** First page shown (the component subsequently remembers the selected page). */
  initialPage: number;
  overlays: PageOverlay[];
  /** Annotation color (0..1); determines the highlight fill. */
  color: number[] | null;
  label: string;
  tone: 'old' | 'new';
  /** Text shown when there is no annotation to mark (for example, "Not found"). */
  emptyNote?: string;
}

const toCss = (c: number[] | null, alpha: number): string => {
  const [r, g, b] = (c && c.length >= 3 ? c : [1, 0.9, 0.2]).map((v) => Math.round(v * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Draws one PDF page on a canvas with the proposed annotation on top. */
export default function PdfPageView({ doc, initialPage, overlays, color, label, tone, emptyNote }: Props) {
  const [page, setPage] = useState(Math.min(Math.max(1, initialPage), doc.numPages));
  const [width, setWidth] = useState(0);
  const [boxes, setBoxes] = useState<{ left: number; top: number; w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // breedte van de container volgen (telefoon draaien, venster aanpassen)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const overlayKey = overlays.map((o) => `${o.page}:${o.x0}:${o.y0}:${o.x1}:${o.y1}`).join('|');

  useEffect(() => {
    if (!width) return;
    let task: RenderTask | null = null;
    let stale = false;
    (async () => {
      try {
        setError(null);
        const p = await doc.getPage(page);
        if (stale) return;
        const base = p.getViewport({ scale: 1 });
        const cssScale = width / base.width;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = p.getViewport({ scale: cssScale * dpr });
        const cssViewport = p.getViewport({ scale: cssScale });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        task = p.render({ canvasContext: ctx, viewport });

        const mine = overlays.filter((o) => o.page === page);
        const bx = mine.map((o) => {
          const [x0, y0, x1, y1] = cssViewport.convertToViewportRectangle([o.x0, o.y0, o.x1, o.y1]);
          return { left: Math.min(x0, x1), top: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        });
        setBoxes(bx);
        await task.promise;
        if (stale) return;
        // Scroll to the annotation so it is immediately visible.
        const wrap = wrapRef.current;
        if (wrap && bx.length) {
          const top = Math.min(...bx.map((b) => b.top));
          wrap.scrollTop = Math.max(0, top - wrap.clientHeight * 0.35);
        } else if (wrap) {
          wrap.scrollTop = 0;
        }
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name !== 'RenderingCancelledException' && !stale) setError('Page could not be displayed.');
      }
    })();
    return () => { stale = true; task?.cancel(); };
    // overlays zit in overlayKey: voorkomt dat een nieuwe array-instantie telkens opnieuw tekent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, width, overlayKey]);

  const goTo = () => {
    const n = parseInt(jumpValue.replace(/\D/g, ''), 10);
    if (Number.isFinite(n)) setPage(Math.min(Math.max(1, n), doc.numPages));
    setJumpOpen(false);
  };

  const hasOverlay = overlays.length > 0;
  const hasOnThisPage = overlays.some((o) => o.page === page);

  return (
    <div className={`viewer ${tone}`}>
      <div className="viewer-head">
        <strong>{label}</strong>
        <span className="pager">
          <button type="button" className="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
          <button
            type="button"
            className="pagebtn"
            aria-label={`Page ${page} of ${doc.numPages}, click to go to a page`}
            onClick={() => { setJumpValue(String(page)); setJumpOpen(true); }}
          >
            Page {page} / {doc.numPages}
          </button>
          <button type="button" className="icon" aria-label="Next page" disabled={page >= doc.numPages} onClick={() => setPage(page + 1)}>›</button>
        </span>
      </div>
      <div className="viewer-body" ref={wrapRef}>
        <div className="page" style={{ position: 'relative', width: '100%' }}>
          <canvas ref={canvasRef} />
          {boxes.map((b, i) => (
            <div
              key={i}
              className="overlay"
              style={{
                left: b.left, top: b.top, width: b.w, height: b.h,
                background: toCss(color, tone === 'old' ? 0.25 : 0.4),
              }}
            />
          ))}
        </div>
        {error && <p className="viewer-msg">{error}</p>}
      </div>
      {jumpOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget) setJumpOpen(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setJumpOpen(false); }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Return to page"
            onSubmit={(e) => { e.preventDefault(); goTo(); }}
          >
            <h3>Go to page</h3>
            <label className="jump">
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                enterKeyHint="go"
                value={jumpValue}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setJumpValue(e.target.value.replace(/\D/g, ''))}
                aria-label={`Page number, 1 to ${doc.numPages}`}
              />
              <span>/ {doc.numPages}</span>
            </label>
            <div className="decide">
              <button type="button" className="secondary" onClick={() => setJumpOpen(false)}>Cancel</button>
              <button type="submit">Go</button>
            </div>
          </form>
        </div>
      )}
      {(!hasOverlay || !hasOnThisPage) && (
        <p className="viewer-foot">
          {!hasOverlay ? (emptyNote ?? 'No annotation to display.') : 'The annotation is on a different page.'}
        </p>
      )}
    </div>
  );
}