// Regenerates schema/proofrail.schema.json from the zod manifest schema.
// Usage: node scripts/gen-schema.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { manifestSchema } from '../dist/manifest.js';

const out = path.resolve('schema/proofrail.schema.json');
const schema = z.toJSONSchema(manifestSchema, { io: 'input', unrepresentable: 'any' });
const doc = {
  $schema: schema.$schema ?? 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://raw.githubusercontent.com/armsteadj1/proofrail/main/schema/proofrail.schema.json',
  title: 'Proofrail manifest (version 1)',
  ...schema
};
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error('schema/proofrail.schema.json is out of date; run: node scripts/gen-schema.mjs');
    process.exit(1);
  }
  console.log('schema up to date');
} else {
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
