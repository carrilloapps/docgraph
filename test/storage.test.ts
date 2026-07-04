import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteKnowledgeStore } from '../src/infrastructure/persistence/sqlite-knowledge-store.js';
import { Document } from '../src/domain/entities.js';

function makeDoc(id: string, content: string, overrides: Partial<Document> = {}): Document {
  return {
    id,
    path: `/tmp/${id}.md`,
    relativePath: `${id}.md`,
    content,
    rawContent: content,
    extension: '.md',
    language: 'markdown',
    title: overrides.title,
    description: overrides.description,
    tags: overrides.tags ?? [],
    headings: overrides.headings ?? [],
    links: overrides.links ?? [],
    codeBlocks: overrides.codeBlocks ?? [],
    lineCount: content.split('\n').length,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    hash: `hash-${id}`,
    indexedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function withStorage(fn: (storage: SqliteKnowledgeStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-storage-'));
  const storage = new SqliteKnowledgeStore(join(dir, '.docgraph', 'docgraph.db'));
  try {
    fn(storage);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upsert and read a document', () => {
  withStorage((storage) => {
    const doc = makeDoc('a', 'hello world', { title: 'Alpha' });
    storage.upsertDocument(doc);
    const fetched = storage.getDocument('a');
    assert.ok(fetched);
    assert.equal(fetched!.title, 'Alpha');
    assert.equal(fetched!.content, 'hello world');
  });
});

test('full-text search matches on content', () => {
  withStorage((storage) => {
    storage.upsertDocument(makeDoc('a', 'authentication and login tokens', { title: 'Auth' }));
    storage.upsertDocument(makeDoc('b', 'docker kubernetes deployment', { title: 'Deploy' }));
    const results = storage.searchFullText('authentication', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].document.id, 'a');
  });
});

test('stats reflect stored documents', () => {
  withStorage((storage) => {
    storage.upsertDocument(makeDoc('a', 'one'));
    storage.upsertDocument(makeDoc('b', 'two'));
    const stats = storage.getStats();
    assert.equal(stats.totalDocuments, 2);
    assert.equal(stats.byExtension['.md'], 2);
  });
});

test('delete removes a document from search', () => {
  withStorage((storage) => {
    storage.upsertDocument(makeDoc('a', 'uniquekeywordxyz'));
    storage.deleteDocument('a');
    assert.equal(storage.getDocument('a'), null);
    assert.equal(storage.searchFullText('uniquekeywordxyz', 10).length, 0);
  });
});
