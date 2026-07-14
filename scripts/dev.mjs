import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { context } from 'esbuild';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientSrcDir = resolve(rootDir, 'src', 'client');
const clientDistDir = resolve(rootDir, 'dist', 'client');

await mkdir(clientDistDir, { recursive: true });
await cp(resolve(clientSrcDir, 'index.html'), resolve(clientDistDir, 'index.html'));

const clientContext = await context({
  bundle: true,
  entryPoints: [resolve(clientSrcDir, 'main.ts')],
  format: 'esm',
  outfile: resolve(clientDistDir, 'app.js'),
  loader: { '.ts': 'ts', '.css': 'css' }
});

await clientContext.watch();

const serverProcess = spawn(
  process.execPath,
  [resolve(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'src/server.ts'],
  {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' }
  }
);

const shutdown = async () => {
  serverProcess.kill('SIGINT');
  await clientContext.dispose();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
serverProcess.on('exit', async (code) => {
  await clientContext.dispose();
  process.exit(code ?? 0);
});
