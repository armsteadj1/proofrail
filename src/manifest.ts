import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { resolveInside, PathEscapeError } from './paths.js';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAMES = ['proofrail.json', '.proofrail/manifest.json'] as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const name = z.string().regex(NAME_RE, 'must match /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/');

const relPath = z.string().min(1).max(1024);

export const commandSchema = z.strictObject({
  cmd: z.string().min(1).describe('Executable to spawn. No shell is used; the string is the program name or path.'),
  args: z.array(z.string()).default([]).describe('Argument vector passed verbatim to the executable.'),
  cwd: relPath.optional().describe('Working directory relative to the project root. Must stay inside the root.'),
  env: z.record(z.string(), z.string()).optional().describe('Extra environment variables merged over the server environment.'),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  maxOutputBytes: z.number().int().positive().max(1_048_576).default(65_536),
  description: z.string().optional()
});

export const anchorSchema = z.strictObject({
  file: relPath.describe('File path relative to the project root.'),
  symbol: z.string().min(1).max(200).optional().describe('Declared symbol to locate (function, class, const, def, ...).'),
  pattern: z.string().min(1).max(500).optional().describe('Regular expression; the first matching line becomes the anchor.'),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional().describe('Explicit 1-based inclusive [start, end] line range.'),
  note: z.string().optional()
});

const expectSchema = z.strictObject({
  exitCode: z.number().int().default(0),
  stdoutIncludes: z.string().optional(),
  stderrIncludes: z.string().optional(),
  outputIncludes: z.string().optional().describe('Substring that must appear in stdout or stderr.'),
  outputMatches: z.string().optional().describe('Regular expression that must match stdout or stderr.')
});

export const proofSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    command: name.describe('Name of a command declared in manifest.commands.'),
    expect: expectSchema.default({ exitCode: 0 }),
    note: z.string().optional()
  }),
  z.strictObject({
    kind: z.literal('test'),
    file: relPath,
    name: z.string().min(1).describe('Exact test name that must appear in the file.'),
    command: name.optional().describe('Optional declared command whose output must include the test name and exit 0.'),
    note: z.string().optional()
  }),
  z.strictObject({
    kind: z.literal('file-contains'),
    file: relPath,
    text: z.string().min(1).optional(),
    pattern: z.string().min(1).optional().describe('Regular expression tested against the file contents.'),
    note: z.string().optional()
  }),
  z.strictObject({
    kind: z.literal('manual'),
    note: z.string().min(1).describe('Why this cannot be checked automatically. Never counts as proof.')
  })
]);

export const claimSchema = z.strictObject({
  id: name,
  statement: z.string().min(1).max(2000),
  anchors: z.array(anchorSchema).default([]),
  proofs: z.array(proofSchema).default([]),
  reproducer: z.string().optional().describe('Human-readable command to reproduce; defaults to the first dynamic proof.'),
  done: z.string().optional().describe('Done condition; defaults to a derived statement.'),
  weight: z.number().positive().max(10).default(1),
  tags: z.array(z.string()).default([])
});

export const jevConfigSchema = z.strictObject({
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  model: z.string().default('jev-latest')
});

export const manifestSchema = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(MANIFEST_VERSION),
    name: z.string().optional(),
    commands: z.record(name, commandSchema).default({}),
    claims: z.array(claimSchema).min(1),
    jev: jevConfigSchema.optional()
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.claims.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: 'custom', path: ['claims', i, 'id'], message: `duplicate claim id "${c.id}"` });
      }
      seen.add(c.id);
      c.proofs.forEach((p, j) => {
        const ref = p.kind === 'command' ? p.command : p.kind === 'test' ? p.command : undefined;
        if (ref !== undefined && !(ref in m.commands)) {
          ctx.addIssue({
            code: 'custom',
            path: ['claims', i, 'proofs', j, 'command'],
            message: `references undeclared command "${ref}"`
          });
        }
        if (p.kind === 'file-contains' && p.text === undefined && p.pattern === undefined) {
          ctx.addIssue({ code: 'custom', path: ['claims', i, 'proofs', j], message: 'file-contains needs text or pattern' });
        }
        if (p.kind === 'file-contains' && p.pattern !== undefined) safeRegex(p.pattern, ctx, ['claims', i, 'proofs', j, 'pattern']);
        if (p.kind === 'command' && p.expect.outputMatches !== undefined) {
          safeRegex(p.expect.outputMatches, ctx, ['claims', i, 'proofs', j, 'expect', 'outputMatches']);
        }
      });
      c.anchors.forEach((a, j) => {
        if (a.pattern !== undefined) safeRegex(a.pattern, ctx, ['claims', i, 'anchors', j, 'pattern']);
        if (a.lines && a.lines[0] > a.lines[1]) {
          ctx.addIssue({ code: 'custom', path: ['claims', i, 'anchors', j, 'lines'], message: 'start must be <= end' });
        }
      });
    });
  });

function safeRegex(src: string, ctx: z.RefinementCtx, p: (string | number)[]): void {
  try {
    new RegExp(src);
  } catch (e) {
    ctx.addIssue({ code: 'custom', path: p, message: `invalid regular expression: ${(e as Error).message}` });
  }
}

export type CommandSpec = z.infer<typeof commandSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Proof = z.infer<typeof proofSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type JevConfig = z.infer<typeof jevConfigSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export class ManifestError extends Error {
  constructor(message: string, public readonly file?: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function findManifestPath(root: string): string | null {
  for (const candidate of MANIFEST_FILENAMES) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

export function parseManifest(json: unknown, root: string, file?: string): Manifest {
  const result = manifestSchema.safeParse(json);
  if (!result.success) {
    throw new ManifestError(`invalid manifest${file ? ` ${file}` : ''}:\n${z.prettifyError(result.error)}`, file);
  }
  const m = result.data;
  for (const [cmdName, spec] of Object.entries(m.commands)) {
    if (spec.cwd !== undefined) {
      try {
        resolveInside(root, spec.cwd);
      } catch (e) {
        if (e instanceof PathEscapeError) {
          throw new ManifestError(`commands.${cmdName}.cwd escapes the project root: ${spec.cwd}`, file);
        }
        throw e;
      }
    }
  }
  return m;
}

export interface LoadedManifest {
  manifest: Manifest;
  file: string;
  raw: string;
}

export function loadManifest(root: string): LoadedManifest {
  const file = findManifestPath(root);
  if (file === null) {
    throw new ManifestError(
      `no manifest found in ${root}. Expected one of: ${MANIFEST_FILENAMES.join(', ')}`
    );
  }
  const raw = fs.readFileSync(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ManifestError(`manifest ${file} is not valid JSON: ${(e as Error).message}`, file);
  }
  return { manifest: parseManifest(json, root, file), file, raw };
}
