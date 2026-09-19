import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadManifest, ManifestError, type Manifest, type Claim } from './manifest.js';
import { normalizeRoot, isInside, toPosixRelative } from './paths.js';
import { runDeclaredCommand, type RunResult } from './runner.js';
import { resolveAnchor } from './anchors.js';
import { evaluateProof, commandsNeededByProof } from './proofs.js';
import { assessClaim, rankClaims, type ClaimAssessment } from './scoring.js';
import { buildPacket, renderPacket, type RepairPacket } from './packet.js';
import { askJev, buildJevRequest, resolveJevConfig, type JevReport } from './jev.js';

export interface EngineOptions {
  /** Directories that tool calls may target. Any requested projectRoot must be inside one. */
  allowedRoots: string[];
  env?: NodeJS.ProcessEnv;
}

export interface RunSummary {
  command: string;
  display: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  spawnError?: string;
  cached: boolean;
}

export interface RankingEntry {
  position: number;
  id: string;
  status: ClaimAssessment['status'];
  score: number;
  deficit: number;
  weight: number;
  proofs: { passed: number; total: number };
  anchors: { resolved: number; total: number };
}

export interface VerifyResult {
  projectRoot: string;
  manifest: { file: string; name?: string; version: number; claims: number; commands: string[] };
  ran: boolean;
  runs: RunSummary[];
  ranking: RankingEntry[];
  leastProven: RepairPacket | null;
  allProven: boolean;
  summary: string;
  text: string;
}

export interface FocusResult {
  projectRoot: string;
  packet: RepairPacket;
  ranking: RankingEntry[];
  usedCachedRuns: boolean;
  text: string;
}

export interface RecheckResult {
  projectRoot: string;
  claimId: string;
  satisfied: boolean;
  packet: RepairPacket;
  runs: RunSummary[];
  nextLeastProven: { id: string; status: ClaimAssessment['status']; score: number; deficit: number } | null;
  ranking: RankingEntry[];
  text: string;
}

interface Session {
  manifestHash: string;
  runs: Map<string, RunResult>;
  lastVerifiedAt: string;
}

export class ProofrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofrailError';
  }
}

export class ProofrailEngine {
  readonly allowedRoots: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, Session>();

  constructor(options: EngineOptions) {
    if (options.allowedRoots.length === 0) throw new Error('at least one allowed root is required');
    this.allowedRoots = options.allowedRoots.map(normalizeRoot);
    this.env = options.env ?? process.env;
  }

  /** Resolve a requested project root against the allow-list. */
  resolveRoot(requested?: string): string {
    const base = this.allowedRoots[0] as string;
    if (requested === undefined || requested === '') return base;
    const abs = path.isAbsolute(requested) ? requested : path.resolve(base, requested);
    let real: string;
    try {
      real = normalizeRoot(abs);
    } catch (e) {
      throw new ProofrailError(`projectRoot not usable: ${(e as Error).message}`);
    }
    if (!this.allowedRoots.some((r) => isInside(r, real))) {
      throw new ProofrailError(
        `projectRoot ${requested} is outside the allowed roots (${this.allowedRoots.join(', ')}). Start proofrail with --root to allow it.`
      );
    }
    return real;
  }

  private load(root: string): { manifest: Manifest; file: string; hash: string } {
    try {
      const { manifest, file, raw } = loadManifest(root);
      return { manifest, file, hash: createHash('sha256').update(raw).digest('hex') };
    } catch (e) {
      if (e instanceof ManifestError) throw new ProofrailError(e.message);
      throw e;
    }
  }

  private session(root: string, hash: string): Session {
    const existing = this.sessions.get(root);
    if (existing && existing.manifestHash === hash) return existing;
    const fresh: Session = { manifestHash: hash, runs: new Map(), lastVerifiedAt: new Date(0).toISOString() };
    this.sessions.set(root, fresh);
    return fresh;
  }

