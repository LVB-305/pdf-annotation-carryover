// Loads pdf.js and pdf-lib only when needed (in the browser).
import { asset } from './config';
import { setCharMeasurer } from './core';
import type { PdfDocument, PdfLib } from './core';

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

let pdfjsPromise: Promise<PdfJs> | null = null;

/**
 * pdf.js is loaded as a standalone file from /vendor, not by the bundler: this keeps the build
 * simple, avoids bundler tricks for the worker, and lets the service worker cache both files offline.
 */
export function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const url = new URL(asset('/vendor/pdf.min.js'), window.location.origin).href;
    const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as PdfJs;
    mod.GlobalWorkerOptions.workerSrc = new URL(asset('/vendor/pdf.worker.min.js'), window.location.origin).href;
    return mod;
  })();
  return pdfjsPromise;
}

export async function loadPdfLib(): Promise<PdfLib> {
  return import('pdf-lib');
}

/** Opens a PDF with pdf.js. pdf.js consumes its buffer, so always provide a copy. */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

const GENERIC = new Set(['sans-serif', 'serif', 'monospace']);

/**
 * Measures real character widths with a canvas so word positions within a line are accurate
 * (important for short highlights). Used only for generic or truly loaded fonts; otherwise
 * the core logic falls back to an estimate.
 */
export function installCharMeasurer(): void {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    const cache = new Map<string, number | null>();
    setCharMeasurer((ch, family) => {
      const key = `${family}\u0000${ch}`;
      let v = cache.get(key);
      if (v === undefined) {
        const usable = GENERIC.has(family) || document.fonts?.check(`16px ${family}`);
        if (usable) {
          ctx.font = `100px ${family}`;
          v = ctx.measureText(ch).width;
        } else {
          v = null;
        }
        cache.set(key, v);
      }
      return v;
    });
  } catch {
    setCharMeasurer(null);
  }
}
