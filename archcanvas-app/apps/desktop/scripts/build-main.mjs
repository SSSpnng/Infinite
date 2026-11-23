import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

await esbuild.build({
  entryPoints: [path.join(desktopDir, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(desktopDir, 'dist/main/index.cjs'),
  external: ['electron'],
  sourcemap: true,
});

await esbuild.build({
  entryPoints: [path.join(desktopDir, 'src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(desktopDir, 'dist/preload/index.cjs'),
  external: ['electron'],
  sourcemap: true,
});

// Copy sql-wasm.wasm next to dist/main so Electron packaged/unpacked finds it deterministically
const wasmCandidates = [
  path.join(desktopDir, 'node_modules/sql.js/dist/sql-wasm.wasm'),
  path.resolve(desktopDir, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
];
for (const candidate of wasmCandidates) {
  if (fs.existsSync(candidate)) {
    fs.copyFileSync(candidate, path.join(desktopDir, 'dist/main/sql-wasm.wasm'));
    break;
  }
}

console.log('Built Electron main & preload bundles.');