  private async runCommands(root: string, manifest: Manifest, names: Iterable<string>, session: Session): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const name of new Set(names)) {
      const spec = manifest.commands[name];
      if (spec === undefined) throw new ProofrailError(`command "${name}" is not declared in the manifest`);
      const result = await runDeclaredCommand(root, name, spec, { env: this.env });
      session.runs.set(name, result);
      out.push(summarizeRun(result, false));
    }
    session.lastVerifiedAt = new Date().toISOString();
    return out;
  }

  private assess(root: string, manifest: Manifest, runs: ReadonlyMap<string, RunResult>, only?: Set<string>): ClaimAssessment[] {
    const claims = only ? manifest.claims.filter((c) => only.has(c.id)) : manifest.claims;
    return claims.map((claim) => assessOne(root, claim, runs, manifest.commands));
  }

  private async jevFor(a: ClaimAssessment, manifest: Manifest, root: string, wanted: boolean): Promise<JevReport> {
    if (!wanted) return { status: 'unavailable', reason: 'not requested (pass jev=true)' };
    let cfg;
    try {
      cfg = resolveJevConfig(manifest.jev, this.env);
    } catch (e) {
      return { status: 'error', source: 'env', reason: (e as Error).message };
    }
    if (cfg === null) {
      return { status: 'unavailable', reason: 'no jev command configured (set manifest.jev or PROOFRAIL_JEV_CMD)' };
    }
    return askJev(cfg, root, buildJevRequest(a, cfg.model), this.env);
  }

  async verify(opts: { projectRoot?: string; run?: boolean; claimIds?: string[]; jev?: boolean } = {}): Promise<VerifyResult> {
    const root = this.resolveRoot(opts.projectRoot);
    const { manifest, file, hash } = this.load(root);
    const session = this.session(root, hash);
    const only = opts.claimIds && opts.claimIds.length > 0 ? new Set(opts.claimIds) : undefined;
    if (only) {
      for (const id of only) if (!manifest.claims.some((c) => c.id === id)) throw new ProofrailError(`unknown claim id "${id}"`);
    }
    const run = opts.run ?? true;
    const targetClaims = only ? manifest.claims.filter((c) => only.has(c.id)) : manifest.claims;
    let runs: RunSummary[] = [];
    if (run) {
      runs = await this.runCommands(root, manifest, targetClaims.flatMap((c) => c.proofs.flatMap(commandsNeededByProof)), session);
    } else {
      runs = [...session.runs.values()].map((r) => summarizeRun(r, true));
    }
    const ranked = rankClaims(this.assess(root, manifest, session.runs, only));
    const ranking = toRanking(ranked);
    const top = ranked[0];
    const allProven = ranked.every((a) => a.status === 'proven');
    const leastProven = top && !allProven ? buildPacket(top, 1, ranked.length, manifest, root, await this.jevFor(top, manifest, root, opts.jev ?? false)) : null;
    const counts = countStatuses(ranked);
    const summary = allProven
      ? `All ${ranked.length} claims proven.`
      : `${ranked.length} claims: ${counts}. Least proven: ${top?.id} (${top?.status}, score ${top?.score.toFixed(2)}).`;
    const text = [
      `Proofrail verify — ${toPosixRelative(root, file) || path.basename(file)} in ${root}${run ? '' : ' (commands not run)'}`,
      summary,
      'Ranking (least proven first):',
      ...ranking.map((r) => `  ${r.position}. ${r.id} — ${r.status}, score ${r.score.toFixed(2)}, deficit ${r.deficit.toFixed(2)}, proofs ${r.proofs.passed}/${r.proofs.total}, anchors ${r.anchors.resolved}/${r.anchors.total}`),
      ...(runs.length > 0 ? ['Commands:', ...runs.map((r) => `  - ${r.command}: ${describeSummary(r)}`)] : []),
      ...(leastProven ? ['', renderPacket(leastProven)] : [])
    ].join('\n');
    return {
      projectRoot: root,
      manifest: { file: toPosixRelative(root, file), ...(manifest.name !== undefined ? { name: manifest.name } : {}), version: manifest.version, claims: manifest.claims.length, commands: Object.keys(manifest.commands) },
      ran: run,
      runs,
      ranking,
      leastProven,
      allProven,
      summary,
      text
    };
  }

  async focus(opts: { projectRoot?: string; claimId?: string; run?: 'auto' | 'always' | 'never'; jev?: boolean } = {}): Promise<FocusResult> {
    const root = this.resolveRoot(opts.projectRoot);
    const { manifest, hash } = this.load(root);
    const session = this.session(root, hash);
    if (opts.claimId !== undefined && !manifest.claims.some((c) => c.id === opts.claimId)) throw new ProofrailError(`unknown claim id "${opts.claimId}"`);
    const mode = opts.run ?? 'auto';
    const needed = new Set(manifest.claims.flatMap((c) => c.proofs.flatMap(commandsNeededByProof)));
    const missing = [...needed].filter((n) => !session.runs.has(n));
    let usedCachedRuns = true;
    if (mode === 'always' || (mode === 'auto' && missing.length > 0)) {
      await this.runCommands(root, manifest, mode === 'always' ? needed : missing, session);
      usedCachedRuns = mode !== 'always' && missing.length < needed.size;
    }
    const ranked = rankClaims(this.assess(root, manifest, session.runs));
    const idx = opts.claimId !== undefined ? ranked.findIndex((a) => a.id === opts.claimId) : 0;
    const target = ranked[idx] as ClaimAssessment;
    const packet = buildPacket(target, idx + 1, ranked.length, manifest, root, await this.jevFor(target, manifest, root, opts.jev ?? false));
    return { projectRoot: root, packet, ranking: toRanking(ranked), usedCachedRuns, text: renderPacket(packet) };
  }

  async recheck(opts: { projectRoot?: string; claimId: string; jev?: boolean }): Promise<RecheckResult> {
    const root = this.resolveRoot(opts.projectRoot);
    const { manifest, hash } = this.load(root);
    const session = this.session(root, hash);
    const claim = manifest.claims.find((c) => c.id === opts.claimId);
    if (claim === undefined) throw new ProofrailError(`unknown claim id "${opts.claimId}"`);
    const runs = await this.runCommands(root, manifest, claim.proofs.flatMap(commandsNeededByProof), session);
    const ranked = rankClaims(this.assess(root, manifest, session.runs));
    const idx = ranked.findIndex((a) => a.id === claim.id);
    const target = ranked[idx] as ClaimAssessment;
    const packet = buildPacket(target, idx + 1, ranked.length, manifest, root, await this.jevFor(target, manifest, root, opts.jev ?? false));
    const satisfied = target.status === 'proven';
    const next = ranked.find((a) => a.id !== claim.id && a.status !== 'proven') ?? null;
    const nextLeastProven = next ? { id: next.id, status: next.status, score: next.score, deficit: next.deficit } : null;
    const text = [
      `Proofrail recheck — ${claim.id}: ${satisfied ? 'SATISFIED' : 'NOT YET'} (${target.status}, score ${target.score.toFixed(2)})`,
      ...runs.map((r) => `  - ${r.command}: ${describeSummary(r)}`),
      nextLeastProven ? `Next least proven: ${nextLeastProven.id} (${nextLeastProven.status}, score ${nextLeastProven.score.toFixed(2)})` : 'No other unproven claims.',
      '',
      renderPacket(packet)
    ].join('\n');
    return { projectRoot: root, claimId: claim.id, satisfied, packet, runs, nextLeastProven, ranking: toRanking(ranked), text };
  }
}

