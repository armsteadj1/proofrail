#!/usr/bin/env node
import process from 'node:process';
import { ProofrailEngine, ProofrailError } from './engine.js';
import { serveStdio } from './server.js';
import { loadManifest, ManifestError } from './manifest.js';
import { normalizeRoot, PathEscapeError } from './paths.js';
import { PACKAGE_VERSION } from './version.js';

const HELP = `proofrail ${PACKAGE_VERSION}

Usage:
  proofrail [--root <dir>]...                 Start the stdio MCP server (default root: cwd)
  proofrail verify   [dir] [--no-run] [--claim <id>]... [--jev] [--json]
  proofrail focus    [dir] [--claim <id>] [--run auto|always|never] [--jev] [--json]
  proofrail recheck  <claimId> [dir] [--jev] [--json]
  proofrail validate [dir]                    Parse the manifest and list claims/commands
  proofrail --help | --version

The MCP server only runs commands declared in proofrail.json (spawned without a
shell) and only reads files inside the allowed roots.`;

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

const VALUE_FLAGS = new Set(['root', 'claim', 'run']);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (VALUE_FLAGS.has(key)) {
        const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (val === undefined) throw new Error(`--${key} needs a value`);
        flags.set(key, [...(flags.get(key) ?? []), val]);
      } else {
        bools.add(key);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, bools };
}

function print(obj: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(obj, null, 2)}\n` : `${text}\n`);
}

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const { positional, flags, bools } = parsed;
  if (bools.has('help') || bools.has('h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (bools.has('version') || bools.has('v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  const command = positional[0];
  const json = bools.has('json');

  try {
    if (command === undefined) {
      const roots = flags.get('root') ?? [process.cwd()];
      const engine = new ProofrailEngine({ allowedRoots: roots });
      process.stderr.write(`proofrail ${PACKAGE_VERSION} serving stdio; roots: ${engine.allowedRoots.join(', ')}\n`);
      await serveStdio(engine);
      return -1; // keep running
    }

    if (command === 'validate') {
      const root = normalizeRoot(positional[1] ?? process.cwd());
      const { manifest, file } = loadManifest(root);
      const out = {
        file,
        name: manifest.name,
        version: manifest.version,
        commands: Object.fromEntries(Object.entries(manifest.commands).map(([k, v]) => [k, [v.cmd, ...v.args].join(' ')])),
        claims: manifest.claims.map((c) => ({ id: c.id, weight: c.weight, anchors: c.anchors.length, proofs: c.proofs.map((p) => p.kind) }))
      };
      print(out, json, `manifest OK: ${file}\ncommands: ${Object.keys(manifest.commands).join(', ') || '(none)'}\nclaims:\n${manifest.claims.map((c) => `  - ${c.id} (weight ${c.weight}, ${c.anchors.length} anchors, ${c.proofs.length} proofs)`).join('\n')}`);
      return 0;
    }

    if (command === 'verify') {
      const dir = positional[1] ?? process.cwd();
      const engine = new ProofrailEngine({ allowedRoots: [dir] });
      const r = await engine.verify({ run: !bools.has('no-run'), jev: bools.has('jev'), ...(flags.has('claim') ? { claimIds: flags.get('claim') } : {}) });
      const { text, ...rest } = r;
      print(rest, json, text);
      return r.allProven ? 0 : 1;
    }

    if (command === 'focus') {
      const dir = positional[1] ?? process.cwd();
      const engine = new ProofrailEngine({ allowedRoots: [dir] });
      const runMode = flags.get('run')?.[0];
      if (runMode !== undefined && !['auto', 'always', 'never'].includes(runMode)) throw new ProofrailError('--run must be auto, always, or never');
      const r = await engine.focus({
        jev: bools.has('jev'),
        ...(flags.has('claim') ? { claimId: flags.get('claim')?.[0] } : {}),
        ...(runMode !== undefined ? { run: runMode as 'auto' | 'always' | 'never' } : {})
      });
      const { text, ...rest } = r;
      print(rest, json, text);
      return r.packet.rank.status === 'proven' ? 0 : 1;
    }

    if (command === 'recheck') {
      const claimId = positional[1];
      if (claimId === undefined) throw new ProofrailError('recheck needs a claim id');
      const dir = positional[2] ?? process.cwd();
      const engine = new ProofrailEngine({ allowedRoots: [dir] });
      const r = await engine.recheck({ claimId, jev: bools.has('jev') });
      const { text, ...rest } = r;
      print(rest, json, text);
      return r.satisfied ? 0 : 1;
    }

    process.stderr.write(`unknown command: ${command}\n\n${HELP}\n`);
    return 2;
  } catch (e) {
    if (e instanceof ProofrailError || e instanceof ManifestError || e instanceof PathEscapeError) {
      process.stderr.write(`proofrail: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`proofrail: ${(e as Error).stack ?? String(e)}\n`);
    return 2;
  }
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);
