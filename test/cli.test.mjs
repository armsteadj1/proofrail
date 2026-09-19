import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliPath, examplePath, copyExample, addPercentTest, repoRoot } from './helpers.mjs';

const run = (args, cwd = repoRoot) => spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });

test('--version and --help', () => {
  const v = run(['--version']);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version);
  const h = run(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Start the stdio MCP server/);
});

test('validate prints the manifest summary', () => {
  const r = run(['validate', examplePath, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.name, 'tiny-calc');
  assert.deepEqual(out.commands, { unit: 'node --test test/calc.test.js' });
  assert.equal(out.claims.length, 4);
});

test('verify exits 1 while a claim is unproven and 0 once all are proven', (t) => {
  const r = run(['verify', examplePath, '--json']);
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.leastProven.claim.id, 'percent-rounds-half-up');
  assert.equal(out.text, undefined, 'json output omits the text rendering');

  const root = copyExample(t);
  addPercentTest(root);
  fs.appendFileSync(path.join(root, 'test', 'calc.test.js'), "\ntest('divide by zero throws', () => { assert.throws(() => divide(1, 0), RangeError); });\n");
  const ok = run(['verify', root]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /All 4 claims proven/);
});

test('recheck and focus from the CLI', (t) => {
  const root = copyExample(t);
  const before = run(['recheck', 'percent-rounds-half-up', root]);
  assert.equal(before.status, 1);
  assert.match(before.stdout, /NOT YET/);
  addPercentTest(root);
  const after = run(['recheck', 'percent-rounds-half-up', root, '--json']);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).satisfied, true);
  const focus = run(['focus', root, '--claim', 'divide-documented', '--run', 'never']);
  assert.equal(focus.status, 0);
  assert.match(focus.stdout, /divide-documented — proven/);
});

test('usage errors exit 2 with a message on stderr', () => {
  assert.equal(run(['bogus']).status, 2);
  const r = run(['recheck']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a claim id/);
  const m = run(['verify', repoRoot]);
  assert.equal(m.status, 2);
  assert.match(m.stderr, /no manifest found/);
  const f = run(['focus', examplePath, '--run', 'maybe']);
  assert.equal(f.status, 2);
});
