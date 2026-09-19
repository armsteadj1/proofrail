import { spawn } from 'node:child_process';
import type { CommandSpec } from './manifest.js';
import { resolveInside } from './paths.js';

export interface RunResult {
  command: string;
  cmd: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
  startedAt: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
}

class CappedCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly cap: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.cap) {
      this.truncated = true;
      return;
    }
    const remaining = this.cap - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }
  text(): string {
    const s = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${s}\n[proofrail: output truncated at ${this.cap} bytes]` : s;
  }
}

/**
 * Environment variables that must never leak into a spawned command. They are
 * per-process protocol state of whichever harness is running Proofrail; a
 * child that inherits them changes behaviour (Node's test runner, for one,
 * treats itself as a recursive child and silently runs nothing).
 */
export const STRIPPED_ENV_VARS = ['NODE_TEST_CONTEXT', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'] as const;

export function childEnvironment(base: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of STRIPPED_ENV_VARS) delete env[k];
  return { ...env, ...(extra ?? {}) };
}

/**
 * Run a manifest-declared command. `name` is only used for reporting; the
 * caller is responsible for looking `spec` up in the manifest, which is the
 * only source of executable commands. Never uses a shell. Rejects (never
 * spawns) when `spec.cwd` would leave the project root.
 */
export async function runDeclaredCommand(
  root: string,
  name: string,
  spec: CommandSpec,
  options: RunOptions = {}
): Promise<RunResult> {
  const cwd = spec.cwd === undefined ? root : resolveInside(root, spec.cwd);
  const env = childEnvironment(options.env ?? process.env, spec.env);
  const startedAt = new Date();
  const started = process.hrtime.bigint();

  return new Promise<RunResult>((resolve) => {
    const out = new CappedCollector(spec.maxOutputBytes);
    const err = new CappedCollector(spec.maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        command: name,
        cmd: spec.cmd,
        args: spec.args,
        cwd,
        exitCode,
        signal,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.truncated || err.truncated,
        timedOut,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        ...(spawnError !== undefined ? { spawnError } : {}),
        startedAt: startedAt.toISOString()
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      spawnError = (e as Error).message;
      resolve({
        command: name,
        cmd: spec.cmd,
        args: spec.args,
        cwd,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: 0,
        spawnError,
        startedAt: startedAt.toISOString()
      });
      return;
    }

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, spec.timeoutMs);

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      spawnError = e.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export function describeRun(r: RunResult): string {
  if (r.spawnError) return `could not start (${r.spawnError})`;
  if (r.timedOut) return `timed out after ${r.durationMs}ms`;
  if (r.exitCode === null) return `killed by ${r.signal ?? 'signal'}`;
  return `exit ${r.exitCode} in ${r.durationMs}ms`;
}
