'use client';

import { useEffect } from 'react';
import { asset } from '@/lib/config';
import { loadPdfLib, loadPdfjs, openPdf } from '@/lib/loaders';

/**
 * Registers the service worker for offline use. Once active, pdf.js, its worker, and pdf-lib are
 * loaded in the background so their lazy-loaded files enter the cache and processing can continue
 * without internet access. Failures are harmless: the app simply continues online.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
    let cancelled = false;
    (async () => {
      await navigator.serviceWorker.register(asset('/sw.js'), { scope: asset('/') || '/' });
      await navigator.serviceWorker.ready;
      if (cancelled) return;
      await Promise.all([loadPdfjs(), loadPdfLib()]);
      // Opening an empty PDF also starts the pdf.js worker so it enters the cache.
      const empty = new TextEncoder().encode('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>');
      await openPdf(empty).catch(() => {});
    })().catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return null;
}
