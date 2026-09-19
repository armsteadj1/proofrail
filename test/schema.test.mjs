import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers.mjs';

test('committed JSON schema matches the zod manifest schema', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-schema.mjs', '--check'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schema', 'proofrail.schema.json'), 'utf8'));
  assert.equal(schema.properties.version.const, 1);
  assert.deepEqual(schema.required.sort(), ['claims', 'version']);
});

test('package manifest ships the CLI, dist, and schema', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.proofrail, 'dist/cli.js');
  assert.ok(pkg.files.includes('dist') && pkg.files.includes('schema'));
  assert.equal(pkg.scripts.prepare, 'npm run build', 'prepare must build so npx from GitHub works');
  assert.equal(pkg.type, 'module');
});
