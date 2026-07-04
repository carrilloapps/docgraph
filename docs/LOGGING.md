# Local logging

DocGraph does not collect telemetry. Every notable event is written to a local
file so the user can inspect what the tool is doing without it ever leaving
their machine.

## File location

All logs live alongside the SQLite index at:

```
.docgraph/docgraph.log      # active file
.docgraph/docgraph.log.1    # most recent rotation
.docgraph/docgraph.log.2    # previous rotation
.docgraph/docgraph.log.N    # (up to logging.maxFiles)
```

The directory is created automatically on first write. Hidden from the agent,
inspectable from your terminal.

## Format

Every line is a self-contained JSON object (JSON Lines / NDJSON). One event
per line — easy to grep, easy to `jq`, easy to ship into any local ELK /
Loki / Datadog agent.

```json
{"ts":"2026-07-03T18:53:36.975Z","level":"info","msg":"embeddings.enabled","ctx":{"provider":"auto","resolvedProvider":"local"}}
{"ts":"2026-07-03T18:53:37.214Z","level":"info","msg":"indexing.start","ctx":{"files":133,"scope":"filesystem"}}
{"ts":"2026-07-03T18:53:37.443Z","level":"info","msg":"indexing.complete","ctx":{"documents":61,"nodes":216,"edges":175,"vectors":828,"skipped":72,"remoteSources":{}}}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `ts`    | string (ISO 8601) | When the event happened, UTC, millisecond precision. |
| `level` | `"error" \| "warn" \| "info" \| "debug"` | Severity. |
| `msg`   | string | Stable identifier (`embeddings.enabled`, `indexing.start`, `source.failed`, `mcp.tool_call`, ...). Stable, not localized. |
| `ctx`   | object (optional) | Event-specific structured fields — commonly counts, source names, and error details. Frequently includes absolute project/file paths (e.g. `ctx.project`, `ctx.file`); see [What this log contains](#what-this-log-contains) below. |

## Levels

| Level | When you see it |
|-------|-----------------|
| `error` | Uncaught exceptions, embedding-provider crashes, MCP tool failures. |
| `warn`  | Embeddings gracefully disabled, malformed config, transient source-fetch errors. |
| `info`  | Index start / complete, source initialised, project loaded, MCP tool calls. Default. |
| `debug` | Per-request latency, every batch embed, every GraphQL round-trip. Verbose. |

## Configuration

Inside `.docgraph/settings.json`:

```jsonc
{
  "logging": {
    "level": "info",          // error | warn | info | debug
    "maxBytes": 5242880,      // 5 MB before rotation
    "maxFiles": 3,            // docgraph.log, .1, .2 retained
    "mirrorStderr": false     // also write to stderr (true or DOCGRAPH_DEBUG=1)
  }
}
```

Environment variables:

- `DOCGRAPH_LOG=<level>` — override log level without changing settings.
- `DOCGRAPH_DEBUG=1` — implied `mirrorStderr: true` plus `level: debug`.

## Inspection

```bash
docgraph logs                                # last 50 entries (human-readable)
docgraph logs --tail=200 --level=error       # last 200 errors
docgraph logs --grep="vector"                # entries matching 'vector'
docgraph logs --all                          # list every rotated log file
docgraph logs --format=json                  # NDJSON for jq, Loki, etc.
```

`--tail`, `--level`, and `--grep` work as documented above. `--follow` streams
live: it tracks a byte offset into the file and polls for appended data, so it
keeps picking up new entries no matter how large the file grows (no ~64 KB
ceiling). Press Ctrl-C to stop.

`tail -f` on the file directly works too, if you'd rather pipe into `jq` or
another local tool:

```bash
tail -f .docgraph/docgraph.log | jq -c 'select(.level=="error")'
```

## What this log contains

The log is **strictly local**: the file at `.docgraph/docgraph.log` is
written to disk and read only by the `docgraph logs` command and whatever
local tooling you point at it (`tail`, `jq`, a local ELK/Loki agent, ...).
It is never transmitted anywhere by DocGraph — there is no upload path, no
endpoint, and nothing phones home. See [`TELEMETRY.md`](./TELEMETRY.md).

There is, however, **no redaction layer**. `sanitiseContext` (in
`src/infrastructure/logging/local-logger.ts`) bounds each entry by size and
object depth so a single line can't blow past `maxEntryBytes`, but it does
not strip or mask specific fields. In practice this means:

- **Absolute project and file paths are logged.** `ctx.project` (from the
  MCP server and the multi-project registry) and `ctx.file` (from indexing)
  routinely contain full filesystem paths, e.g.
  `/Users/you/code/some-project`.
- Source names (`ctx.source`), document/remote IDs, and counts are logged
  for indexing and source-pull events.
- Search queries and document content are **not** logged today — no code
  path passes them to the logger — but this isn't enforced by a filter, so
  don't treat it as a guarantee against future regressions.
- Tokens, API keys, and OAuth bearer strings are **not** logged today for
  the same reason: nothing currently passes them to the logger, not because
  they're stripped.

Because the file is local-only and owned by you, this is a reasonable
trade-off for a debugging log — but if you attach `.docgraph/docgraph.log`
to a bug report or share it with a teammate, review it first: it may
reveal your project's directory layout or filenames.

## Rotation

Logs are rotated automatically by size, not by time. The default cap (5 MB)
is sized for a medium-size doc repo: a 50k-line log file is roughly 4–5 MB.
For larger repos, increase `maxBytes` and `maxFiles`.

Rotation is best-effort: on a Windows file lock the active file may be
truncated rather than renamed. Either way, the active file is bounded.

## What you don't need

- ❌ No network calls. The log file is local-only.
- ❌ No endpoint. There is no `DOCGRAPH_TELEMETRY_ENDPOINT`.
- ❌ No opt-in/out switch. There is nothing to opt out of.
- ❌ No service worker, no analytics SDK, no third-party dep.
