import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Container } from '../src/container.js';

/**
 * Integration tests exercising the whole Clean Architecture stack through the
 * composition root. The embedding provider is pinned to `local` so the tests
 * are deterministic and run fully offline regardless of environment API keys.
 */
function setup(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-it-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, '.docgraph'), { recursive: true });
  writeFileSync(join(dir, '.docgraph', 'settings.json'), JSON.stringify({ embedding: { provider: 'local' } }));
  writeFileSync(
    join(dir, 'docs', 'auth.md'),
    '# Authentication Guide\n\nHow to configure login, OAuth and JWT bearer tokens for the API.\n',
  );
  writeFileSync(
    join(dir, 'docs', 'deploy.md'),
    '# Deployment\n\nDeploy the service with Docker and Kubernetes clusters.\n',
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('indexProject indexes documents and generates vectors', async () => {
  const { dir, cleanup } = setup();
  const container = new Container(dir);
  try {
    const result = await container.indexing.indexProject();
    assert.equal(result.documents, 2);
    assert.ok(result.vectors >= 2, `expected vectors, got ${result.vectors}`);
    assert.equal(container.resolvedProvider, 'local');
    assert.equal(container.vectorStore?.getStats().totalDocuments, 2);
  } finally {
    container.close();
    cleanup();
  }
});

test('hybrid search returns the relevant document', async () => {
  const { dir, cleanup } = setup();
  const container = new Container(dir);
  try {
    await container.indexing.indexProject();
    const results = await container.search.search({ query: 'authentication tokens', limit: 5 });
    assert.ok(results.length >= 1);
    assert.match(results[0].document.relativePath, /auth\.md$/);
  } finally {
    container.close();
    cleanup();
  }
});

test('vector-only search retrieves semantically related content', async () => {
  const { dir, cleanup } = setup();
  const container = new Container(dir);
  try {
    await container.indexing.indexProject();
    const results = await container.search.search({ query: 'login oauth jwt', limit: 5, useText: false });
    assert.ok(results.length >= 1);
    assert.match(results[0].document.relativePath, /auth\.md$/);
  } finally {
    container.close();
    cleanup();
  }
});

test('re-indexing unchanged files skips them', async () => {
  const { dir, cleanup } = setup();
  const first = new Container(dir);
  await first.indexing.indexProject();
  first.close();

  const second = new Container(dir);
  try {
    const result = await second.indexing.indexProject();
    assert.equal(result.documents, 0);
    assert.ok(result.skipped >= 2);
  } finally {
    second.close();
    cleanup();
  }
});

test('query service lists and fetches indexed documents', async () => {
  const { dir, cleanup } = setup();
  const container = new Container(dir);
  try {
    await container.indexing.indexProject();
    const docs = container.query.listDocuments();
    assert.equal(docs.length, 2);
    const graph = container.query.getDocumentGraph(docs[0].id);
    assert.ok(graph);
    assert.ok(graph!.nodes.length >= 1);
  } finally {
    container.close();
    cleanup();
  }
});
