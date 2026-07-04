import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteKnowledgeStore, EXPECTED_SCHEMA_VERSION } from '../src/infrastructure/persistence/sqlite-knowledge-store.js';

test('SqliteKnowledgeStore is in WAL mode out of the box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-wal-'));
  try {
    const dbPath = join(dir, 'docgraph.db');
    const store = new SqliteKnowledgeStore(dbPath);
    const probe = new Database(dbPath, { readonly: true });
    const mode = (probe.pragma('journal_mode') as { journal_mode: string }[])[0]?.journal_mode;
    assert.equal(mode?.toUpperCase(), 'WAL');
    probe.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteKnowledgeStore exposes the configured busy_timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-busy-'));
  try {
    const dbPath = join(dir, 'docgraph.db');
    const store = new SqliteKnowledgeStore(dbPath, { busyTimeoutMs: 12_345 });
    assert.equal(store.describe().busyTimeoutMs, 12_345);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteKnowledgeStore records schema version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-schema-'));
  try {
    const dbPath = join(dir, 'docgraph.db');
    const store = new SqliteKnowledgeStore(dbPath);
    const stats = store.getStats();
    assert.equal(stats.schemaVersion, EXPECTED_SCHEMA_VERSION);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Concurrent reads do not block each other (WAL readers never lock)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-conc-'));
  try {
    const dbPath = join(dir, 'docgraph.db');
    const store = new SqliteKnowledgeStore(dbPath);
    store.upsertDocument({
      id: 'doc-1',
      path: '/example.md',
      relativePath: 'example.md',
      content: 'hello world',
      rawContent: 'hello world',
      extension: '.md',
      language: 'markdown',
      title: 'Example',
      description: undefined,
      tags: [],
      headings: [],
      links: [],
      codeBlocks: [],
      lineCount: 1,
      wordCount: 2,
      hash: 'h1',
      indexedAt: Date.now(),
    });

    // Open a second writer while reader is mid-flight.
    const reader = new SqliteKnowledgeStore(dbPath);
    const second = new SqliteKnowledgeStore(dbPath);
    const result = reader.getDocument('doc-1');
    assert.ok(result, 'first reader sees the upsert');

    second.upsertDocument({
      id: 'doc-2',
      path: '/other.md',
      relativePath: 'other.md',
      content: 'second',
      rawContent: 'second',
      extension: '.md',
      language: 'markdown',
      title: 'Other',
      description: undefined,
      tags: [],
      headings: [],
      links: [],
      codeBlocks: [],
      lineCount: 1,
      wordCount: 1,
      hash: 'h2',
      indexedAt: Date.now(),
    });
    const secondResult = second.getDocument('doc-2');
    assert.ok(secondResult, 'second writer persists immediately');

    reader.close();
    second.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('iterateDocuments streams in batches without materialising everything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-iter-'));
  try {
    const dbPath = join(dir, 'docgraph.db');
    const store = new SqliteKnowledgeStore(dbPath);
    for (let i = 0; i < 50; i++) {
      store.upsertDocument({
        id: `d-${i}`,
        path: `/doc-${i}.md`,
        relativePath: `doc-${i}.md`,
        content: `content ${i}`,
        rawContent: `content ${i}`,
        extension: '.md',
        language: 'markdown',
        title: `Doc ${i}`,
        description: undefined,
        tags: [],
        headings: [],
        links: [],
        codeBlocks: [],
        lineCount: 1,
        wordCount: 1,
        hash: `h${i}`,
        indexedAt: Date.now(),
      });
    }
    let total = 0;
    let batches = 0;
    await store.iterateDocuments(20, async (docs) => {
      batches++;
      total += docs.length;
    });
    assert.equal(total, 50);
    assert.ok(batches >= 3, 'should batch (50 items / 20 per batch = ~3 batches)');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
