import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProofrailEngine, buildJevRequest, resolveJevConfig, askJev, assessOne, claimSchema } from '../dist/index.js';
import { copyExample, fixturesPath, readExampleManifest, writeJson, examplePath } from './helpers.mjs';

const fake = (name) => path.join(fixturesPath, name);
const cleanEnv = { PATH: process.env.PATH };

test('reports unavailable when no jev command is configured, never fabricating output', async (t) => {
  const root = copyExample(t);
  const engine = new ProofrailEngine({ allowedRoots: [root], env: cleanEnv });
  const r = await engine.verify({ jev: true });
  assert.deepEqual(r.leastProven.jev, { status: 'unavailable', reason: 'no jev command configured (set manifest.jev or PROOFRAIL_JEV_CMD)' });
  assert.match(r.text, /Jev: unavailable \(no jev command configured/);
});

test('builds a TypeSafe-shaped request with state and typed questions', () => {
  const claim = claimSchema.parse(readExampleManifest().claims[2]);
  const a = assessOne(examplePath, claim, new Map());
  const req = buildJevRequest(a, 'jev-latest');
  assert.equal(req.model, 'jev-latest');
  assert.equal(req.state.claim.id, 'percent-rounds-half-up');
  assert.equal(req.state.anchors[0].ref, 'src/calc.js:15-17');
  assert.equal(req.state.proofs[0].status, 'not-run');
  assert.deepEqual(Object.keys(req.questions), ['proof_covers_claim', 'anchors_match_claim', 'best_repair']);
  assert.equal(req.questions.proof_covers_claim.type, 'noul');
  assert.equal(req.questions.best_repair.type, 'choice');
  assert.ok('add_or_fix_test' in req.questions.best_repair.criteria);
});

test('manifest-configured jev command receives the request and its answers are returned verbatim', async (t) => {
  const root = copyExample(t);
  const m = readExampleManifest();
  m.jev = { cmd: process.execPath, args: [fake('fake-jev.mjs')], model: 'jev-test' };
  writeJson(path.join(root, 'proofrail.json'), m);
  const r = await new ProofrailEngine({ allowedRoots: [root], env: cleanEnv }).verify({ jev: true });
  const j = r.leastProven.jev;
  assert.equal(j.status, 'ok');
  assert.equal(j.source, 'manifest');
  assert.equal(j.model, 'jev-test');
  assert.deepEqual(j.answers.proof_covers_claim, { type: 'noul', noul: 0.25 });
  assert.equal(j.answers.best_repair.choice, 'add_or_fix_test');
  assert.match(r.text, /Jev: ok via manifest jev-test: proof_covers_claim=0.25/);
  // deterministic score is untouched by advisory judgments
  assert.equal(r.leastProven.rank.score, 0);
});

test('env-configured jev command overrides the manifest', async (t) => {
  const root = copyExample(t);
  const env = { ...cleanEnv, PROOFRAIL_JEV_CMD: process.execPath, PROOFRAIL_JEV_ARGS: JSON.stringify([fake('fake-jev.mjs')]) };
  const r = await new ProofrailEngine({ allowedRoots: [root], env }).focus({ jev: true });
  assert.equal(r.packet.jev.status, 'ok');
  assert.equal(r.packet.jev.source, 'env');
  const badArgs = resolveJevConfig.bind(null, undefined, { PROOFRAIL_JEV_CMD: 'x', PROOFRAIL_JEV_ARGS: '{"not":"array"}' });
  assert.throws(badArgs, /JSON array/);
  assert.equal(resolveJevConfig(undefined, cleanEnv), null);
});

test('malformed, partial, and failing jev output are reported as errors', async (t) => {
  const root = copyExample(t);
  const claim = claimSchema.parse(readExampleManifest().claims[2]);
  const req = buildJevRequest(assessOne(root, claim, new Map()), 'jev-latest');
  const cfg = (file, extra = {}) => ({ cmd: process.execPath, args: [fake(file)], timeoutMs: 5000, model: 'jev-latest', source: 'manifest', ...extra });

  const bad = await askJev(cfg('fake-jev-bad.mjs'), root, req, cleanEnv);
  assert.equal(bad.status, 'error');
  assert.match(bad.reason, /not print valid JSON/);

  const partial = await askJev(cfg('fake-jev-partial.mjs'), root, req, cleanEnv);
  assert.equal(partial.status, 'error');
  assert.match(partial.reason, /missing answers for: anchors_match_claim, best_repair/);

  const failing = await askJev(cfg('fake-jev-fail.mjs'), root, req, cleanEnv);
  assert.equal(failing.status, 'error');
  assert.match(failing.reason, /exited 3: jev backend down/);

  const missing = await askJev({ ...cfg('x'), cmd: 'proofrail-no-such-jev-binary' }, root, req, cleanEnv);
  assert.equal(missing.status, 'error');
  assert.match(missing.reason, /could not start/);

  const slow = await askJev({ ...cfg('fake-jev-bad.mjs'), cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 30000)'], timeoutMs: 200 }, root, req, cleanEnv);
  assert.equal(slow.status, 'error');
  assert.match(slow.reason, /timed out/);
});

test('jev is not consulted unless requested', async (t) => {
  const root = copyExample(t);
  const env = { ...cleanEnv, PROOFRAIL_JEV_CMD: 'proofrail-no-such-jev-binary' };
  const r = await new ProofrailEngine({ allowedRoots: [root], env }).verify();
  assert.equal(r.leastProven.jev.status, 'unavailable');
  assert.match(r.leastProven.jev.reason, /not requested/);
});
