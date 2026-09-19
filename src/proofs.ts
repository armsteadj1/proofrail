import type { Proof } from './manifest.js';
import type { RunResult } from './runner.js';
import { readTextInside, PathEscapeError } from './paths.js';
import { describeRun } from './runner.js';

export type ProofStatus = 'passed' | 'failed' | 'not-run' | 'unavailable' | 'unverifiable';

export interface ProofResult {
  index: number;
  kind: Proof['kind'];
  status: ProofStatus;
  /** How much this proof counts when it passes. 0 for manual notes. */
  strength: number;
  /** One line: what was checked and what was observed. */
  detail: string;
  /** One line: what would make this proof pass. */
  howToSatisfy: string;
  command?: string;
  note?: string;
}

export const STRENGTH = {
  command: 1.0,
  testWithCommand: 0.9,
  testStatic: 0.6,
  fileContains: 0.4,
  manual: 0
} as const;

export function commandsNeededByProof(p: Proof): string[] {
  if (p.kind === 'command') return [p.command];
  if (p.kind === 'test' && p.command !== undefined) return [p.command];
  return [];
}

function combined(r: RunResult): string {
  return `${r.stdout}\n${r.stderr}`;
}

function firstLine(s: string): string {
  const t = s.trim().split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

export function evaluateProof(
  root: string,
  index: number,
  proof: Proof,
  runs: ReadonlyMap<string, RunResult>
): ProofResult {
  const note = proof.note !== undefined ? { note: proof.note } : {};
  switch (proof.kind) {
    case 'manual':
      return {
        index,
        kind: 'manual',
        status: 'unverifiable',
        strength: STRENGTH.manual,
        detail: `manual note only: ${proof.note}`,
        howToSatisfy: 'Replace this note with a command, test, or file-contains proof.',
        note: proof.note
      };

    case 'file-contains': {
      let text: string | null;
      try {
        text = readTextInside(root, proof.file);
      } catch (e) {
        if (e instanceof PathEscapeError) {
          return { index, kind: proof.kind, status: 'unavailable', strength: STRENGTH.fileContains, detail: e.message, howToSatisfy: 'Fix the file path in the manifest.', ...note };
        }
        throw e;
      }
      const what = proof.pattern !== undefined ? `/${proof.pattern}/` : JSON.stringify(proof.text);
      if (text === null) {
        return { index, kind: proof.kind, status: 'failed', strength: STRENGTH.fileContains, detail: `${proof.file} does not exist (expected ${what})`, howToSatisfy: `Create ${proof.file} containing ${what}.`, ...note };
      }
      const ok = proof.pattern !== undefined ? new RegExp(proof.pattern).test(text) : text.includes(proof.text as string);
      return {
        index,
        kind: proof.kind,
        status: ok ? 'passed' : 'failed',
        strength: STRENGTH.fileContains,
        detail: ok ? `${proof.file} contains ${what}` : `${proof.file} does not contain ${what}`,
        howToSatisfy: `Make ${proof.file} contain ${what}.`,
        ...note
      };
    }

    case 'test': {
      const strength = proof.command !== undefined ? STRENGTH.testWithCommand : STRENGTH.testStatic;
      const cmd = proof.command !== undefined ? { command: proof.command } : {};
      let text: string | null;
      try {
        text = readTextInside(root, proof.file);
      } catch (e) {
        if (e instanceof PathEscapeError) {
          return { index, kind: proof.kind, status: 'unavailable', strength, detail: e.message, howToSatisfy: 'Fix the test file path in the manifest.', ...cmd, ...note };
        }
        throw e;
      }
      if (text === null) {
        return { index, kind: proof.kind, status: 'failed', strength, detail: `test file ${proof.file} does not exist`, howToSatisfy: `Create ${proof.file} with a test named ${JSON.stringify(proof.name)}.`, ...cmd, ...note };
      }
      if (!text.includes(proof.name)) {
        return { index, kind: proof.kind, status: 'failed', strength, detail: `no test named ${JSON.stringify(proof.name)} in ${proof.file}`, howToSatisfy: `Add a test named exactly ${JSON.stringify(proof.name)} to ${proof.file}.`, ...cmd, ...note };
      }
      if (proof.command === undefined) {
        return { index, kind: proof.kind, status: 'passed', strength, detail: `test ${JSON.stringify(proof.name)} exists in ${proof.file} (not executed)`, howToSatisfy: `Keep test ${JSON.stringify(proof.name)} in ${proof.file}.`, ...note };
      }
      const run = runs.get(proof.command);
      if (run === undefined) {
        return { index, kind: proof.kind, status: 'not-run', strength, detail: `test ${JSON.stringify(proof.name)} exists; command "${proof.command}" not run yet`, howToSatisfy: `Run command "${proof.command}" (verify with run=true or recheck).`, ...cmd, ...note };
      }
      if (run.spawnError) {
        return { index, kind: proof.kind, status: 'unavailable', strength, detail: `command "${proof.command}" ${describeRun(run)}`, howToSatisfy: `Make "${run.cmd}" runnable from ${run.cwd}.`, ...cmd, ...note };
      }
      const out = combined(run);
      if (run.exitCode !== 0 || run.timedOut) {
        return { index, kind: proof.kind, status: 'failed', strength, detail: `command "${proof.command}" ${describeRun(run)}: ${firstLine(run.stderr) || firstLine(run.stdout)}`, howToSatisfy: `Make command "${proof.command}" exit 0 with test ${JSON.stringify(proof.name)} passing.`, ...cmd, ...note };
      }
      if (!out.includes(proof.name)) {
        return { index, kind: proof.kind, status: 'failed', strength, detail: `command "${proof.command}" exited 0 but its output never mentions ${JSON.stringify(proof.name)}`, howToSatisfy: `Ensure command "${proof.command}" actually runs ${proof.file} and reports test ${JSON.stringify(proof.name)}.`, ...cmd, ...note };
      }
      return { index, kind: proof.kind, status: 'passed', strength, detail: `test ${JSON.stringify(proof.name)} present and reported by "${proof.command}" (${describeRun(run)})`, howToSatisfy: `Keep test ${JSON.stringify(proof.name)} passing under "${proof.command}".`, ...cmd, ...note };
    }

    case 'command': {
      const strength = STRENGTH.command;
      const run = runs.get(proof.command);
      const exp = proof.expect;
      const expectation = describeExpectation(exp);
      if (run === undefined) {
        return { index, kind: proof.kind, status: 'not-run', strength, detail: `command "${proof.command}" not run yet (expects ${expectation})`, howToSatisfy: `Run command "${proof.command}" (verify with run=true or recheck).`, command: proof.command, ...note };
      }
      if (run.spawnError) {
        return { index, kind: proof.kind, status: 'unavailable', strength, detail: `command "${proof.command}" ${describeRun(run)}`, howToSatisfy: `Make "${run.cmd}" runnable from ${run.cwd}.`, command: proof.command, ...note };
      }
      const problems: string[] = [];
      if (run.timedOut) problems.push(describeRun(run));
      else if (run.exitCode !== exp.exitCode) problems.push(`exit ${run.exitCode} (expected ${exp.exitCode})`);
      const out = combined(run);
      if (exp.stdoutIncludes !== undefined && !run.stdout.includes(exp.stdoutIncludes)) problems.push(`stdout lacks ${JSON.stringify(exp.stdoutIncludes)}`);
      if (exp.stderrIncludes !== undefined && !run.stderr.includes(exp.stderrIncludes)) problems.push(`stderr lacks ${JSON.stringify(exp.stderrIncludes)}`);
      if (exp.outputIncludes !== undefined && !out.includes(exp.outputIncludes)) problems.push(`output lacks ${JSON.stringify(exp.outputIncludes)}`);
      if (exp.outputMatches !== undefined && !new RegExp(exp.outputMatches).test(out)) problems.push(`output does not match /${exp.outputMatches}/`);
      if (problems.length > 0) {
        const hint = firstLine(run.stderr) || firstLine(run.stdout);
        return { index, kind: proof.kind, status: 'failed', strength, detail: `command "${proof.command}": ${problems.join('; ')}${hint ? ` — ${hint}` : ''}`, howToSatisfy: `Make command "${proof.command}" produce ${expectation}.`, command: proof.command, ...note };
      }
      return { index, kind: proof.kind, status: 'passed', strength, detail: `command "${proof.command}" produced ${expectation} (${describeRun(run)})`, howToSatisfy: `Keep command "${proof.command}" producing ${expectation}.`, command: proof.command, ...note };
    }
  }
}

function describeExpectation(exp: Extract<Proof, { kind: 'command' }>['expect']): string {
  const parts = [`exit ${exp.exitCode}`];
  if (exp.stdoutIncludes !== undefined) parts.push(`stdout including ${JSON.stringify(exp.stdoutIncludes)}`);
  if (exp.stderrIncludes !== undefined) parts.push(`stderr including ${JSON.stringify(exp.stderrIncludes)}`);
  if (exp.outputIncludes !== undefined) parts.push(`output including ${JSON.stringify(exp.outputIncludes)}`);
  if (exp.outputMatches !== undefined) parts.push(`output matching /${exp.outputMatches}/`);
  return parts.join(' and ');
}
