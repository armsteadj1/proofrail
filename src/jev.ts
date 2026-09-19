import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { JevConfig } from './manifest.js';
import type { ClaimAssessment } from './scoring.js';
import { childEnvironment } from './runner.js';

/**
 * Optional Jev adapter. Proofrail never talks to the network itself. When a
 * local command is configured (manifest `jev` or PROOFRAIL_JEV_CMD), Proofrail
 * writes one TypeSafe System One request (`{ model, state, questions }`) to the
 * command's stdin and expects `{ answers }` on stdout. Anything else is
 * reported as `error`; nothing is ever synthesized.
 */

export const JEV_QUESTION_IDS = ['proof_covers_claim', 'anchors_match_claim', 'best_repair'] as const;

export interface JevRequest {
  model: string;
  state: {
    claim: { id: string; statement: string; status: string; score: number };
    anchors: { file: string; ref: string; resolved: boolean; snippet?: string; reason?: string }[];
    proofs: { kind: string; status: string; detail: string }[];
  };
  questions: Record<string, { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: unknown }>;
}

const noulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }).loose();
const choiceAnswer = z
  .object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .loose();
const scoreAnswer = z
  .object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .loose();
export const jevAnswerSchema = z.discriminatedUnion('type', [noulAnswer, choiceAnswer, scoreAnswer]);
export const jevResponseSchema = z
  .object({
    model: z.string().optional(),
    answers: z.record(z.string(), jevAnswerSchema)
  })
  .loose();

export type JevAnswer = z.infer<typeof jevAnswerSchema>;

export type JevReport =
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; reason: string; source: JevSource }
  | { status: 'ok'; source: JevSource; model?: string; answers: Record<string, JevAnswer>; durationMs: number };

export type JevSource = 'manifest' | 'env';

export interface ResolvedJevConfig extends JevConfig {
  source: JevSource;
}

export function resolveJevConfig(manifestJev: JevConfig | undefined, env: NodeJS.ProcessEnv): ResolvedJevConfig | null {
  const envCmd = env.PROOFRAIL_JEV_CMD;
  if (envCmd !== undefined && envCmd.trim() !== '') {
    let args: string[] = [];
    if (env.PROOFRAIL_JEV_ARGS !== undefined && env.PROOFRAIL_JEV_ARGS.trim() !== '') {
      const parsed = z.array(z.string()).safeParse(JSON.parse(env.PROOFRAIL_JEV_ARGS));
      if (!parsed.success) throw new Error('PROOFRAIL_JEV_ARGS must be a JSON array of strings');
      args = parsed.data;
    }
    return {
      cmd: envCmd.trim(),
      args,
      timeoutMs: env.PROOFRAIL_JEV_TIMEOUT_MS ? Number(env.PROOFRAIL_JEV_TIMEOUT_MS) : 15_000,
      model: env.PROOFRAIL_JEV_MODEL ?? 'jev-latest',
      source: 'env'
    };
  }
  if (manifestJev !== undefined) return { ...manifestJev, source: 'manifest' };
  return null;
}

export function buildJevRequest(a: ClaimAssessment, model: string): JevRequest {
  return {
    model,
    state: {
      claim: { id: a.id, statement: a.statement, status: a.status, score: a.score },
      anchors: a.anchors.map((x) => ({
        file: x.file,
        ref: x.ref,
        resolved: x.resolved,
        ...(x.snippet !== undefined ? { snippet: x.snippet } : {}),
        ...(x.reason !== undefined ? { reason: x.reason } : {})
      })),
      proofs: a.proofs.map((p) => ({ kind: p.kind, status: p.status, detail: p.detail }))
    },
    questions: {
      proof_covers_claim: {
        type: 'noul',
        instructions:
          'If every proof listed in `proofs` passed, would that establish the statement in `claim.statement`? Judge only what each proof actually checks, not what its name implies.',
        criteria: { true: 'The passing proofs together establish the statement.', false: 'The statement could be false even with every proof passing.' }
      },
      anchors_match_claim: {
        type: 'noul',
        instructions:
          'Are the source snippets in `anchors` the code that `claim.statement` is about? Unresolved anchors count against a yes.',
        criteria: { true: 'The anchors point at the code the claim describes.', false: 'The anchors are missing, unrelated, or point elsewhere.' }
      },
      best_repair: {
        type: 'choice',
        instructions:
          'Given the current proof statuses and anchors, which single repair would most increase how proven `claim.statement` is?',
        criteria: {
          add_or_fix_test: 'Write or repair a test so a failing or missing test proof passes.',
          fix_code: 'Change the anchored source so an existing proof passes.',
          fix_anchor: 'Update the manifest anchors to point at the right code.',
          strengthen_proof: 'Replace weak proofs (manual notes, file-contains) with executed checks.',
          nothing: 'The claim is already adequately proven.'
        }
      }
    }
  };
}

export function askJev(cfg: ResolvedJevConfig, cwd: string, request: JevRequest, env: NodeJS.ProcessEnv = process.env): Promise<JevReport> {
  const started = Date.now();
  return new Promise<JevReport>((resolve) => {
    let settled = false;
    const done = (r: JevReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cfg.cmd, cfg.args, { cwd, env: childEnvironment(env), shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      done({ status: 'error', source: cfg.source, reason: `jev command could not start: ${(e as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ status: 'error', source: cfg.source, reason: `jev command timed out after ${cfg.timeoutMs}ms` });
    }, cfg.timeoutMs);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    child.stdout?.on('data', (c: Buffer) => {
      outSize += c.length;
      if (outSize <= 1_048_576) out.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 64) err.push(c);
    });
    child.on('error', (e) => done({ status: 'error', source: cfg.source, reason: `jev command could not start: ${e.message}` }));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8').slice(0, 500);
      if (code !== 0) {
        done({ status: 'error', source: cfg.source, reason: `jev command exited ${code}${stderr ? `: ${stderr.trim()}` : ''}` });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        done({ status: 'error', source: cfg.source, reason: 'jev command did not print valid JSON' });
        return;
      }
      const parsed = jevResponseSchema.safeParse(json);
      if (!parsed.success) {
        done({ status: 'error', source: cfg.source, reason: `jev response failed validation: ${z.prettifyError(parsed.error).split('\n')[0]}` });
        return;
      }
      const missing = Object.keys(request.questions).filter((id) => !(id in parsed.data.answers));
      if (missing.length > 0) {
        done({ status: 'error', source: cfg.source, reason: `jev response missing answers for: ${missing.join(', ')}` });
        return;
      }
      done({
        status: 'ok',
        source: cfg.source,
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        answers: parsed.data.answers,
        durationMs: Date.now() - started
      });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(request));
  });
}

export function describeJev(r: JevReport): string {
  if (r.status === 'unavailable') return `unavailable (${r.reason})`;
  if (r.status === 'error') return `error (${r.reason})`;
  const parts: string[] = [];
  for (const [id, a] of Object.entries(r.answers)) {
    if (a.type === 'noul') parts.push(`${id}=${a.noul.toFixed(2)}`);
    else if (a.type === 'choice') parts.push(`${id}=${a.choice}${a.confidence !== undefined ? ` (${a.confidence.toFixed(2)})` : ''}`);
    else parts.push(`${id}=${a.score}`);
  }
  return `ok via ${r.source}${r.model ? ` ${r.model}` : ''}: ${parts.join(', ')}`;
}
