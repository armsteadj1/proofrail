import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAnchor, symbolDeclarationRegex } from '../dist/index.js';
import { tmpDir, examplePath } from './helpers.mjs';

test('resolves JS symbols in the example with exact line ranges and snippets', () => {
  const a = resolveAnchor(examplePath, { file: 'src/calc.js', symbol: 'divide' });
  assert.equal(a.resolved, true);
  assert.equal(a.line, 7);
  assert.equal(a.endLine, 12);
  assert.equal(a.ref, 'src/calc.js:7-12');
  assert.match(a.snippet, /^   7\| export function divide\(a, b\) \{/);
  assert.match(a.snippet, /throw new RangeError/);
});

test('symbol matcher covers common declaration forms across languages', () => {
  const cases = [
    ['export async function fetchUser(id) {', 'fetchUser'],
    ['const parse = (s) => s.trim();', 'parse'],
    ['export const handler = async function () {', 'handler'],
    ['class Ledger {', 'Ledger'],
    ['export interface Packet {', 'Packet'],
    ['type Money = number;', 'Money'],
    ['def compute_total(items):', 'compute_total'],
    ['pub fn render(&self) -> String {', 'render'],
    ['func (s *Server) Start() error {', 'Start'],
    ['  public static int add(int a, int b) {', 'add'],
    ['  async handleClick(event) {', 'handleClick'],
    ['  total: function () {', 'total']
  ];
  for (const [line, symbol] of cases) {
    assert.ok(symbolDeclarationRegex(symbol).test(line), `expected to match ${symbol} in: ${line}`);
  }
  assert.equal(symbolDeclarationRegex('add').test('  const added = add(1, 2);'), false, 'call site must not match');
  assert.equal(symbolDeclarationRegex('add').test('function addAll() {'), false, 'prefix must not match');
});

test('python-style blocks end by indentation', (t) => {
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, 'm.py'), ['import os', '', 'def total(xs):', '    s = 0', '    for x in xs:', '        s += x', '    return s', '', 'def other():', '    pass', ''].join('\n'));
  const a = resolveAnchor(root, { file: 'm.py', symbol: 'total' });
  assert.equal(a.line, 3);
  assert.equal(a.endLine, 7);
});

test('lines and pattern anchors resolve; out-of-range lines fail with a reason', () => {
  const l = resolveAnchor(examplePath, { file: 'src/calc.js', lines: [2, 4] });
  assert.equal(l.ref, 'src/calc.js:2-4');
  const p = resolveAnchor(examplePath, { file: 'src/calc.js', pattern: 'Math\\.round' });
  assert.equal(p.resolved, true);
  assert.equal(p.line, 16);
  const bad = resolveAnchor(examplePath, { file: 'src/calc.js', lines: [1, 999] });
  assert.equal(bad.resolved, false);
  assert.match(bad.reason, /exceeds file length/);
});

test('missing symbol, missing file, and escaping path are reported, never thrown', () => {
  const s = resolveAnchor(examplePath, { file: 'src/calc.js', symbol: 'multiply' });
  assert.equal(s.resolved, false);
  assert.match(s.reason, /symbol "multiply" not found/);
  const f = resolveAnchor(examplePath, { file: 'src/nope.js', symbol: 'add' });
  assert.match(f.reason, /file not found/);
  const e = resolveAnchor(examplePath, { file: '../../package.json', symbol: 'name' });
  assert.equal(e.resolved, false);
  assert.match(e.reason, /outside project root/);
});

test('file-only anchor resolves to the whole file', () => {
  const a = resolveAnchor(examplePath, { file: 'README.md' });
  assert.equal(a.resolved, true);
  assert.equal(a.line, 1);
  assert.ok(a.endLine > 1);
});
