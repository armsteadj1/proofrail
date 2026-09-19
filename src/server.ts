import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProofrailEngine, ProofrailError } from './engine.js';
import { PathEscapeError } from './paths.js';
import { PACKAGE_VERSION } from './version.js';

const projectRoot = z
  .string()
  .optional()
  .describe('Project directory containing proofrail.json. Must be inside a root the server was started with. Defaults to the first allowed root.');
const jev = z.boolean().optional().describe('Also ask the configured local Jev command for advisory judgments. Reports "unavailable" when none is configured.');

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(e: unknown): CallToolResult {
  const message = e instanceof ProofrailError || e instanceof PathEscapeError ? e.message : `internal error: ${(e as Error)?.message ?? String(e)}`;
  return { content: [{ type: 'text', text: `Proofrail error: ${message}` }], isError: true };
}

export function createServer(engine: ProofrailEngine): McpServer {
  const server = new McpServer(
    { name: 'proofrail', version: PACKAGE_VERSION },
    {
      instructions: [
        'Proofrail verifies claims declared in the project\'s proofrail.json against the source tree and manifest-declared commands.',
        'Loop: after editing code call proofrail_verify (or proofrail_focus for a cached view) to get the least-proven claim as a repair packet;',
        'apply the packet\'s "next" step; then call proofrail_recheck with that claim id until satisfied is true; repeat.',
        'Proofrail only runs commands declared in the manifest and only reads files inside the project root.'
      ].join(' ')
    }
  );

  server.registerTool(
    'proofrail_verify',
    {
      title: 'Verify claims and return the least-proven repair packet',
      description:
        'Load proofrail.json, resolve every anchor, run the manifest-declared commands the claims depend on, score every claim deterministically, and return the ranking plus one compact repair packet for the least-proven claim (anchors, missing proof, reproducer, done condition). Set run=false to score from cached command results without executing anything.',
      inputSchema: {
        projectRoot,
        run: z.boolean().optional().describe('Execute the declared commands (default true). false uses cached results; dynamic proofs without a cached run report not-run.'),
        claimIds: z.array(z.string()).optional().describe('Restrict verification to these claim ids.'),
        jev
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const r = await engine.verify({
          ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
          ...(args.run !== undefined ? { run: args.run } : {}),
          ...(args.claimIds !== undefined ? { claimIds: args.claimIds } : {}),
          ...(args.jev !== undefined ? { jev: args.jev } : {})
        });
        const { text, ...rest } = r;
        return ok(text, rest);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'proofrail_focus',
    {
      title: 'Get one repair packet (least-proven or a specific claim)',
      description:
        'Return a single repair packet. Without claimId it is the least-proven claim. run="auto" (default) reuses command results cached by an earlier verify/recheck and only runs commands that have never run; "never" never executes; "always" re-runs everything the manifest needs.',
      inputSchema: {
        projectRoot,
        claimId: z.string().optional().describe('Claim id to focus on instead of the least-proven one.'),
        run: z.enum(['auto', 'always', 'never']).optional(),
        jev
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const r = await engine.focus({
          ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
          ...(args.claimId !== undefined ? { claimId: args.claimId } : {}),
          ...(args.run !== undefined ? { run: args.run } : {}),
          ...(args.jev !== undefined ? { jev: args.jev } : {})
        });
        const { text, ...rest } = r;
        return ok(text, rest);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'proofrail_recheck',
    {
      title: 'Re-run only what one claim needs and report whether it is now proven',
      description:
        'Re-run just the manifest commands referenced by the given claim, re-resolve its anchors, and return satisfied=true when the claim reaches score 1.0. Also names the next least-proven claim so the loop can continue.',
      inputSchema: {
        projectRoot,
        claimId: z.string().describe('Claim id from a previous packet.'),
        jev
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => {
      try {
        const r = await engine.recheck({
          ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
          claimId: args.claimId,
          ...(args.jev !== undefined ? { jev: args.jev } : {})
        });
        const { text, ...rest } = r;
        return ok(text, rest);
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

export async function serveStdio(engine: ProofrailEngine): Promise<McpServer> {
  const server = createServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
