// MapLibre 6 loads its web worker from a file next to its own module (import.meta.url). Once Next.js
// bundles MapLibre into a chunk that file is not there, so maps stay blank ("Worker failed to load").
// Copy the worker (+ the shared module it imports) into public/ and point MapLibre at it (setWorkerUrl).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/package.json')) + '/dist';
const out = join(here, '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(join(dist, f), join(out, f));
console.log(`maplibre worker copied to ${out}`);
