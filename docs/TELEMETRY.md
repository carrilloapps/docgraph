# Telemetry

**DocGraph collects, stores, and transmits no telemetry or usage data of any kind.** There is no
opt-in, no opt-out, and no configuration flag for it — because there is no telemetry code in the
product. This document exists so that claim is explicit and easy to verify.

## What DocGraph does not do

- It does not phone home on startup, on install, or on any CLI/MCP invocation.
- It does not generate or transmit anonymous usage statistics, analytics events, or crash reports.
- It does not ping any DocGraph-operated or third-party endpoint to check for updates, license
  status, or feature flags.
- It does not collect file names, file contents, search queries, or project paths and send them
  anywhere.

You can verify this yourself: the source is available at
[github.com/carrilloapps/docgraph](https://github.com/carrilloapps/docgraph). There is no
telemetry client, no analytics SDK, and no outbound network call in the codebase outside of the
optional remote document sources and embedding providers described below, both of which only run
when you explicitly configure them.

## What data DocGraph does write, and where

The only data DocGraph writes by default lives entirely on your machine, inside the project's
`.docgraph/` directory:

| Data | Location | Leaves the machine? |
|------|----------|----------------------|
| Structured event log (index runs, errors, warnings, MCP calls) | `.docgraph/docgraph.log` (rotated) | Never. See [`LOGGING.md`](./LOGGING.md) for the full format reference. |
| Knowledge graph, document metadata, and vector index | `.docgraph/docgraph.db` (SQLite) | Never, unless you explicitly run `docgraph export` and move the file yourself. |
| Settings (which sources/providers are enabled) | `.docgraph/settings.json` | Never. |

None of these files are uploaded, synced, or reported to DocGraph's maintainers or any third
party by the tool itself.

## The only two cases where data leaves your machine

Both require you to opt in explicitly by configuring them — DocGraph never enables either on its
own:

1. **Remote document sources.** If you enable a source such as Notion, Jira, Confluence, Linear,
   or GitHub in `.docgraph/settings.json`, DocGraph makes authenticated API calls to *that*
   service, using credentials *you* provide, to *pull* your own documents into the local index.
   This is inbound data you already own — not telemetry.
2. **Cloud embedding providers.** By default, embeddings are generated locally by the built-in
   `local` provider — nothing is sent anywhere. If you explicitly configure a cloud provider (for
   example `openai`, `cohere`, or `voyageai`) via `embedding.provider` and an API key, DocGraph
   sends the text of your document chunks to that provider so it can return embedding vectors.
   That traffic goes directly to the provider you chose, using your own API key — DocGraph itself
   is never in that data path as a relay or observer.

## Summary

If you never enable a remote source or a cloud embedding provider, DocGraph makes zero outbound
network calls and stores zero data outside your project's `.docgraph/` directory. Enabling either
feature only ever talks to the third-party service *you* configured, with credentials *you*
supplied — never to DocGraph or its maintainers.
