# AGENTS.md

Guidance for AI coding agents (Claude Code, opencode, and others) working in
this repository. `CLAUDE.md` is a symlink to this file so every agent shares
one source of truth.

## Golden rule — commits

**Never commit or push anything to git without co-authorship attribution.**
Every commit created with AI assistance MUST include a trailer identifying the
assisting agent.

Do not use `--no-verify`, do not skip hooks, and do not force-push unless the
maintainer explicitly asks. Only commit or push when the user requests it.

## What this project is

DocGraph is a universal documentation knowledge-graph **MCP server** with hybrid
full-text (SQLite FTS5) + vector search. It ships a CLI and an MCP server and is
designed to run as a **local MCP server inside a repository**.

## Commands

```bash
npm install        # install dependencies
npm run build      # compile TypeScript to dist/
npm run typecheck  # type-check without emitting
npm test           # compile tests (tsconfig.test.json) and run node:test
```

Always run `npm run typecheck` and `npm test` before proposing a commit.

## Architecture (Clean Architecture)

Dependencies point inward. Never let an inner layer import an outer one.

- `src/domain/` — entities, ports (interfaces), pure services. Depends on nothing.
- `src/application/` — use cases (`IndexingService`, `SearchService`, `QueryService`).
  Depends only on `domain`.
- `src/infrastructure/` — adapters implementing domain ports (SQLite, embeddings,
  filesystem, config). Depends on `domain`.
- `src/presentation/` — entry points (CLI, MCP server).
- `src/container.ts` — the composition root; the only place that instantiates
  concrete adapters. Wire new dependencies here.

When adding a feature: define/extend a port in `domain`, implement the adapter in
`infrastructure`, orchestrate it in an `application` service, and wire it in
`container.ts`.

## Cross-platform & path rules

This tool must run on any OS and is meant to be embedded as a local MCP server.

- **Never hard-code absolute paths or path separators.** Use `node:path`
  (`join`, `relative`, `resolve`, `dirname`) and infer the project root from the
  CLI argument, the `DOCGRAPH_PROJECT` env var, or `process.cwd()`.
- Normalize paths to forward slashes only for glob matching (minimatch).
- Generated agent config (via `docgraph init`) must use the portable
  `npx -p @carrilloapps/docgraph docgraph-mcp serve` command — never an absolute path.

## Conventions

- TypeScript strict mode, ES modules, 2-space indentation (see `.editorconfig`).
- Add or update tests in `test/` (using `node:test`) for any behavior change.
- Only add embedding providers that expose a real embeddings API. Register them
  in `src/infrastructure/embeddings/provider-factory.ts` and re-export from
  `src/index.ts`.
- Keep the README, `CHANGELOG.md` and this file accurate when behavior changes.

<!-- docgraph:managed:start -->
# DocGraph MCP

Universal RAG over the project’s documents (markdown, configs, Notion, Jira,
Obsidian, Linear, GitHub, Confluence, ...). Tools:
`docgraph_search`, `docgraph_explore`, `docgraph_get_document`,
`docgraph_get_related`, `docgraph_get_stats`, `docgraph_list_documents`,
`docgraph_get_document_graph`, `docgraph_index_project`.

Prefer `docgraph_search` over grep/Read loops when the user asks how, why,
where, or "what is X" — it returns hybrid (FTS + vector) hits in one call.
<!-- docgraph:managed:end -->