export function assessOne(root: string, claim: Claim, runs: ReadonlyMap<string, RunResult>, commands: Manifest['commands'] = {}): ClaimAssessment {
  const anchors = claim.anchors.map((a) => resolveAnchor(root, a));
  const proofs = claim.proofs.map((p, i) => evaluateProof(root, i, p, runs, commands));
  return assessClaim(claim, anchors, proofs);
}

function summarizeRun(r: RunResult, cached: boolean): RunSummary {
  return {
    command: r.command,
    display: [r.cmd, ...r.args].join(' '),
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    truncated: r.truncated,
    timedOut: r.timedOut,
    ...(r.spawnError !== undefined ? { spawnError: r.spawnError } : {}),
    cached
  };
}

function describeSummary(r: RunSummary): string {
  if (r.spawnError) return `could not start (${r.spawnError})`;
  if (r.timedOut) return `timed out after ${r.durationMs}ms`;
  return `exit ${r.exitCode} in ${r.durationMs}ms${r.truncated ? ', output truncated' : ''}${r.cached ? ' (cached)' : ''}`;
}

function toRanking(ranked: ClaimAssessment[]): RankingEntry[] {
  return ranked.map((a, i) => ({
    position: i + 1,
    id: a.id,
    status: a.status,
    score: a.score,
    deficit: a.deficit,
    weight: a.weight,
    proofs: { passed: a.proofs.filter((p) => p.status === 'passed').length, total: a.proofs.length },
    anchors: { resolved: a.anchors.filter((x) => x.resolved).length, total: a.anchors.length }
  }));
}

function countStatuses(ranked: ClaimAssessment[]): string {
  const counts = new Map<string, number>();
  for (const a of ranked) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
}
