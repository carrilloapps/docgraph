# Contributing to DocGraph

Thanks for your interest in improving DocGraph! This document explains how to
set up the project and the expectations for contributions.

## Getting started

1. Fork and clone the repository.
2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. Run the test suite:
   ```bash
   npm test
   ```

## Development workflow

- Create a branch from `main`: `git checkout -b feat/short-description`.
- Keep changes focused; one logical change per pull request.
- Match the existing code style (2-space indentation, TypeScript strict mode).
  An [`.editorconfig`](../.editorconfig) is provided.
- Add or update tests for any behaviour you change. Tests live in `test/` and
  use the built-in `node:test` runner.
- Before pushing, make sure the following all pass:
  ```bash
  npm run typecheck
  npm run build
  npm test
  ```

## Commit messages

Use clear, imperative commit subjects (e.g. "Fix vector BLOB decoding").
[Conventional Commits](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`) are encouraged but not required.

## Pull requests

- Fill in the pull-request template.
- Describe the motivation and the change; link any related issues.
- Update `CHANGELOG.md` under an "Unreleased" section when your change is
  user-facing.
- CI must be green before a review.

## Adding an embedding provider

1. Create `src/embeddings/<name>.ts` extending `EmbeddingProvider` from
   `base.ts` and exporting a `<Name>Config` interface.
2. Register it in `src/embeddings/registry.ts` (`PROVIDER_LIST`,
   `PROVIDER_INFO`, and the factory `switch`).
3. Re-export it from `src/embeddings/index.ts`.
4. Only add providers with a real embeddings API. Include the API-key
   environment variable in `PROVIDER_INFO` so `auto` can detect it.

## Reporting bugs and requesting features

Please use the GitHub issue templates. For security issues, follow
[SECURITY.md](./SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](../LICENSE).
