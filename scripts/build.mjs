import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(rootDir, 'dist');
const clientSrcDir = resolve(rootDir, 'src', 'client');
const clientDistDir = resolve(distDir, 'client');

const typecheck = spawnSync(
  process.execPath,
  [resolve(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'],
  { cwd: rootDir, stdio: 'inherit' }
);

if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1);
}

await mkdir(clientDistDir, { recursive: true });

await build({
  bundle: true,
  entryPoints: [resolve(clientSrcDir, 'main.ts')],
  format: 'esm',
  outfile: resolve(clientDistDir, 'app.js'),
  loader: { '.ts': 'ts', '.css': 'css' }
});

await cp(resolve(clientSrcDir, 'index.html'), resolve(clientDistDir, 'index.html'));

await build({
  bundle: true,
  entryPoints: [resolve(rootDir, 'src', 'server.ts')],
  format: 'cjs',
  outfile: resolve(distDir, 'server.cjs'),
  platform: 'node',
  target: 'node18',
  loader: { '.ts': 'ts' }
});
