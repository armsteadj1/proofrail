import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDeclaredCommand, commandSchema } from '../dist/index.js';
import { tmpDir } from './helpers.mjs';

const spec = (o) => commandSchema.parse(o);

test('runs a declared command with captured stdout/stderr and exit code', async (t) => {
  const root = tmpDir(t);
  const r = await runDeclaredCommand(root, 'hello', spec({ cmd: process.execPath, args: ['-e', 'console.log("hi"); console.error("err"); process.exit(3)'] }));
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout.trim(), 'hi');
  assert.equal(r.stderr.trim(), 'err');
  assert.equal(r.command, 'hello');
  assert.equal(r.cwd, root);
  assert.equal(r.truncated, false);
});

test('never uses a shell: metacharacters are passed literally', async (t) => {
  const root = tmpDir(t);
  const r = await runDeclaredCommand(root, 'echo', spec({ cmd: process.execPath, args: ['-e', 'console.log(process.argv[1])', '$HOME; echo pwned | cat'] }));
  assert.equal(r.stdout.trim(), '$HOME; echo pwned | cat');
});

test('caps output at maxOutputBytes and flags truncation', async (t) => {
  const root = tmpDir(t);
  const r = await runDeclaredCommand(root, 'spam', spec({ cmd: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(200000))'], maxOutputBytes: 1024 }));
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 1200, `stdout length ${r.stdout.length}`);
  assert.match(r.stdout, /output truncated at 1024 bytes/);
  assert.equal(r.exitCode, 0);
});

test('kills the process on timeout', async (t) => {
  const root = tmpDir(t);
  const r = await runDeclaredCommand(root, 'sleep', spec({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 300 }));
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
  assert.ok(r.durationMs < 10000);
});

test('reports a spawn error instead of throwing for a missing executable', async (t) => {
  const root = tmpDir(t);
  const r = await runDeclaredCommand(root, 'ghost', spec({ cmd: 'proofrail-definitely-not-installed-xyz' }));
  assert.equal(r.exitCode, null);
  assert.match(r.spawnError, /ENOENT/);
});

test('harness protocol variables are scrubbed from the child environment', async (t) => {
  const root = tmpDir(t);
  const r = await runDeclaredCommand(root, 'env', spec({ cmd: process.execPath, args: ['-e', 'console.log(JSON.stringify([process.env.NODE_TEST_CONTEXT ?? null, process.env.KEEP]))'] }), { env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child-v8', KEEP: '1' } });
  assert.deepEqual(JSON.parse(r.stdout), [null, '1']);
});

test('cwd is resolved inside the root and env is merged', async (t) => {
  const root = tmpDir(t);
  const fs = process.getBuiltinModule('node:fs');
  fs.mkdirSync(`${root}/sub`);
  const r = await runDeclaredCommand(root, 'where', spec({ cmd: process.execPath, args: ['-e', 'console.log(process.cwd(), process.env.PROOFRAIL_T)'], cwd: 'sub', env: { PROOFRAIL_T: 'yes' } }));
  assert.equal(r.stdout.trim(), `${root}/sub yes`);
  await assert.rejects(() => runDeclaredCommand(root, 'esc', spec({ cmd: process.execPath, args: ['-v'], cwd: '../' })), /outside project root/);
});
