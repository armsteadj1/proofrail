// Portable test runner: node --test with an explicit file list (Node 20 does
// not expand globs and Node 21+ rejects bare directories).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve('test');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(dir, f));
const extra = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', ...extra, ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
