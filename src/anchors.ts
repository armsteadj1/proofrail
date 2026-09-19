import type { Anchor } from './manifest.js';
import { readTextInside, PathEscapeError } from './paths.js';

export interface ResolvedAnchor {
  file: string;
  symbol?: string;
  pattern?: string;
  resolved: boolean;
  line?: number;
  endLine?: number;
  snippet?: string;
  reason?: string;
  note?: string;
  /** `file:line-endLine`, ready to paste. */
  ref: string;
}

const SNIPPET_MAX_LINES = 12;
const SNIPPET_MAX_COLS = 160;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort declaration matcher covering JS/TS, Python, Go, Rust, Ruby, Java,
 * C#, and generic `name = ...` / `name(...)` forms. Anchors that this cannot
 * find should use `pattern` or `lines` instead.
 */
export function symbolDeclarationRegex(symbol: string): RegExp {
  const S = escapeRegex(symbol);
  const alternatives = [
    `(?:function\\*?\\s+${S})\\b`,
    `(?:const|let|var|val)\\s+${S}\\b`,
    `(?:class|interface|type|enum|struct|trait|impl|module|namespace|object|record)\\s+${S}\\b`,
    `(?:def|fn|func|proc|sub)\\s+(?:\\([^)]*\\)\\s*)?${S}\\b`,
    `${S}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function\\b|\\w+\\s*=>)`,
    `(?:static\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|internal\\s+|override\\s+|virtual\\s+|final\\s+|[\\w<>\\[\\],.]+\\s+)*${S}\\s*\\([^)]*\\)\\s*(?:->\\s*[^{:]+|:[^{]+)?\\s*[{:=]?\\s*$`
  ];
  return new RegExp(`^\\s*(?:export\\s+|pub(?:\\([^)]*\\))?\\s+|default\\s+|declare\\s+|abstract\\s+|async\\s+|@\\w+\\s+)*(?:${alternatives.join('|')})`);
}

function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let sawOpen = false;
  for (let i = startIdx; i < lines.length && i < startIdx + 400; i++) {
    const line = lines[i] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        sawOpen = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (sawOpen && depth <= 0) return i;
    if (!sawOpen && i > startIdx) {
      // No brace on the declaration line: treat as indentation-based block.
      return findIndentEnd(lines, startIdx);
    }
  }
  return sawOpen ? Math.min(lines.length - 1, startIdx + 400) : findIndentEnd(lines, startIdx);
}

function findIndentEnd(lines: string[], startIdx: number): number {
  const head = lines[startIdx] ?? '';
  const baseIndent = head.length - head.trimStart().length;
  let last = startIdx;
  for (let i = startIdx + 1; i < lines.length && i < startIdx + 400; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    last = i;
  }
  return last;
}

function snippet(lines: string[], startIdx: number, endIdx: number): string {
  const slice = lines.slice(startIdx, Math.min(endIdx + 1, startIdx + SNIPPET_MAX_LINES));
  const rendered = slice.map((l, i) => {
    const n = String(startIdx + i + 1).padStart(4, ' ');
    const text = l.length > SNIPPET_MAX_COLS ? `${l.slice(0, SNIPPET_MAX_COLS)}…` : l;
    return `${n}| ${text}`;
  });
  if (endIdx + 1 > startIdx + SNIPPET_MAX_LINES) rendered.push(`    | … (${endIdx - startIdx + 1} lines total)`);
  return rendered.join('\n');
}

export function resolveAnchor(root: string, anchor: Anchor): ResolvedAnchor {
  const base: ResolvedAnchor = {
    file: anchor.file,
    ...(anchor.symbol !== undefined ? { symbol: anchor.symbol } : {}),
    ...(anchor.pattern !== undefined ? { pattern: anchor.pattern } : {}),
    ...(anchor.note !== undefined ? { note: anchor.note } : {}),
    resolved: false,
    ref: anchor.file
  };

  let text: string | null;
  try {
    text = readTextInside(root, anchor.file);
  } catch (e) {
    if (e instanceof PathEscapeError) return { ...base, reason: e.message };
    throw e;
  }
  if (text === null) return { ...base, reason: `file not found: ${anchor.file}` };
  const lines = text.split(/\r?\n/);

  if (anchor.lines) {
    const [start, end] = anchor.lines;
    if (end > lines.length) {
      return { ...base, reason: `line range ${start}-${end} exceeds file length ${lines.length}` };
    }
    return {
      ...base,
      resolved: true,
      line: start,
      endLine: end,
      snippet: snippet(lines, start - 1, end - 1),
      ref: `${anchor.file}:${start}-${end}`
    };
  }

  if (anchor.symbol !== undefined) {
    const re = symbolDeclarationRegex(anchor.symbol);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx === -1) {
      return { ...base, reason: `symbol "${anchor.symbol}" not found in ${anchor.file}` };
    }
    const endIdx = findBlockEnd(lines, idx);
    return {
      ...base,
      resolved: true,
      line: idx + 1,
      endLine: endIdx + 1,
      snippet: snippet(lines, idx, endIdx),
      ref: `${anchor.file}:${idx + 1}-${endIdx + 1}`
    };
  }

  if (anchor.pattern !== undefined) {
    const re = new RegExp(anchor.pattern);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx === -1) {
      return { ...base, reason: `pattern /${anchor.pattern}/ matched no line in ${anchor.file}` };
    }
    return {
      ...base,
      resolved: true,
      line: idx + 1,
      endLine: idx + 1,
      snippet: snippet(lines, idx, idx),
      ref: `${anchor.file}:${idx + 1}`
    };
  }

  return {
    ...base,
    resolved: true,
    line: 1,
    endLine: lines.length,
    snippet: snippet(lines, 0, Math.min(lines.length - 1, 5)),
    ref: `${anchor.file}:1-${lines.length}`
  };
}
