import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseManifest, loadManifest, ManifestError, findManifestPath } from '../dist/index.js';
import { readExampleManifest, examplePath, tmpDir, writeJson } from './helpers.mjs';

const base = () => readExampleManifest();

test('example manifest parses and applies defaults', () => {
  const m = parseManifest(base(), examplePath);
  assert.equal(m.version, 1);
  assert.equal(m.commands.unit.timeoutMs, 60000);
  assert.equal(m.commands.unit.maxOutputBytes, 65536);
  assert.equal(m.claims[0].weight, 1);
  assert.equal(m.claims[2].weight, 2);
  assert.deepEqual(m.claims[0].proofs[0].expect, { exitCode: 0 });
});

test('rejects unsupported manifest version', () => {
  const m = base();
  m.version = 2;
  assert.throws(() => parseManifest(m, examplePath), (e) => e instanceof ManifestError && /version/.test(e.message));
});

test('rejects proofs that reference undeclared commands', () => {
  const m = base();
  m.claims[0].proofs[0].command = 'lint';
  assert.throws(() => parseManifest(m, examplePath), /undeclared command "lint"/);
});

test('rejects duplicate claim ids', () => {
  const m = base();
  m.claims[1].id = m.claims[0].id;
  assert.throws(() => parseManifest(m, examplePath), /duplicate claim id/);
});

test('rejects unknown keys (no silent typos)', () => {
  const m = base();
  m.claims[0].proof = [];
  assert.throws(() => parseManifest(m, examplePath), /Unrecognized key/);
});

test('rejects command cwd that escapes the project root', () => {
  const m = base();
  m.commands.unit.cwd = '../..';
  assert.throws(() => parseManifest(m, examplePath), /escapes the project root/);
});

test('rejects invalid regular expressions and empty file-contains', () => {
  const m = base();
  m.claims[3].proofs[0] = { kind: 'file-contains', file: 'README.md' };
  assert.throws(() => parseManifest(m, examplePath), /needs text or pattern/);
  const m2 = base();
  m2.claims[0].anchors[0] = { file: 'src/calc.js', pattern: '(' };
  assert.throws(() => parseManifest(m2, examplePath), /invalid regular expression/);
});

test('rejects command names and claim ids with unsafe characters', () => {
  const m = base();
  m.commands['unit; rm -rf /'] = m.commands.unit;
  assert.throws(() => parseManifest(m, examplePath));
  const m2 = base();
  m2.claims[0].id = '../evil';
  assert.throws(() => parseManifest(m2, examplePath));
});

test('loadManifest discovers .proofrail/manifest.json and reports missing/invalid JSON', (t) => {
  const dir = tmpDir(t);
  assert.throws(() => loadManifest(dir), /no manifest found/);
  writeJson(path.join(dir, '.proofrail', 'manifest.json'), base());
  assert.equal(findManifestPath(dir), path.join(dir, '.proofrail', 'manifest.json'));
  assert.equal(loadManifest(dir).manifest.name, 'tiny-calc');
  const dir2 = tmpDir(t);
  require_fs().writeFileSync(path.join(dir2, 'proofrail.json'), '{ nope');
  assert.throws(() => loadManifest(dir2), /not valid JSON/);
});

function require_fs() {
  return process.getBuiltinModule('node:fs');
}
