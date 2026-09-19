# Proofrail

Proofrail is a small stdio [MCP](https://modelcontextprotocol.io) server for Claude Code and Codex. After an agent edits code, it asks Proofrail which claim about the code is **least proven**. Proofrail answers with one compact repair packet: exact source anchors, the proof that is missing, a reproducer, and a done condition. There is no repo-wide "looks good" verdict, only the next specific thing to prove.

```
Proofrail packet 1/4: percent-rounds-half-up — failing, score 0.00, deficit 2.00
Claim: percent(part, whole) rounds .5 upward, so percent(1, 8) is 13.
Anchors:
  - src/calc.js:15-17 percent
          15| export function percent(part, whole) {
          16|   return Math.round((part / whole) * 100);
          17| }
Missing proof:
  - [command/failed] command "unit": output lacks "percent rounds half up"
    → Make command "unit" produce exit 0 and output including "percent rounds half up".
Reproduce: node --test test/calc.test.js (cwd .)
Done when: all 1 proof for "percent-rounds-half-up" pass and all 1 anchor resolve (score 1.0 on recheck).
Next: Make command "unit" produce exit 0 and output including "percent rounds half up".
Jev: unavailable (no jev command configured (set manifest.jev or PROOFRAIL_JEV_CMD))
```

## How it works

1. The project declares a **proof manifest** (`proofrail.json`): the commands Proofrail may run, and a list of claims. Each claim has source anchors and proofs.
2. `proofrail_verify` resolves every anchor against the current source, runs the declared commands the claims depend on, and scores each claim deterministically.
3. The lowest-scoring claim (weighted) becomes the repair packet.
4. The agent applies the packet's `next` step, then calls `proofrail_recheck` with the claim id. Recheck re-runs only what that claim needs and reports `satisfied` plus the next least-proven claim.

## Install

Requires Node 20 or newer. Proofrail builds itself on install, so it runs straight from GitHub:

```sh
npx --yes github:armsteadj1/proofrail --help
```

Or add it to a project:

```sh
npm install --save-dev github:armsteadj1/proofrail
```

### Claude Code

From the project directory:

```sh
claude mcp add proofrail -- npx --yes github:armsteadj1/proofrail
```

Or in `.mcp.json` at the project root (shared with the team):

```json
{
  "mcpServers": {
    "proofrail": {
      "command": "npx",
      "args": ["--yes", "github:armsteadj1/proofrail"]
    }
  }
}
```

Claude Code starts MCP servers with the project as the working directory, which becomes Proofrail's allowed root.

### Codex

Add to `~/.codex/config.toml` (or the project's `.codex/config.toml`):

```toml
[mcp_servers.proofrail]
command = "npx"
args = ["--yes", "github:armsteadj1/proofrail"]
```

Or from the CLI:

```sh
codex mcp add proofrail -- npx --yes github:armsteadj1/proofrail
```

### Restricting roots

By default the only allowed root is the server's working directory. Pass `--root` one or more times to allow other directories; every `projectRoot` a tool call passes must be inside an allowed root.

```json
{ "command": "npx", "args": ["--yes", "github:armsteadj1/proofrail", "--root", "/abs/path/to/repo"] }
```

## Tools

| Tool | What it does |
| --- | --- |
| `proofrail_verify` | Load the manifest, resolve anchors, run the needed declared commands, rank all claims, return the least-proven packet. `run=false` scores from cached results without executing. `claimIds` restricts the set. |
| `proofrail_focus` | Return one packet. Defaults to the least-proven claim; `claimId` picks one. `run` is `auto` (reuse cached runs, run only what never ran), `never`, or `always`. |
| `proofrail_recheck` | Re-run only the commands one claim depends on, re-resolve its anchors, return `satisfied` and `nextLeastProven`. |

All three accept `projectRoot` and `jev` (see below). Results carry a text rendering plus `structuredContent` with the same data as JSON.

Suggested agent loop:

```
verify → apply packet.next → recheck(claim) until satisfied → verify again
```

## The manifest

`proofrail.json` at the project root (or `.proofrail/manifest.json`). A JSON Schema ships in `schema/proofrail.schema.json`. The full example is in [`examples/tiny-calc`](examples/tiny-calc).

```json
{
  "$schema": "node_modules/proofrail/schema/proofrail.schema.json",
  "version": 1,
  "commands": {
    "unit": { "cmd": "node", "args": ["--test", "test/calc.test.js"], "timeoutMs": 60000 }
  },
  "claims": [
    {
      "id": "divide-rejects-zero",
      "statement": "divide(a, 0) throws a RangeError instead of returning Infinity.",
      "weight": 2,
      "anchors": [{ "file": "src/calc.js", "symbol": "divide" }],
      "proofs": [
        { "kind": "command", "command": "unit", "expect": { "exitCode": 0, "outputIncludes": "divide by zero throws" } },
        { "kind": "test", "file": "test/calc.test.js", "name": "divide by zero throws", "command": "unit" },
        { "kind": "file-contains", "file": "src/calc.js", "pattern": "throw new RangeError" }
      ],
      "reproducer": "node --test test/calc.test.js",
      "done": "A test named \"divide by zero throws\" exists and passes."
    }
  ]
}
```

### Commands

`commands.<name>` is the only place executables come from. Each has `cmd`, `args`, optional `cwd` (must stay inside the root), `env`, `timeoutMs` (default 120 s, max 10 min), and `maxOutputBytes` (default 64 KiB, max 1 MiB).

### Anchors

An anchor is `file` plus one of:

- `symbol`: a declared name. Proofrail recognises common declaration forms in JavaScript, TypeScript, Python, Go, Rust, Ruby, Java, and C#, and finds the block end by braces or indentation.
- `pattern`: a regular expression; the first matching line is the anchor.
- `lines`: an explicit `[start, end]` range.

Anchors resolve to `file:start-end` with a short numbered snippet. An anchor that no longer resolves after a refactor drags the claim's score down, which is how stale claims surface.

### Proofs

| kind | checks | strength |
| --- | --- | --- |
| `command` | declared command exits with `expect.exitCode` (default 0) and output satisfies `stdoutIncludes`, `stderrIncludes`, `outputIncludes`, `outputMatches` | 1.0 |
| `test` with `command` | test name appears in the file and the command exits 0 with output mentioning the name | 0.9 |
| `test` without `command` | test name appears in the file (not executed) | 0.6 |
| `file-contains` | file contains `text` or matches `pattern` | 0.4 |
| `manual` | nothing; documents an unverifiable claim honestly | 0 |

### Scoring and ranking

Every claim gets a deterministic score in `[0, 1]`:

```
proofScore   = Σ strength(passed proofs) / Σ strength(all proofs)     (0 if no proofs)
anchorFactor = resolved anchors / declared anchors                     (0.5 if none declared)
score        = proofScore × anchorFactor
deficit      = weight × (1 − score)
```

Claims are ordered by deficit descending, then status (`failing`, `unproven`, `pending`, `partial`, `proven`), then unresolved anchor count, then non-passing proof count, then claim id. The first claim is the packet. Same inputs always produce the same packet.

## Safety model

- **Only manifest commands run.** Tool inputs carry claim ids and a project root, never command strings. Commands are spawned with `shell: false` and a fixed argument vector, so nothing in the manifest or tool input is shell-interpreted.
- **Root boundary.** Files and command working directories are resolved against the project root and rejected if they escape it lexically or via symlink. The project root itself must be inside a root the server was started with.
- **Bounded execution.** Every command has a timeout (SIGTERM then SIGKILL) and an output cap. Truncation is reported, not hidden.
- **Read-only.** Proofrail writes nothing. The manifest is trusted the way `package.json` scripts are: review it like code.
- Harness protocol variables (for example `NODE_TEST_CONTEXT`) are scrubbed from child environments so spawned test runners behave normally.

## Optional Jev adapter

Proofrail can attach advisory judgments from [TypeSafe's Jev](https://docs.typesafe.ai) to each packet. Proofrail never calls the network itself. Configure a **local command**; Proofrail writes one TypeSafe System One request to its stdin and expects the API-shaped response on stdout:

```json
{ "model": "jev-latest", "state": { "claim": {}, "anchors": [], "proofs": [] },
  "questions": { "proof_covers_claim": { "type": "noul", "instructions": "...", "criteria": {} },
                 "anchors_match_claim": { "type": "noul", "instructions": "..." },
                 "best_repair": { "type": "choice", "instructions": "...", "criteria": {} } } }
```

Response: `{ "answers": { "<id>": { "type": "noul", "noul": 0.8 } | { "type": "choice", "choice": "add_or_fix_test", "confidence": 0.9 } } }`.

Configure it either in the manifest:

```json
"jev": { "cmd": "node", "args": ["scripts/jev-bridge.mjs"], "timeoutMs": 15000, "model": "jev-latest" }
```

or with environment variables, which take precedence: `PROOFRAIL_JEV_CMD`, `PROOFRAIL_JEV_ARGS` (JSON array), `PROOFRAIL_JEV_TIMEOUT_MS`, `PROOFRAIL_JEV_MODEL`.

Pass `jev: true` to a tool to consult it. The packet's `jev` field is one of:

- `{ "status": "unavailable", "reason": ... }` when nothing is configured or it was not requested;
- `{ "status": "error", "reason": ... }` when the command fails, times out, prints invalid JSON, or omits an answer;
- `{ "status": "ok", "answers": ... }` with the answers exactly as returned.

Proofrail never fabricates Jev output, and Jev answers never change the deterministic score. They are advice next to it.

## CLI

The same engine is available without MCP, useful in CI or for trying a manifest:

```sh
proofrail validate [dir]                       # parse the manifest
proofrail verify   [dir] [--no-run] [--json]   # exit 1 while any claim is unproven
proofrail focus    [dir] [--claim id] [--run auto|always|never]
proofrail recheck  <claimId> [dir]             # exit 0 once satisfied
proofrail [--root dir]...                      # stdio MCP server (default)
```

## Development

```sh
npm install
npm test               # builds, then runs the Node test suite (unit + CLI + stdio MCP smoke)
npm run schema         # regenerate schema/proofrail.schema.json from the zod schema
node dist/cli.js verify examples/tiny-calc
```

CI runs the suite on Node 20, 22, and 24 across Linux and macOS, checks the schema is current, and installs the checkout the way `npx github:` does.

## License

MIT
