import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyExample, addPercentTest, cliPath, tmpDir } from './helpers.mjs';

async function connect(t, root, extraArgs = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--root', root, ...extraArgs],
    cwd: root,
    env: { PATH: process.env.PATH },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'proofrail-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return client;
}

test('stdio smoke: list tools, verify, recheck loop over the example', async (t) => {
  const root = copyExample(t);
  const client = await connect(t, root);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['proofrail_focus', 'proofrail_recheck', 'proofrail_verify']);
  const verifyTool = tools.find((x) => x.name === 'proofrail_verify');
  assert.equal(verifyTool.inputSchema.properties.projectRoot.type, 'string');
  assert.equal(verifyTool.annotations.destructiveHint, false);
  assert.match(client.getInstructions(), /least-proven claim/);

  const v = await client.callTool({ name: 'proofrail_verify', arguments: {} });
  assert.equal(v.isError, undefined);
  assert.equal(v.content[0].type, 'text');
  assert.match(v.content[0].text, /Proofrail packet 1\/4: percent-rounds-half-up/);
  assert.equal(v.structuredContent.leastProven.claim.id, 'percent-rounds-half-up');
  assert.equal(v.structuredContent.leastProven.anchors[0].ref, 'src/calc.js:15-17');
  assert.equal(v.structuredContent.projectRoot, root);

  const f = await client.callTool({ name: 'proofrail_focus', arguments: { run: 'never' } });
  assert.equal(f.structuredContent.packet.claim.id, 'percent-rounds-half-up');
  assert.equal(f.structuredContent.usedCachedRuns, true);

  addPercentTest(root);
  const r = await client.callTool({ name: 'proofrail_recheck', arguments: { claimId: 'percent-rounds-half-up' } });
  assert.equal(r.structuredContent.satisfied, true);
  assert.equal(r.structuredContent.nextLeastProven.id, 'divide-rejects-zero');
  assert.match(r.content[0].text, /SATISFIED/);
});

test('stdio: tool errors are returned as isError results, and inputs are validated', async (t) => {
  const root = copyExample(t);
  const outside = tmpDir(t);
  const client = await connect(t, root);

  const e1 = await client.callTool({ name: 'proofrail_verify', arguments: { projectRoot: outside } });
  assert.equal(e1.isError, true);
  assert.match(e1.content[0].text, /outside the allowed roots/);

  const e2 = await client.callTool({ name: 'proofrail_recheck', arguments: { claimId: 'nope' } });
  assert.equal(e2.isError, true);
  assert.match(e2.content[0].text, /unknown claim id/);

  const e3 = await client.callTool({ name: 'proofrail_focus', arguments: { run: 'sometimes' } });
  assert.equal(e3.isError, true);

  const e4 = await client.callTool({ name: 'proofrail_verify', arguments: { projectRoot: root, jev: true } });
  assert.equal(e4.isError, undefined);
  assert.equal(e4.structuredContent.leastProven.jev.status, 'unavailable');
});

test('stdio: server rejects a manifest-less root gracefully', async (t) => {
  const dir = tmpDir(t);
  const client = await connect(t, dir);
  const r = await client.callTool({ name: 'proofrail_verify', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no manifest found/);
  assert.equal(path.isAbsolute(dir), true);
});
