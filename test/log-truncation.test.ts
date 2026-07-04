import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalLogger, DEFAULT_MAX_ENTRY_BYTES, DEFAULT_MAX_FIELD_BYTES } from '../src/infrastructure/logging/local-logger.js';

test('logger truncates a single ctx value above the field cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-trunc-'));
  try {
    const logger = new LocalLogger({
      projectPath: dir,
      maxFieldBytes: 64,
      maxEntryBytes: 1024,
    });
    logger.info('event', { big: 'x'.repeat(2000) });
    const raw = readFileSync(join(dir, '.docgraph', 'docgraph.log'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    assert.ok((entry.ctx.big as string).length <= 64 + 30, 'field should be truncated to near maxFieldBytes');
    assert.match(entry.ctx.big, /\[truncated\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger drops entries that exceed maxEntryBytes after minimal trim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-drop-'));
  try {
    const logger = new LocalLogger({
      projectPath: dir,
      maxFieldBytes: 8,
      maxEntryBytes: 128,
    });
    const before = logger.drops;
    logger.info('a'.repeat(1024));
    const after = logger.drops;
    assert.equal(after, before + 1, 'drop counter should increment');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger caps array.length when ctx has many items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-arr-'));
  try {
    const logger = new LocalLogger({
      projectPath: dir,
      maxFieldBytes: 4096,
      maxDepth: 4,
    });
    logger.info('sample', { items: Array.from({ length: 200 }, (_, i) => i) });
    const raw = readFileSync(join(dir, '.docgraph', 'docgraph.log'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    assert.equal(typeof entry.ctx.items, 'object');
    assert.equal((entry.ctx.items as any)['[array.length]'], 200);
    assert.ok(Array.isArray((entry.ctx.items as any).sample));
    assert.ok(((entry.ctx.items as any).sample as unknown[]).length <= 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger caps deeply nested objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-deep-'));
  try {
    const logger = new LocalLogger({ projectPath: dir, maxDepth: 3 });
    logger.info('deep', { a: { b: { c: { d: { e: 'deep' } } } } });
    const raw = readFileSync(join(dir, '.docgraph', 'docgraph.log'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    let cursor: any = entry.ctx.a;
    let depth = 0;
    while (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      depth++;
      cursor = Object.values(cursor).find((v) => typeof v === 'object' && v !== null);
      if (cursor === undefined) break;
    }
    assert.ok(depth <= 3, 'object depth is bounded by maxDepth');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger ignores Object.create(null) and circular refs cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-circ-'));
  try {
    const logger = new LocalLogger({ projectPath: dir, maxDepth: 2 });
    const obj: any = {};
    obj.cycle = obj;
    logger.info('with-cycle', obj);
    // Should not throw and should produce a single valid JSON line.
    const raw = readFileSync(join(dir, '.docgraph', 'docgraph.log'), 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default entry size cap is at least 8 KB so stack traces fit', () => {
  assert.ok(DEFAULT_MAX_ENTRY_BYTES >= 8 * 1024, 'default entry cap should accommodate stack traces');
  assert.ok(DEFAULT_MAX_FIELD_BYTES >= 1024, 'default field cap should accommodate human-readable messages');
});

import { readFileSync } from 'fs';
