import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessClaim, rankClaims, claimSchema, STRENGTH } from '../dist/index.js';

const claim = (o) => claimSchema.parse({ statement: 's', ...o });
const anchor = (resolved) => ({ file: 'f', resolved, ref: 'f' });
const proof = (kind, status, strength) => ({ index: 0, kind, status, strength, detail: '', howToSatisfy: '' });

test('score is weighted proof pass rate times anchor coverage', () => {
  const a = assessClaim(
    claim({ id: 'a' }),
    [anchor(true), anchor(false)],
    [proof('command', 'passed', STRENGTH.command), proof('file-contains', 'failed', STRENGTH.fileContains)]
  );
  assert.equal(a.proofScore, 1 / 1.4 > 0.71 ? +(1 / 1.4).toFixed(4) : 0);
  assert.equal(a.anchorFactor, 0.5);
  assert.equal(a.score, +((1 / 1.4) * 0.5).toFixed(4));
  assert.equal(a.status, 'failing');
});

test('manual proofs never count; no anchors halves the score', () => {
  const only = assessClaim(claim({ id: 'm' }), [anchor(true)], [proof('manual', 'unverifiable', 0)]);
  assert.equal(only.score, 0);
  assert.equal(only.status, 'unproven');
  const noAnchor = assessClaim(claim({ id: 'n' }), [], [proof('command', 'passed', 1)]);
  assert.equal(noAnchor.score, 0.5);
  assert.equal(noAnchor.status, 'partial');
});

test('status reflects pending runs, failures, and full proof', () => {
  assert.equal(assessClaim(claim({ id: 'p' }), [anchor(true)], [proof('command', 'not-run', 1)]).status, 'pending');
  assert.equal(assessClaim(claim({ id: 'q' }), [anchor(true)], [proof('command', 'passed', 1)]).status, 'proven');
  assert.equal(assessClaim(claim({ id: 'r' }), [anchor(false)], [proof('command', 'passed', 1)]).status, 'failing');
  assert.equal(assessClaim(claim({ id: 's' }), [anchor(true)], [proof('command', 'passed', 1), proof('command', 'not-run', 1)]).status, 'pending');
});

test('deficit scales with weight', () => {
  const light = assessClaim(claim({ id: 'l', weight: 1 }), [anchor(true)], [proof('command', 'failed', 1)]);
  const heavy = assessClaim(claim({ id: 'h', weight: 3 }), [anchor(true)], [proof('command', 'failed', 1)]);
  assert.equal(light.deficit, 1);
  assert.equal(heavy.deficit, 3);
});

test('ranking is deterministic: deficit, status, unresolved anchors, then id', () => {
  const failing = assessClaim(claim({ id: 'zeta' }), [anchor(true)], [proof('command', 'failed', 1)]);
  const pending = assessClaim(claim({ id: 'alpha' }), [anchor(true)], [proof('command', 'not-run', 1)]);
  const unanchored = assessClaim(claim({ id: 'beta' }), [anchor(false)], [proof('command', 'not-run', 1)]);
  const proven = assessClaim(claim({ id: 'gamma' }), [anchor(true)], [proof('command', 'passed', 1)]);
  const tieA = assessClaim(claim({ id: 'tie-b' }), [anchor(true)], [proof('command', 'failed', 1)]);
  const tieB = assessClaim(claim({ id: 'tie-a' }), [anchor(true)], [proof('command', 'failed', 1)]);
  // half proven but weight 3 → deficit 1.5, the largest
  const heavy = assessClaim(claim({ id: 'omega', weight: 3 }), [anchor(true)], [proof('command', 'passed', 1), proof('command', 'failed', 1)]);
  const input = [proven, tieA, pending, heavy, failing, unanchored, tieB];
  const ids = rankClaims(input).map((a) => a.id);
  // omega: deficit 1.5. beta/tie-a/tie-b/zeta: deficit 1, failing; beta first (unresolved anchor), then id order.
  // alpha: deficit 1 but pending sorts after failing. gamma: deficit 0.
  assert.deepEqual(ids, ['omega', 'beta', 'tie-a', 'tie-b', 'zeta', 'alpha', 'gamma']);
  // stable regardless of input order
  assert.deepEqual(rankClaims([...input].reverse()).map((a) => a.id), ids);
});
