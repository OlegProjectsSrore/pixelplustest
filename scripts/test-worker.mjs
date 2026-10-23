import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
const worker = fileURLToPath(new URL('../worker/', import.meta.url));
const tests = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    // The standalone browser suite requires an installed Playwright/browser and has its own command.
    else if (entry.name !== 'audit-browser.test.mjs' && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs'))) tests.push(filename);
  }
}
await collect(path.join(worker, 'test'));
await collect(path.join(worker, 'src'));
await collect(path.join(worker, '../dist/assets'));
await collect(path.join(worker, '../scripts'));
const child = spawn(process.execPath, ['--experimental-transform-types', '--test', '--test-reporter=spec', ...tests.sort()], { cwd: worker, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
