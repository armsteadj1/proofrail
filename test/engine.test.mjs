import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProofrailEngine, ProofrailError } from '../dist/index.js';
import { copyExample, addPercentTest, tmpDir, examplePath, writeJson, readExampleManifest } from './helpers.mjs';

test('verify returns the least-proven claim from the example fixture', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const r = await engine.verify();
  assert.equal(r.ran, true);
  assert.equal(r.allProven, false);
  assert.deepEqual(r.ranking.map((x) => x.id), ['percent-rounds-half-up', 'divide-rejects-zero', 'add-commutative', 'divide-documented']);
  assert.deepEqual(r.runs.map((x) => [x.command, x.exitCode, x.cached]), [['unit', 0, false]]);
  assert.deepEqual(r.ranking.map((x) => x.status), ['failing', 'failing', 'proven', 'proven']);

  const p = r.leastProven;
  assert.equal(p.claim.id, 'percent-rounds-half-up');
  assert.equal(p.rank.position, 1);
  assert.equal(p.rank.of, 4);
  assert.equal(p.rank.status, 'failing');
  assert.equal(p.rank.score, 0);
  assert.equal(p.rank.deficit, 2);
  assert.equal(p.anchors[0].ref, 'src/calc.js:15-17');
  assert.match(p.anchors[0].snippet, /Math\.round/);
  assert.equal(p.missingProof.length, 2);
  assert.equal(p.missingProof[0].kind, 'command');
  assert.equal(p.missingProof[0].status, 'failed');
  assert.match(p.missingProof[0].detail, /output lacks "percent rounds half up"/);
  assert.match(p.missingProof[0].howToSatisfy, /output including "percent rounds half up"/);
  assert.equal(p.missingProof[1].status, 'unverifiable');
  assert.deepEqual(p.reproducer, { cmd: 'node', args: ['--test', 'test/calc.test.js'], cwd: '.', display: 'node --test test/calc.test.js', source: 'manifest' });
  assert.match(p.done, /all 1 proof for "percent-rounds-half-up" pass/);
  assert.match(p.next, /output including "percent rounds half up"/);
  assert.deepEqual(p.jev, { status: 'unavailable', reason: 'not requested (pass jev=true)' });
  assert.match(r.text, /Proofrail packet 1\/4: percent-rounds-half-up/);
  assert.match(r.text, /src\/calc.js:15-17 percent/);
});

test('second-ranked claim packet explains the missing static test proof', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const f = await engine.focus({ claimId: 'divide-rejects-zero' });
  assert.equal(f.packet.rank.position, 2);
  assert.equal(f.packet.rank.score, 0.4);
  assert.equal(f.packet.evidence.length, 1);
  assert.match(f.packet.evidence[0].detail, /contains \/throw new RangeError\//);
  assert.match(f.packet.missingProof[0].detail, /no test named "divide by zero throws"/);
  assert.equal(f.packet.done, 'A test named "divide by zero throws" exists and asserts RangeError.');
  assert.equal(f.packet.reproducer, null, 'no executable proof declared for this claim');
});

test('verify with run=false never executes and reports dynamic proofs as not-run', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const r = await engine.verify({ run: false });
  assert.equal(r.runs.length, 0);
  const percent = r.ranking.find((x) => x.id === 'percent-rounds-half-up');
  assert.equal(percent.status, 'pending');
  assert.equal(r.leastProven.claim.id, 'percent-rounds-half-up');
  assert.equal(r.leastProven.missingProof[0].status, 'not-run');
});

test('recheck runs only that claim\'s commands and reports satisfied after the fix', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const before = await engine.recheck({ claimId: 'percent-rounds-half-up' });
  assert.equal(before.satisfied, false);
  assert.deepEqual(before.nextLeastProven.id, 'divide-rejects-zero');

  addPercentTest(root);
  const after = await engine.recheck({ claimId: 'percent-rounds-half-up' });
  assert.equal(after.satisfied, true);
  assert.equal(after.packet.rank.status, 'proven');
  assert.equal(after.packet.rank.score, 1);
  assert.deepEqual(after.packet.missingProof.map((m) => m.status), ['unverifiable'], 'manual notes stay listed as unverifiable');
  assert.deepEqual(after.runs.map((x) => x.command), ['unit'], 'only the claim\'s own command was re-run');
});

test('recheck on a fully static claim runs nothing and detects the added test', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const before = await engine.recheck({ claimId: 'divide-rejects-zero' });
  assert.equal(before.runs.length, 0);
  assert.equal(before.satisfied, false);
  fs.appendFileSync(path.join(root, 'test', 'calc.test.js'), "\ntest('divide by zero throws', () => { assert.throws(() => divide(1, 0), RangeError); });\n");
  const after = await engine.recheck({ claimId: 'divide-rejects-zero' });
  assert.equal(after.satisfied, true);
  assert.equal(after.nextLeastProven.id, 'percent-rounds-half-up');
});

test('focus reuses cached runs and only runs when nothing is cached', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const first = await engine.focus();
  assert.equal(first.usedCachedRuns, false);
  assert.equal(first.packet.claim.id, 'percent-rounds-half-up');
  const second = await engine.focus();
  assert.equal(second.usedCachedRuns, true);
  const never = await new ProofrailEngine({ allowedRoots: [root] }).focus({ run: 'never' });
  assert.equal(never.packet.missingProof[0].status, 'not-run');
  const always = await engine.focus({ run: 'always' });
  assert.equal(always.usedCachedRuns, false);
});

test('editing the manifest invalidates the cached session', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  await engine.verify();
  const m = readExampleManifest();
  m.name = 'renamed';
  writeJson(path.join(root, 'proofrail.json'), m);
  const r = await engine.verify({ run: false });
  assert.equal(r.manifest.name, 'renamed');
  assert.equal(r.runs.length, 0, 'runs from the old manifest must not be reused');
});

