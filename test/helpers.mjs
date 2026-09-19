import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const examplePath = path.join(repoRoot, 'examples', 'tiny-calc');
export const cliPath = path.join(repoRoot, 'dist', 'cli.js');
export const fixturesPath = path.join(repoRoot, 'test', 'fixtures');

/** Copy the example project into a fresh temp dir. Returns its real path. */
export function copyExample(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofrail-'));
  fs.cpSync(examplePath, dir, { recursive: true });
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

export function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofrail-'));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function readExampleManifest() {
  return JSON.parse(fs.readFileSync(path.join(examplePath, 'proofrail.json'), 'utf8'));
}

export const PERCENT_TEST = `
test('percent rounds half up', () => {
  assert.equal(percent(1, 8), 13);
});
`;

/** Add the missing percent test to a copied example so its claim becomes proven. */
export function addPercentTest(root) {
  const file = path.join(root, 'test', 'calc.test.js');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace("import { add, divide } from '../src/calc.js';", "import { add, divide, percent } from '../src/calc.js';");
  fs.writeFileSync(file, src + PERCENT_TEST);
}
