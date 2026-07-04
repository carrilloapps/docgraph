<div align="center">

# 📚 DocGraph

**Universal documentation knowledge-graph MCP server with hybrid full-text + vector search.**

Index every document in a project — local files plus remote sources from Notion, Jira, Obsidian,
Linear, GitHub, and Confluence — into a single SQLite knowledge graph and expose it to AI agents
over the [Model Context Protocol](https://modelcontextprotocol.io). Works fully offline, no API
key required.

[![npm version](https://img.shields.io/npm/v/@carrilloapps/docgraph.svg)](https://www.npmjs.com/package/@carrilloapps/docgraph)
[![npm downloads](https://img.shields.io/npm/dm/@carrilloapps/docgraph.svg)](https://www.npmjs.com/package/@carrilloapps/docgraph)
[![CI](https://github.com/carrilloapps/docgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/carrilloapps/docgraph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Architecture](https://img.shields.io/badge/architecture-clean-8a2be2.svg)](#%EF%B8%8F-architecture)

📦 **npm:** https://www.npmjs.com/package/@carrilloapps/docgraph

</div>

---

## Table of contents

- [Why DocGraph](#why-docgraph)
- [Features](#features)
- [Supported agents](#supported-agents)
- [Remote document sources](#remote-document-sources)
- [Auto-sync](#auto-sync)
- [Read-only mode](#read-only-mode)
- [Installation](#installation)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [MCP server](#mcp-server)
- [Embeddings & providers](#embeddings--providers)
- [Configuration](#configuration)
- [Programmatic API](#programmatic-api)
- [Architecture](#%EF%B8%8F-architecture)
- [Multi-project support](#multi-project-support)
- [Benchmarks](#benchmarks)
- [Telemetry](#telemetry)
- [Development](#development)
- [License](#license)

## Why DocGraph

AI coding agents are only as good as the context they can find. DocGraph turns any project plus its
remote knowledge sources into a single hybrid search index that an agent can query with natural
language. The search returns the most relevant documents, headings, and code blocks — combining
keyword search with semantic vector search across **both local files and external SaaS sources**.

- **Zero setup.** A built-in, dependency-free `local` embedding provider means hybrid search works
  immediately — no API key, no model download, everything stays on your machine.
- **Multi-source.** Pull documents from Notion, Jira, Confluence, Linear, GitHub issues/PRs, and
  local Obsidian vaults into the same graph as your filesystem.
- **Multi-project.** One MCP server, many indexed projects — pass `projectPath` to each tool call.
- **Agent-native.** Ships an installer that natively wires DocGraph into **8 AI agents** — Claude
  Code, Cursor, opencode, Gemini CLI, Codex CLI, Kiro, Antigravity, and (best-effort) Hermes — each
  in its own native config format. See [Supported agents](#supported-agents).
- **Auto-sync.** A debounced file watcher keeps the index current while `docgraph watch` or the MCP
  server is running — no manual `reindex` needed. See [Auto-sync](#auto-sync).
- **Benchmark harness.** `npm run benchmark` clones real doc repos and runs a real `git grep` (or
  file-scan) baseline against DocGraph search, N runs median — see [Benchmarks](#benchmarks).

## Features

- 🔎 **Hybrid search** — SQLite FTS5 + cosine vector similarity, merged with configurable weights.
- 🧠 **Offline embeddings out of the box** — deterministic feature-hashing vectors; swap in a cloud
  provider anytime.
- 🌐 **Remote source adapters** — Notion, Jira, Confluence (Cloud + Data Center), Linear, GitHub,
  Obsidian, all bundled, with retry/backoff and hash-based re-embed skipping.
- 🔄 **Auto-sync** — a debounced file watcher re-indexes changed files and removes deleted ones
  while `docgraph watch` or the MCP server runs.
- 🗂️ **Multi-format indexing** — Markdown (front-matter in YAML/TOML/JSON, headings, links, code
  blocks, tags), JSON, YAML, TOML, AsciiDoc, reStructuredText, Org-mode, plus doc-oriented symbol
  and comment extraction for JS/TS, Python, Go, Rust, Java/Kotlin/C#, and generic parsing across
  40+ file types.
- 🕸️ **Knowledge graph** — documents, headings, tags, and internal links modelled as nodes and
  edges you can traverse.
- 📚 **Multi-project** — one MCP process serves every indexed project via the `projectPath` arg.
- 🔌 **MCP server** — 9+ tools exposed over stdio for AI agents.
- 🧑‍💻 **8-agent native install** — `docgraph install` writes each agent's own MCP config format
  non-destructively and can uninstall symmetrically.
- 📊 **Benchmark suite** — real `git grep`/file-scan baseline vs. DocGraph search, N-run median per
  scenario; see [Benchmarks](#benchmarks).
- 🧩 **Clean Architecture** — domain / application / infrastructure / presentation layers with
  dependency inversion, fully unit- and integration-tested.

> **Doc-oriented, not a code AST.** DocGraph's per-language code parsing (JS/TS, Python, Go, Rust,
> Java/Kotlin/C#) extracts top-level symbol names, headings, and leading doc comments/docstrings via
> targeted regexes — enough to make source files searchable and to surface their structure in the
> knowledge graph. It is a companion to a dedicated code-graph tool (e.g. codegraph), not a
> replacement for a real compiler-grade AST/call-graph.

## Supported agents

`docgraph install` (and `docgraph init`) detect installed agents and write DocGraph's MCP server
into each one's own native config format — no manual JSON/TOML editing required. Every agent below
is wired natively; nothing here is a no-op.

| Agent | Config path | Format |
|-------|-------------|--------|
| **Claude Code** | `.mcp.json` (local) / `~/.claude.json` (global) | JSON `mcpServers.<name>` |
| **Cursor** | `.cursor/mcp.json` (local) / `~/.cursor/mcp.json` (global) | JSON `mcpServers.<name>` |
| **opencode** | `opencode.json`/`opencode.jsonc` (local) / `~/.config/opencode/opencode.json` (global) | JSON `mcp.<name>` block |
| **Gemini CLI** | `.gemini/settings.json` (local) / `~/.gemini/settings.json` (global) | JSON `mcpServers.<name>` |
| **Codex CLI** | `.codex/config.toml` (local) / `~/.codex/config.toml` (global) | TOML `[mcp_servers.<name>]` |
| **Kiro** | `.kiro/settings/mcp.json` (local) / `~/.kiro/settings/mcp.json` (global) | JSON `mcpServers.<name>` |
| **Antigravity** | `~/.gemini/antigravity/mcp_config.json` (single well-known location) | JSON `mcpServers.<name>` |
| **Hermes Agent** | `.hermes/mcp.json` (local) / `~/.hermes/mcp.json` (global) | JSON `mcpServers.<name>` — **best-effort, unverified**: Hermes has no publicly documented MCP config schema, so this follows the de-facto convention shared by the other agents above |

Installs are non-destructive: existing keys and unrelated servers in a config file are preserved,
and a file that fails to parse is left untouched (install reports a skip rather than clobbering
it). `docgraph uninstall` is symmetric — it removes exactly the `docgraph` entry it added.

## Remote document sources

Every source listed below ships as a built-in adapter. Enable one or many in `.docgraph/settings.json`
under `sources.sources.<name>` and they are pulled, indexed, and searched alongside local files.

| Source | Auth | Notes |
|--------|------|-------|
| **Obsidian** | None (filesystem) | Walks a local vault, parses YAML front-matter, extracts inline `#tags` and `[[wikilinks]]`. |
| **Notion** | Bearer integration token | Database query *or* workspace search; cursor-based pagination (no page-100 cap, no duplicate pages); renders blocks to Markdown. |
| **Jira (Cloud)** | Email + API token (Basic) or OAuth bearer | JQL filter configurable; ADF body rendered to Markdown. |
| **Confluence (Cloud)** | Email + API token (Basic) | REST v2, space ID *or* CQL filter. Indexes the full page body (`body-format=storage`/`expand=body.storage`), not just metadata. |
| **Confluence (Data Center / self-hosted)** | Username + password (or PAT) | Same REST model as Cloud with no cloud-id prefix. |
| **Linear** | Personal API key | GraphQL `issues` query, team and state filters. Pagination is still capped to the first page of results — large teams won't get every issue in one pull. |
| **GitHub** | Fine-grained PAT | Issues *or* pull requests, optional state filter. |

All HTTP-based sources (Notion, Jira, Confluence, Linear, GitHub) retry on `429`/`5xx` with
exponential backoff + jitter (honoring a `Retry-After` header when present); if a page fails after
retries are exhausted, results already fetched are kept instead of being discarded for the whole
run. Remote documents are content-hashed like local files — a pull that finds no change since the
last run skips re-parsing/re-embedding that document, so repeated `index`/`sources pull` runs
against a large, mostly-unchanged remote corpus don't re-pay embedding cost every time.

Obsidian, Jira (Cloud), Confluence (Cloud + Data Center), Linear, GitHub, and the Postman/OpenAPI
source are exercised in the test suite and confirmed working as described above.

DocGraph collects and transmits **no telemetry** of any kind. See [`TELEMETRY.md`](docs/TELEMETRY.md).

## Auto-sync

Both `docgraph watch` and the MCP server (`docgraph-mcp serve`) run a debounced filesystem watcher
(via `chokidar`) on the served project. When files change, DocGraph re-indexes **only the changed
files** — not a full reindex — and removes documents for any file that was deleted. Bursts of
events (e.g. a save-all or a branch checkout) are coalesced by a debounce window before the sync
runs, so a flurry of edits triggers one incremental sync instead of one per file event.

```bash
docgraph watch                 # index, then watch this project and auto-reindex on change
docgraph watch /path/to/project
```

Autosync is on by default for both `watch` and `serve`. Disable it with any of:

- `--no-watch` (CLI flag on `serve`)
- `DOCGRAPH_NO_WATCH=1` (environment variable)
- `"watch": { "enabled": false }` in `.docgraph/settings.json`

The debounce window is configurable via `watch.debounceMs` (default `1000` ms) — see
[Configuration](#configuration).

## Read-only mode

Run DocGraph so it **never writes to the index**: no indexing, no embedding writes, no autosync,
no settings mutation — only reads (`search`, `explore`, `get_*`, `list`, `stats`, `logs`). Useful
for serving a pre-built index to an agent, CI, or any untrusted context where the index must not
change. Every mutating store method throws, the write MCP tools (`index_project`, `index_file`)
return a JSON-RPC error, and the SQLite connections are opened
`{ readonly: true, fileMustExist: true }` — so the project must already be indexed.

Enable it with any of (highest precedence first):

- `--read-only` (CLI flag, and on `docgraph-mcp serve`)
- `DOCGRAPH_READ_ONLY=1` (environment variable)
- `"security": { "readOnly": true }` in `.docgraph/settings.json`

```bash
docgraph index                          # build the index first (writable run)
docgraph search "auth" --read-only      # then query it without any writes
DOCGRAPH_READ_ONLY=1 npx @carrilloapps/docgraph docgraph-mcp serve
```

The flag/env force read-only for the whole process regardless of a project's own settings; when
neither is set, each project falls back to its own `settings.security.readOnly` (default `false`).

## Installation

```bash
# As a dependency of the repo you want to index (recommended — local MCP server)
npm install --save-dev @carrilloapps/docgraph
npx docgraph init

# Or globally
npm install -g @carrilloapps/docgraph

# Self-contained installer (no Node.js required; bundles its own runtime)
# macOS / Linux:
curl -fsSL https://raw.githubusercontent.com/carrilloapps/docgraph/main/install.sh | sh
# Windows (PowerShell):
irm https://raw.githubusercontent.com/carrilloapps/docgraph/main/install.ps1 | iex

# From source
git clone https://github.com/carrilloapps/docgraph.git
cd docgraph
npm install
npm run build
```

The package installs three binaries, each with a short alias:
- `docgraph` — CLI (short: `dg`)
- `docgraph-mcp` — MCP server over stdio (short: `dg-mcp`; also reachable as `docgraph mcp`)
- `docgraph-install` — agent auto-installer for all 8 [supported agents](#supported-agents)
  (Claude Code, Cursor, opencode, Gemini CLI, Codex CLI, Kiro, Antigravity, Hermes) (short: `dg-install`)

Every subcommand also has a short alias (e.g. `dg s "query"` = `docgraph search "query"`, `dg i` =
`docgraph index`, `dg st` = `docgraph stats`) — see [CLI reference](#cli-reference).

Requires **Node.js ≥ 18** on developer machines, or the bundled installer for users.

## Quick start

```bash
# 1. Add DocGraph as a dev dependency and wire it into your agents.
npm install --save-dev @carrilloapps/docgraph
npx docgraph-install --yes                # auto-detect every installed agent (see Supported agents)

# 2. Configure remote sources you want indexed.
$EDITOR .docgraph/settings.json          # enable notion / jira / github / obsidian / ...

# 3. Build the index (filesystem + every enabled remote source).
docgraph init                             # one-shot: settings + initial index + per-agent MCP config
docgraph search "authentication"

# 4. Inspect.
docgraph stats
docgraph sources list                     # configured + enabled status for every source
```

`docgraph init` creates `.docgraph/settings.json`, builds the index, and writes portable MCP
configuration (`.mcp.json` and `opencode.json`) that launches the server via `npx` — no absolute
paths, so it works on any machine and OS.

> Running from source? Use `node dist/presentation/cli/cli.js <command>` (or the `npm run index` /
> `npm run search` scripts) instead of the global `docgraph` binary.

## CLI reference

```
docgraph <command> [options]        # or the short binary: dg <command>

Commands (short alias):
  init [path]              One-shot: settings, initial index, per-agent MCP config
  install | uninstall      Wire DocGraph into / remove from every detected AI agent
  index [path]        (i)  Index local files plus every enabled remote source
  reindex [path]      (ri) Clear and re-index
  watch [path]        (w)  Index, then auto-reindex on file changes (autosync)
  search <query>      (s)  Hybrid search (text + vector)   [also: q]
  stats [path]        (st) Show index statistics
  stats-json [path]   (stj) Show statistics as JSON
  list [path]         (ls) List all indexed documents
  sources [action]    (src) Manage remote sources (list|enable|disable|pull)
  apis [action]            Manage API specs (add|list|remove|enable|disable|pull)
  logs [options]           Read .docgraph/docgraph.log (--tail|--level|--grep|--follow*)
  export <file>       (exp) Export the current .docgraph.db to a portable file
  import <file>       (imp) Import a previously-exported .docgraph.db backup
  exclude [action]    (ex) Manage exclude patterns (list|add|remove|default|gitignore)
  files                    List supported file extensions
  settings [action]   (cfg) Manage settings (show|init|path)
  providers           (prov) List supported embedding providers
  serve [path]             Print MCP server configuration
  mcp [path]               Run the MCP server over stdio (= the docgraph-mcp binary)
```

Long and short forms are interchangeable — `docgraph search "api"`, `dg search "api"`, and
`dg s "api"` are identical.

`*` `--follow` streams new log entries live as they're written (polling by byte offset, so it
keeps working no matter how large the file grows) — `Ctrl-C` to stop. `--tail`, `--level`, and
`--grep` all work as documented. See [`LOGGING.md`](docs/LOGGING.md#inspection).

Search options: `--limit=n`, `--format=json|text`, `--ext=<ext>`, `--lang=<lang>`,
`--tags=a,b,c`, `--no-vector`, `--no-text`. Any command accepts `--path=<dir>`.

```bash
docgraph search "api" --lang=typescript --format=json
docgraph sources list                              # see which sources are enabled
docgraph sources pull --path=/path/to/project      # force a remote-source refresh
docgraph exclude add "**/fixtures/**"
docgraph stats
```

## MCP server

MCP speaks over stdio. `docgraph init` writes the config below automatically; `docgraph serve`
prints it without touching any files. The launch command is portable — it resolves the locally
installed binary via `npx`, so there are no absolute, machine-specific paths. The project root
is inferred from the server's working directory, the `DOCGRAPH_PROJECT` env var, or the
`projectPath` argument every tool accepts.

### Launch forms (short & long)

The server can be started three equivalent ways — use whichever you prefer:

| Form | Command |
|------|---------|
| Short (recommended for humans) | `npx -y @carrilloapps/docgraph mcp` |
| Explicit binary | `npx -y -p @carrilloapps/docgraph docgraph-mcp serve` |
| Short binary alias | `npx -y -p @carrilloapps/docgraph dg-mcp serve` |

The generated agent configs below use the explicit `docgraph-mcp` binary for maximum robustness;
the short `mcp` subcommand is a convenience that routes through the main CLI.

**Claude Code** (`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "docgraph": {
      "command": "npx",
      "args": ["-y", "-p", "@carrilloapps/docgraph", "docgraph-mcp", "serve"]
    }
  }
}
```

**opencode** (`opencode.json`):

```jsonc
{
  "mcp": {
    "docgraph": {
      "type": "local",
      "command": ["npx", "-y", "-p", "@carrilloapps/docgraph", "docgraph-mcp", "serve"],
      "enabled": true
    }
  }
}
```

Set `DOCGRAPH_DEBUG=1` to log JSON-RPC traffic to stderr.

### Available tools

| Tool | Description |
|------|-------------|
| `index_project` | Index local files plus every enabled remote source |
| `index_file` | Index a specific file |
| `search` | Hybrid search across indexed documents (with optional `projectPath`) |
| `explore` | Explore a topic with surrounding context (headings, code) |
| `get_document` | Get a document by ID or path |
| `get_related` | Get documents related by tags and links |
| `get_stats` | Get index statistics |
| `list_documents` | List indexed documents |
| `get_document_graph` | Get a document's node/edge connections |
| `list_projects` | List projects with an active `.docgraph` index in this MCP server |

## Embeddings & providers

By default `provider: "auto"` resolves to the built-in **`local`** provider — deterministic,
offline, dependency-free hashing embeddings that make hybrid search work with no setup. For
higher-quality semantic recall, configure a cloud or local-server provider; `auto` picks it up
automatically when the matching API key is present in the environment.

Run `docgraph providers` to see every provider and its API-key environment variable.

- **Local, no key:** `local` (default), `ollama`, `lmstudio`, `localai`, `jan`
- **Cloud, API key:** `openai`, `cohere`, `voyageai`, `mistral`, `google`, `huggingface`,
  `fireworks`, `togetherai`, `azure`, `minimax`, `replicate`

```bash
export OPENAI_API_KEY=sk-...
docgraph reindex      # auto-detects OpenAI and regenerates embeddings
```

## Configuration

Settings are read from `.docgraph/settings.json` (or `docgraph.json`) at the project root;
anything omitted falls back to sensible defaults. Values of the form `${ENV_VAR}` are expanded
from the environment. Create a starter file with `docgraph settings init`.

```jsonc
{
  "embedding":   { "provider": "auto", "dimension": 256 },
  "indexing":    { "chunkSize": 512, "generateOnIndex": true },
  "search":      { "vectorWeight": 0.7, "textWeight": 0.3, "minScore": 0.1, "limit": 20 },
  "exclude":     { "useGitignore": true, "useDefaultPatterns": true },
  "sources": {
    "sources": {
      "notion":  { "enabled": true, "options": { "token": "${NOTION_TOKEN}", "databaseId": "..." } },
      "obsidian":{ "enabled": true, "options": { "vaultPath": "/Users/me/Vault" } },
      "jira":    { "enabled": false, "options": { "host": "https://acme.atlassian.net" } }
    },
    "pullOnIndex": true,
    "pullOnReindex": true,
    "maxPagesPerSource": 50,
    "maxConcurrentSources": 4
  },
  "watch": { "enabled": true, "debounceMs": 1000 },
  "security": { "readOnly": false }
}
```

> `sources.pullOnIndex`, `sources.pullOnReindex`, `sources.maxPagesPerSource`, and
> `sources.maxConcurrentSources` are enforced: `index`/`reindex` consult `pullOnIndex`/
> `pullOnReindex` to decide whether to touch the network at all, each remote source is capped to
> `maxPagesPerSource` pages via `configureMaxPages()`, and up to `maxConcurrentSources` sources are
> pulled concurrently instead of strictly one at a time.

| Key | Default | Description |
|-----|---------|-------------|
| `embedding.provider` | `auto` | Embedding provider (`local`, `openai`, ...) |
| `embedding.dimension` | `256` | Vector size for the `local` provider |
| `indexing.chunkSize` | `512` | Characters per embedded chunk |
| `indexing.generateOnIndex` | `true` | Generate embeddings while indexing |
| `sources.sources.<name>.enabled` | `false` | Per-source enable flag |
| `sources.pullOnIndex` | `true` | Whether `index` pulls remote sources at all |
| `sources.pullOnReindex` | `true` | Whether `reindex` pulls remote sources at all |
| `sources.maxPagesPerSource` | `50` | Per-source page cap, forwarded to each adapter |
| `sources.maxConcurrentSources` | `4` | Max remote sources pulled concurrently |
| `watch.enabled` | `true` | Auto-sync file watcher for `watch`/`serve` (see [Auto-sync](#auto-sync)) |
| `watch.debounceMs` | `1000` | Debounce window (ms) before an auto-sync re-index runs |
| `security.readOnly` | `false` | Forbid all writes; overridden per-run by `--read-only` / `DOCGRAPH_READ_ONLY` (see [Read-only mode](#read-only-mode)) |
| `search.vectorWeight` / `textWeight` | `0.7` / `0.3` | Hybrid merge weights |
| `search.minScore` | `0.1` | Minimum cosine similarity for vector hits |
| `exclude.useGitignore` | `true` | Honour the project `.gitignore` |

## Programmatic API

```ts
import { Container } from '@carrilloapps/docgraph';

const docgraph = new Container('/path/to/project');
await docgraph.indexing.indexProject();

const results = await docgraph.search.search({ query: 'authentication tokens', limit: 5 });
for (const hit of results) {
  console.log(`${(hit.score * 100).toFixed(1)}%  ${hit.document.relativePath}`);
}

// Remote sources are first-class: pull them on demand.
const counts = await docgraph.indexing.pullRemoteSources();
console.log('Pulled:', counts);

docgraph.close();
```

Individual services (`IndexingService`, `SearchService`, `QueryService`), ports, adapters, the
`ProjectRegistry`, and every source implementation are all exported for advanced composition and
testing.

## Multi-project support

One MCP server process serves every indexed project. Each tool call accepts an optional
`projectPath` argument; if absent, the server uses the `DOCGRAPH_PROJECT` env var or its working
directory. Projects are kept in a small LRU (default `DOCGRAPH_MAX_PROJECTS=16`) so long-running
sessions don't grow unbounded. Use `list_projects` to inspect what's loaded.

```ts
// Library form
import { ProjectRegistry } from '@carrilloapps/docgraph';
const registry = new ProjectRegistry({ maxProjects: 16 });
const services = registry.get('/projects/alpha');
const other    = registry.get('/projects/beta');
```

```bash
DOCGRAPH_MAX_PROJECTS=32 npx @carrilloapps/docgraph docgraph-mcp serve
```

## Benchmarks

`npm run benchmark` clones real-world documentation repos, builds a DocGraph index, and runs a
fixed set of natural-language queries against it, scoring both a **WITH** (DocGraph `search`) and a
**WITHOUT** DocGraph arm. The baseline arm is a real comparison, not a stub: `git grep -n -i` over
the same checkout, falling back to a manual recursive file scan if `git` is unavailable. Each
scenario is measured **N runs (default 4), median reported**.

```bash
npm run build                                    # benchmark shells out to dist/, so build first
npm run benchmark
npm run benchmark -- --runs=8                    # custom run count
npm run benchmark -- --scenario=react-native     # one scenario at a time
```

Results are **generated locally, on demand** — the script writes a full report (per-run latency,
hit counts, and a per-scenario summary) to `benchmarks/results.json` and prints a summary table to
stdout. That output directory is not checked into this repository or published anywhere, so no
numbers are quoted here — run it yourself against your own docs. Bundled scenarios: `react-native`
(facebook/react-native), `supabase-js` (supabase/supabase-js), and `astro` (withastro/docs).

## Telemetry

DocGraph collects, stores, and transmits **no telemetry or usage data of any kind**. See
[`TELEMETRY.md`](docs/TELEMETRY.md) for the full policy. Every event — index start, vector-search
warning, source fetch, MCP request — is written as a structured JSON-Lines entry to
`.docgraph/docgraph.log` and rotated locally (format reference in [`LOGGING.md`](docs/LOGGING.md)).
Nothing leaves the user's machine unless *you* explicitly configure a cloud embedding provider, in
which case only document chunks are sent to that provider to compute embeddings.

```bash
docgraph logs                            # last 50 entries
docgraph logs --tail=200 --level=error   # last 200 errors only
docgraph logs --grep="vector"            # entries matching 'vector'
docgraph logs --grep="vector" --follow   # streams new matches live, Ctrl-C to stop
docgraph logs --all                      # list every rotated file
docgraph logs --format=json              # pipe into jq / dashboards
```

Log format (one JSON object per line, NDJSON / JSON-Lines):

```json
{"ts":"2026-07-03T18:53:36.975Z","level":"info","msg":"embeddings.enabled","ctx":{"provider":"auto","resolvedProvider":"local"}}
{"ts":"2026-07-03T18:53:37.443Z","level":"info","msg":"indexing.complete","ctx":{"component":"indexing","documents":61,"nodes":216,"edges":175,"vectors":828}}
```

Configure via `.docgraph/settings.json`:

```jsonc
{
  "logging": {
    "level": "info",                // "error" | "warn" | "info" | "debug"
    "maxBytes": 5242880,            // 5 MB before rotation
    "maxFiles": 3,                  // docgraph.log, .1, .2 retained
    "mirrorStderr": false           // set true or DOCGRAPH_DEBUG=1 to mirror to stderr
  }
}
```

| Level | What you'd see at default `info` |
|-------|-----------------------------------|
| `error` | Uncaught exceptions, embedding provider failures, MCP tool errors |
| `warn`  | Embeddings disabled, malformed config, source fetch failures |
| `info`  | Index start/complete, source initialised, project loaded, MCP tool calls |
| `debug` | Per-request latency, every batch embed, every GraphQL round-trip |

## Architecture

DocGraph follows **Clean Architecture**. Dependencies point inward — inner layers know nothing
about outer ones — so the core logic is independent of SQLite, HTTP and the file system.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ presentation/        CLI · MCP server (stdio JSON-RPC) · Installer        │
├──────────────────────────────────────────────────────────────────────────┤
│ container.ts         composition root (wires everything per project)      │
│ project-registry.ts  LRU cache of containers, one per projectPath          │
├──────────────────────────────────────────────────────────────────────────┤
│ application/         IndexingService · SearchService · QueryService       │
│                      (use cases — pullRemoteSources() lives here)         │
├──────────────────────────────────────────────────────────────────────────┤
│ domain/              entities · ports (interfaces) ·                       │
│                      chunker   (no external deps)                          │
├──────────────────────────────────────────────────────────────────────────┤
│ infrastructure/      SQLite store · vector store · embedding providers ·   │
│                      filesystem source · remote sources (Notion, Jira,    │
│                      Obsidian, Confluence, Linear, GitHub) ·               │
│                      file watcher (auto-sync) · config                    │
└──────────────────────────────────────────────────────────────────────────┘
```

```
src/
├── domain/                          # Enterprise rules — depends on nothing
│   ├── entities.ts                  #   Document, GraphNode/Edge, SearchResult, ... (Zod)
│   ├── ports.ts                     #   Repository, VectorStore, EmbeddingProvider, ...
│   └── chunker.ts                   #   Pure text-chunking service
├── application/                     # Use cases — depends only on domain
│   ├── indexing-service.ts          #   indexProject, pullRemoteSources, indexRemoteDocument
│   ├── search-service.ts
│   └── query-service.ts
├── infrastructure/                  # Adapters — implement domain ports
│   ├── config/settings.ts           #   DocGraphSettings + sources.sources
│   ├── persistence/                 #   SQLite knowledge store + vector store
│   ├── filesystem/                  #   Document source + multi-format parser
│   ├── embeddings/                  #   Provider factory + local/cloud providers
│   ├── sources/                     #   Remote source adapters (Notion, Jira, Obsidian, ...)
│   └── watch/                       #   Debounced file watcher (auto-sync)
├── presentation/                    # Entry points
│   ├── cli/                         #   Argument parsing + CLI
│   ├── installer/                   #   Native install for all 8 supported agents
│   └── mcp/                         #   MCP server (multi-project, autosync)
├── container.ts                     # Composition root
├── project-registry.ts              # Multi-project LRU
└── index.ts                         # Public library API
```

The document metadata, knowledge graph, vectors, and remote-source cache all live in a single
SQLite database at `.docgraph/docgraph.db` inside the indexed project.

## Development

```bash
npm install
npm run build          # compile TypeScript to dist/
npm run typecheck      # type-check without emitting
npm test               # node:test runner, 60+ specs across 12 files
npm run benchmark      # real git-grep/file-scan baseline vs. DocGraph search, see Benchmarks section
```

Tests use the built-in [`node:test`](https://nodejs.org/api/test.html) runner (no test-framework
dependency) and cover the domain services, infrastructure adapters, remote sources, multi-project
registry, and full end-to-end flows through the composition root.

## License

[MIT](./LICENSE) © [Junior Carrillo](https://carrillo.app)