test('all-proven manifest returns no packet', async (t) => {
  const root = copyExample(t);
  addPercentTest(root);
  fs.appendFileSync(path.join(root, 'test', 'calc.test.js'), "\ntest('divide by zero throws', () => { assert.throws(() => divide(1, 0), RangeError); });\n");
  const r = await new ProofrailEngine({ allowedRoots: [root] }).verify();
  assert.equal(r.allProven, true);
  assert.equal(r.leastProven, null);
  assert.match(r.summary, /All 4 claims proven/);
});

test('unresolved anchors after a refactor surface as the next step', async (t) => {
  const root = copyExample(t);
  addPercentTest(root);
  const calc = path.join(root, 'src', 'calc.js');
  fs.writeFileSync(calc, fs.readFileSync(calc, 'utf8').replace('export function percent(', 'export function pct('));
  fs.writeFileSync(path.join(root, 'test', 'calc.test.js'), fs.readFileSync(path.join(root, 'test', 'calc.test.js'), 'utf8').replaceAll('percent(', 'pct(').replace('divide, percent }', 'divide, pct as percent }'));
  const r = await new ProofrailEngine({ allowedRoots: [root] }).verify({ claimIds: ['percent-rounds-half-up'] });
  const p = r.leastProven;
  assert.equal(p.rank.status, 'failing');
  assert.equal(p.anchors[0].resolved, false);
  assert.match(p.next, /Fix anchor src\/calc.js#percent/);
});

test('claimIds restricts verification and rejects unknown ids', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  const r = await engine.verify({ claimIds: ['divide-documented'] });
  assert.equal(r.runs.length, 0, 'static-only claim needs no commands');
  assert.equal(r.allProven, true);
  await assert.rejects(() => engine.verify({ claimIds: ['nope'] }), /unknown claim id "nope"/);
  await assert.rejects(() => engine.recheck({ claimId: 'nope' }), ProofrailError);
});

test('projectRoot must be inside an allowed root', async (t) => {
  const root = copyExample(t);
  const other = tmpDir(t);
  const engine = new ProofrailEngine({ allowedRoots: [root] });
  await assert.rejects(() => engine.verify({ projectRoot: other }), /outside the allowed roots/);
  await assert.rejects(() => engine.verify({ projectRoot: '../' }), /outside the allowed roots/);
  await assert.rejects(() => engine.verify({ projectRoot: 'does-not-exist' }), /not usable/);
  // subdirectory of an allowed root is fine, and relative paths resolve against the first root
  fs.mkdirSync(path.join(root, 'nested'));
  fs.cpSync(examplePath, path.join(root, 'nested'), { recursive: true });
  const r = await engine.verify({ projectRoot: 'nested', run: false });
  assert.equal(r.projectRoot, path.join(root, 'nested'));
});

test('missing or broken manifest is a ProofrailError, not a crash', async (t) => {
  const dir = tmpDir(t);
  const engine = new ProofrailEngine({ allowedRoots: [dir] });
  await assert.rejects(() => engine.verify(), (e) => e instanceof ProofrailError && /no manifest found/.test(e.message));
  writeJson(path.join(dir, 'proofrail.json'), { version: 1, claims: [] });
  await assert.rejects(() => engine.verify(), /invalid manifest/);
});

test('a declared command that cannot start is reported as unavailable', async (t) => {
  const dir = tmpDir(t);
  writeJson(path.join(dir, 'proofrail.json'), {
    version: 1,
    commands: { ghost: { cmd: 'proofrail-no-such-binary-abc' } },
    claims: [{ id: 'c', statement: 's', proofs: [{ kind: 'command', command: 'ghost' }] }]
  });
  const r = await new ProofrailEngine({ allowedRoots: [dir] }).verify();
  assert.equal(r.runs[0].spawnError !== undefined, true);
  assert.equal(r.leastProven.missingProof[0].status, 'unavailable');
  assert.match(r.leastProven.missingProof[0].detail, /could not start/);
});

test('a focused command can prove its exact test without reporter output', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'subject.test.js'), "test('the focused case', () => {});\n");
  writeJson(path.join(dir, 'proofrail.json'), {
    version: 1,
    commands: {
      focused: {
        cmd: process.execPath,
        args: ['-e', 'console.log("1 passed, 83 skipped")'],
        focusedTest: { file: 'subject.test.js', name: 'the focused case' }
      }
    },
    claims: [{
      id: 'focused-case',
      statement: 'The focused case works.',
      anchors: [{ file: 'subject.test.js', pattern: 'the focused case' }],
      proofs: [{ kind: 'test', file: 'subject.test.js', name: 'the focused case', command: 'focused' }]
    }]
  });
  const r = await new ProofrailEngine({ allowedRoots: [dir] }).verify();
  assert.equal(r.allProven, true);
});

test('a generic green command still cannot prove an unreported test', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'subject.test.js'), "test('the unreported case', () => {});\n");
  writeJson(path.join(dir, 'proofrail.json'), {
    version: 1,
    commands: { generic: { cmd: process.execPath, args: ['-e', 'console.log("all tests passed")'] } },
    claims: [{
      id: 'unreported-case',
      statement: 'The unreported case works.',
      anchors: [{ file: 'subject.test.js', pattern: 'the unreported case' }],
      proofs: [{ kind: 'test', file: 'subject.test.js', name: 'the unreported case', command: 'generic' }]
    }]
  });
  const r = await new ProofrailEngine({ allowedRoots: [dir] }).verify();
  assert.equal(r.allProven, false);
  assert.equal(r.leastProven.missingProof[0].status, 'failed');
  assert.match(r.leastProven.missingProof[0].detail, /output never mentions/);
});
