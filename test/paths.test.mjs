import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside, realInside, readTextInside, isInside, normalizeRoot, PathEscapeError } from '../dist/index.js';
import { tmpDir } from './helpers.mjs';

test('resolveInside keeps relative paths inside the root and rejects escapes', (t) => {
  const root = tmpDir(t);
  assert.equal(resolveInside(root, 'src/a.js'), path.join(root, 'src', 'a.js'));
  assert.equal(resolveInside(root, '.'), root);
  assert.throws(() => resolveInside(root, '../outside'), PathEscapeError);
  assert.throws(() => resolveInside(root, 'a/../../b'), PathEscapeError);
  assert.throws(() => resolveInside(root, '/etc/passwd'), PathEscapeError);
  assert.throws(() => resolveInside(root, 'a\0b'), PathEscapeError);
  assert.equal(resolveInside(root, path.join(root, 'ok.txt')), path.join(root, 'ok.txt'));
});

test('isInside treats sibling directories with a shared prefix as outside', (t) => {
  const root = tmpDir(t);
  assert.equal(isInside(root, `${root}-sibling/file`), false);
  assert.equal(isInside(root, root), true);
});

test('realInside blocks symlinks that point outside the root', (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  assert.throws(() => realInside(root, 'link.txt'), PathEscapeError);
  assert.throws(() => readTextInside(root, 'link.txt'), PathEscapeError);
  assert.equal(realInside(root, 'missing.txt'), null);
  fs.writeFileSync(path.join(root, 'inside.txt'), 'hi');
  assert.equal(readTextInside(root, 'inside.txt'), 'hi');
  assert.equal(readTextInside(root, 'missing.txt'), null);
});

test('readTextInside caps bytes read and returns null for directories', (t) => {
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(100));
  assert.equal(readTextInside(root, 'big.txt', 10).length, 10);
  fs.mkdirSync(path.join(root, 'dir'));
  assert.equal(readTextInside(root, 'dir'), null);
});

test('normalizeRoot requires an existing directory', (t) => {
  const root = tmpDir(t);
  assert.equal(normalizeRoot(root), root);
  assert.throws(() => normalizeRoot(path.join(root, 'nope')));
  fs.writeFileSync(path.join(root, 'file'), '');
  assert.throws(() => normalizeRoot(path.join(root, 'file')), /not a directory/);
});
