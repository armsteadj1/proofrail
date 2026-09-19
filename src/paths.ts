import path from 'node:path';
import fs from 'node:fs';

export class PathEscapeError extends Error {
  constructor(public readonly root: string, public readonly requested: string) {
    super(`path "${requested}" resolves outside project root "${root}"`);
    this.name = 'PathEscapeError';
  }
}

/** Normalize a directory to its real absolute path. Throws if it does not exist. */
export function normalizeRoot(dir: string): string {
  const abs = path.resolve(dir);
  const real = fs.realpathSync.native(abs);
  if (!fs.statSync(real).isDirectory()) {
    throw new Error(`project root is not a directory: ${dir}`);
  }
  return real;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Resolve `requested` (relative or absolute) against `root` and require the
 * lexical result to stay inside root. Does not touch the filesystem.
 */
export function resolveInside(root: string, requested: string): string {
  if (requested.includes('\0')) throw new PathEscapeError(root, requested);
  const abs = path.resolve(root, requested);
  if (!isInside(root, abs)) throw new PathEscapeError(root, requested);
  return abs;
}

/**
 * Like resolveInside, but if the path exists, also require its real path
 * (following symlinks) to stay inside the real root. Returns null when the
 * path does not exist.
 */
export function realInside(root: string, requested: string): string | null {
  const abs = resolveInside(root, requested);
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return null;
  }
  if (!isInside(root, real)) throw new PathEscapeError(root, requested);
  return real;
}

/** Read a UTF-8 text file constrained to root. Returns null if missing. */
export function readTextInside(root: string, requested: string, maxBytes = 2 * 1024 * 1024): string | null {
  const real = realInside(root, requested);
  if (real === null) return null;
  const st = fs.statSync(real);
  if (!st.isFile()) return null;
  const fd = fs.openSync(real, 'r');
  try {
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
