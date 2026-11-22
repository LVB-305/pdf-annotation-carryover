// Runs before dev/build:
//  1. copies the pdf.js legacy build to public/vendor so it is loaded as a standalone file
//     (not through the bundler) and can be cached offline;
//  2. bundles the service worker (sw/sw.ts) into public/sw.js.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const src = 'node_modules/pdfjs-dist/legacy/build';
mkdirSync('public/vendor', { recursive: true });
// Use .js instead of .mjs so every static host serves it with the correct MIME type.
copyFileSync(`${src}/pdf.min.mjs`, 'public/vendor/pdf.min.js');
copyFileSync(`${src}/pdf.worker.min.mjs`, 'public/vendor/pdf.worker.min.js');

await build({
  entryPoints: ['sw/sw.ts'],
  outfile: 'public/sw.js',
  bundle: true,
  minify: true,
  target: 'es2020',
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
});

console.log('Assets ready: public/vendor/*, public/sw.js');
