# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-04

First public release: a universal documentation knowledge-graph MCP server with
hybrid full-text + vector search, a full CLI, and one-command install into eight
AI agents.

### Added
- **Hybrid search engine.** End-to-end embedding pipeline — chunking, vector
  generation during indexing, and cosine vector search combined with SQLite FTS5
  full-text search — wired into both the CLI and the MCP server.
- **Offline `local` embedding provider.** Dependency-free hashing embeddings so
  hybrid search works with no API key or model download, plus `auto` provider
  resolution that picks a cloud provider when its API key is present in the
  environment and otherwise falls back to `local`.
- **MCP server** (`docgraph-mcp serve`) exposing the knowledge surface as tools:
  `search`, `explore`, `get_document`, `get_related`, `get_stats`,
  `list_documents`, `get_document_graph`, `list_projects`, `index_project`,
  `index_file`. Multi-project aware via an LRU registry.
- **CLI** with `init`, `index`/`reindex`, `watch`, `search`, `stats`/`stats-json`,
  `list`, `sources`, `apis`, `logs`, `import`/`export`, `install`/`uninstall`,
  `exclude`, `files`, `settings`, `providers`, and `serve`.
- **One-command install into 8 agents.** `docgraph install` wires DocGraph into
  Claude Code, Cursor, opencode, Gemini CLI, **Codex CLI** (native TOML
  `[mcp_servers.docgraph]`, written via targeted edits so unrelated TOML is
  preserved), **Kiro** (`.kiro/settings/mcp.json`), **Antigravity**
  (`~/.gemini/antigravity/mcp_config.json`), and **Hermes Agent** (best-effort
  `mcpServers` JSON). Installs merge non-destructively and `docgraph uninstall`
  removes exactly what was added. MCP configuration is portable
  (`npx -p @carrilloapps/docgraph docgraph-mcp serve`) with the project root
  inferred — no absolute paths emitted.
- **Auto-sync.** A debounced file watcher (chokidar) keeps a served project's
  index current: `docgraph watch` and the MCP server re-index only changed files
  and drop deleted ones as they happen. Disable with `--no-watch`,
  `DOCGRAPH_NO_WATCH=1`, or `watch.enabled: false`; tune with `watch.debounceMs`
  (default 1000 ms).
- **Read-only mode.** `--read-only` (CLI and `docgraph-mcp serve`) or
  `DOCGRAPH_READ_ONLY=1` forces the whole process to reads only: no indexing, no
  embedding writes, no autosync, no settings mutation — every mutating store
  method throws and the write MCP tools return a JSON-RPC error. Precedence is
  flag/env → per-project `settings.security.readOnly` (default `false`); SQLite
  connections open `{ readonly: true, fileMustExist: true }`.
- **Rich document parsing.** Markdown, AsciiDoc (`.adoc`/`.asciidoc`/`.adr`),
  reStructuredText (`.rst`), and Org-mode (`.org`) get first-class structure
  extraction; front matter in YAML (`---`), TOML (`+++`), and JSON is parsed for
  `title`/`description`/`tags`; and JS/TS, Python, Go, Rust, and Java/Kotlin/C#
  source files get lightweight top-level symbol extraction as searchable headings.
- **Remote document sources.** Notion, Jira, Confluence (Cloud + Data Center),
  Linear, GitHub, Obsidian, OpenAPI specs, and generic MCP connectors, with
  content-hash skipping so unchanged remote documents are not re-embedded.
- **Local structured logging** (NDJSON) with level filtering, size-based rotation,
  and `docgraph logs` inspection (`--tail`, `--level`, `--grep`, `--follow`).
- **GitHub project scaffolding**: CI workflow, issue/PR templates, Dependabot
  (security-first LTS posture), and the community-health files under `.github/`.

### Changed
- Codebase organized as Clean Architecture (domain / application / infrastructure
  / presentation) with a composition root (`container.ts`).
- Package version is resolved dynamically from `package.json` at runtime for the
  MCP `serverInfo`/`clientInfo`, so it never drifts from what is published.

### Fixed
- `docgraph install`/`uninstall` crashed under ESM with
  `ReferenceError: __dirname is not defined`; the installer path is now derived
  from `import.meta.url`.
- MCP `search`, `explore`, and `get_related` returned empty objects because the
  async calls were not awaited.
- CLI `search "<query>"` mistook the query for a project path, returning no
  results and creating stray directories named after the query.
- Vector store misread stored `float32` BLOBs, breaking cosine similarity.
- `${ENV_VAR}` placeholders in settings are now expanded when settings load.
- Notion cursor pagination, Confluence Cloud page-body retrieval, and remote
  retry/backoff with partial-result resilience across all HTTP sources.
- `sources.pullOnIndex`/`pullOnReindex`/`maxPagesPerSource`/`maxConcurrentSources`
  are enforced; `docgraph logs --follow` streams by byte offset; log rotation
  respects `logging.maxFiles`; installer writers merge only the `docgraph` entry;
  MCP validates `projectPath` and ref-counts projects so an in-flight call is
  never evicted; log level resolves per project.

### Removed
- Fabricated embedding providers (`anthropic`, `groq`) that pointed at
  non-existent embedding endpoints.
- Unused dependencies (`marked`, `glob`).

[1.0.0]: https://github.com/carrilloapps/docgraph/releases/tag/v1.0.0
