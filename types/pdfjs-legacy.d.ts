// Minimal typing for the pdf.js legacy build, used only in the Node tests.
// In the app, pdf.js is loaded as a standalone file (see lib/loaders.ts) and typed through lib/core.ts.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(src: { data: Uint8Array; [key: string]: unknown }): {
    promise: Promise<unknown>;
  };
}
