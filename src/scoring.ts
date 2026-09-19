import type { Claim } from './manifest.js';
import type { ResolvedAnchor } from './anchors.js';
import type { ProofResult } from './proofs.js';

export type ClaimStatus = 'proven' | 'partial' | 'pending' | 'unproven' | 'failing';

export interface ClaimAssessment {
  id: string;
  statement: string;
  weight: number;
  tags: string[];
  /** proofScore × anchorFactor, in [0, 1]. */
  score: number;
  /** Weighted fraction of proofs that passed, in [0, 1]. */
  proofScore: number;
  /** Fraction of anchors that resolved (0.5 when no anchors are declared). */
  anchorFactor: number;
  /** weight × (1 − score). Higher means less proven. */
  deficit: number;
  status: ClaimStatus;
  anchors: ResolvedAnchor[];
  proofs: ProofResult[];
  claim: Claim;
}

const STATUS_PRIORITY: Record<ClaimStatus, number> = {
  failing: 0,
  unproven: 1,
  pending: 2,
  partial: 3,
  proven: 4
};

export function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function assessClaim(claim: Claim, anchors: ResolvedAnchor[], proofs: ProofResult[]): ClaimAssessment {
  const totalStrength = proofs.reduce((s, p) => s + p.strength, 0);
  const passedStrength = proofs.reduce((s, p) => s + (p.status === 'passed' ? p.strength : 0), 0);
  const proofScore = totalStrength > 0 ? passedStrength / totalStrength : 0;
  const anchorFactor = anchors.length === 0 ? 0.5 : anchors.filter((a) => a.resolved).length / anchors.length;
  const score = round(proofScore * anchorFactor);
  const deficit = round(claim.weight * (1 - score));

  let status: ClaimStatus;
  const anyFailed = proofs.some((p) => p.status === 'failed') || anchors.some((a) => !a.resolved);
  const anyNotRun = proofs.some((p) => p.status === 'not-run');
  if (score >= 0.9999) status = 'proven';
  else if (anyFailed) status = 'failing';
  else if (score <= 0) status = anyNotRun ? 'pending' : 'unproven';
  else if (anyNotRun) status = 'pending';
  else status = 'partial';

  return {
    id: claim.id,
    statement: claim.statement,
    weight: claim.weight,
    tags: claim.tags,
    score,
    proofScore: round(proofScore),
    anchorFactor: round(anchorFactor),
    deficit,
    status,
    anchors,
    proofs,
    claim
  };
}

/**
 * Deterministic ordering, least proven first:
 * 1. higher deficit (weight × missing proof)
 * 2. status: failing, unproven, pending, partial, proven
 * 3. more unresolved anchors
 * 4. more non-passing proofs
 * 5. claim id, ascending (code-point order)
 */
export function compareLeastProven(a: ClaimAssessment, b: ClaimAssessment): number {
  if (a.deficit !== b.deficit) return b.deficit - a.deficit;
  const sp = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
  if (sp !== 0) return sp;
  const ua = a.anchors.filter((x) => !x.resolved).length;
  const ub = b.anchors.filter((x) => !x.resolved).length;
  if (ua !== ub) return ub - ua;
  const pa = a.proofs.filter((x) => x.status !== 'passed').length;
  const pb = b.proofs.filter((x) => x.status !== 'passed').length;
  if (pa !== pb) return pb - pa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankClaims(assessments: ClaimAssessment[]): ClaimAssessment[] {
  return [...assessments].sort(compareLeastProven);
}
