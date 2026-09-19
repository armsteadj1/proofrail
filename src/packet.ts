import type { ClaimAssessment } from './scoring.js';
import type { ResolvedAnchor } from './anchors.js';
import type { ProofResult } from './proofs.js';
import type { Manifest } from './manifest.js';
import type { JevReport } from './jev.js';
import { describeJev } from './jev.js';
import { toPosixRelative } from './paths.js';
import path from 'node:path';

export interface Reproducer {
  cmd: string;
  args: string[];
  cwd: string;
  /** Shell-style rendering for humans; the agent should prefer cmd/args. */
  display: string;
  source: 'manifest' | 'derived';
}

export interface RepairPacket {
  claim: { id: string; statement: string; weight: number; tags: string[] };
  rank: { position: number; of: number; score: number; deficit: number; status: ClaimAssessment['status'] };
  anchors: ResolvedAnchor[];
  missingProof: { kind: ProofResult['kind']; status: ProofResult['status']; detail: string; howToSatisfy: string; command?: string }[];
  evidence: { kind: ProofResult['kind']; detail: string }[];
  reproducer: Reproducer | null;
  done: string;
  next: string;
  jev: JevReport;
}

function quoteArg(a: string): string {
  return /^[A-Za-z0-9_./:=@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function deriveReproducer(a: ClaimAssessment, manifest: Manifest, root: string): Reproducer | null {
  const c = a.claim;
  const firstDynamic = c.proofs.find((p) => p.kind === 'command' || (p.kind === 'test' && p.command !== undefined));
  const cmdName = firstDynamic?.kind === 'command' ? firstDynamic.command : firstDynamic?.kind === 'test' ? firstDynamic.command : undefined;
  const spec = cmdName !== undefined ? manifest.commands[cmdName] : undefined;
  if (c.reproducer !== undefined) {
    return {
      cmd: spec?.cmd ?? '',
      args: spec?.args ?? [],
      cwd: spec?.cwd ? toPosixRelative(root, path.resolve(root, spec.cwd)) || '.' : '.',
      display: c.reproducer,
      source: 'manifest'
    };
  }
  if (spec === undefined) return null;
  const cwd = spec.cwd ? toPosixRelative(root, path.resolve(root, spec.cwd)) || '.' : '.';
  return {
    cmd: spec.cmd,
    args: spec.args,
    cwd,
    display: [spec.cmd, ...spec.args].map(quoteArg).join(' '),
    source: 'derived'
  };
}

export function deriveDone(a: ClaimAssessment): string {
  if (a.claim.done !== undefined) return a.claim.done;
  const nAnchors = a.anchors.length;
  const nProofs = a.proofs.filter((p) => p.kind !== 'manual').length;
  const parts: string[] = [];
  if (nProofs > 0) parts.push(`all ${nProofs} proof${nProofs === 1 ? '' : 's'} for "${a.id}" pass`);
  else parts.push(`"${a.id}" has at least one executable proof that passes`);
  if (nAnchors > 0) parts.push(`all ${nAnchors} anchor${nAnchors === 1 ? '' : 's'} resolve`);
  return `${parts.join(' and ')} (score 1.0 on recheck).`;
}

function suggestNext(a: ClaimAssessment, missing: RepairPacket['missingProof']): string {
  const unresolved = a.anchors.find((x) => !x.resolved);
  if (unresolved) return `Fix anchor ${unresolved.file}${unresolved.symbol ? `#${unresolved.symbol}` : ''}: ${unresolved.reason ?? 'unresolved'}.`;
  const first = missing[0];
  if (first === undefined) return `Claim "${a.id}" is proven; move to the next least-proven claim.`;
  return first.howToSatisfy;
}

export function buildPacket(
  a: ClaimAssessment,
  position: number,
  of: number,
  manifest: Manifest,
  root: string,
  jev: JevReport
): RepairPacket {
  const missingProof = a.proofs
    .filter((p) => p.status !== 'passed')
    .map((p) => ({
      kind: p.kind,
      status: p.status,
      detail: p.detail,
      howToSatisfy: p.howToSatisfy,
      ...(p.command !== undefined ? { command: p.command } : {})
    }));
  const evidence = a.proofs.filter((p) => p.status === 'passed').map((p) => ({ kind: p.kind, detail: p.detail }));
  return {
    claim: { id: a.id, statement: a.statement, weight: a.weight, tags: a.tags },
    rank: { position, of, score: a.score, deficit: a.deficit, status: a.status },
    anchors: a.anchors,
    missingProof,
    evidence,
    reproducer: deriveReproducer(a, manifest, root),
    done: deriveDone(a),
    next: suggestNext(a, missingProof),
    jev
  };
}

export function renderPacket(p: RepairPacket): string {
  const lines: string[] = [];
  lines.push(`Proofrail packet ${p.rank.position}/${p.rank.of}: ${p.claim.id} — ${p.rank.status}, score ${p.rank.score.toFixed(2)}, deficit ${p.rank.deficit.toFixed(2)}`);
  lines.push(`Claim: ${p.claim.statement}`);
  lines.push('Anchors:');
  if (p.anchors.length === 0) lines.push('  (none declared — claim is not source-grounded)');
  for (const a of p.anchors) {
    if (a.resolved) {
      lines.push(`  - ${a.ref}${a.symbol ? ` ${a.symbol}` : ''}`);
      if (a.snippet) lines.push(a.snippet.split('\n').map((l) => `      ${l}`).join('\n'));
    } else {
      lines.push(`  - UNRESOLVED ${a.file}${a.symbol ? `#${a.symbol}` : ''}: ${a.reason ?? ''}`);
    }
  }
  lines.push('Missing proof:');
  if (p.missingProof.length === 0) lines.push('  (none)');
  for (const m of p.missingProof) lines.push(`  - [${m.kind}/${m.status}] ${m.detail}\n    → ${m.howToSatisfy}`);
  if (p.evidence.length > 0) {
    lines.push('Evidence:');
    for (const e of p.evidence) lines.push(`  - [${e.kind}] ${e.detail}`);
  }
  lines.push(`Reproduce: ${p.reproducer ? `${p.reproducer.display} (cwd ${p.reproducer.cwd})` : 'no executable proof declared'}`);
  lines.push(`Done when: ${p.done}`);
  lines.push(`Next: ${p.next}`);
  lines.push(`Jev: ${describeJev(p.jev)}`);
  return lines.join('\n');
}
