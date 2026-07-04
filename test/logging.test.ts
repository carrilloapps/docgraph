import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalLogger, DEFAULT_MAX_BYTES, readLog } from '../src/infrastructure/logging/local-logger.js';

test('LocalLogger writes JSON Lines to .docgraph/docgraph.log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-'));
  const logger = new LocalLogger({ projectPath: dir, level: 'debug' });
  logger.info('boot', { version: '1.0.0' });
  logger.warn('partial', { reason: 'demo' });
  logger.debug('verbose', { secret: 'never-logged' });

  const logFile = join(dir, '.docgraph', 'docgraph.log');
  assert.ok(existsSync(logFile), 'log file should exist');
  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.ts, 'string');
    assert.ok(['info', 'warn', 'debug'].includes(parsed.level));
    assert.equal(typeof parsed.msg, 'string');
  }
  const infoEntry = JSON.parse(lines[0]);
  assert.deepEqual(infoEntry.ctx, { version: '1.0.0' });
});

test('LocalLogger filters by level', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-lvl-'));
  const logger = new LocalLogger({ projectPath: dir, level: 'warn' });
  logger.debug('should be filtered');
  logger.info('also filtered');
  logger.warn('this one stays');
  logger.error('and this too');

  const logFile = join(dir, '.docgraph', 'docgraph.log');
  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"warn"/);
  assert.match(lines[1], /"error"/);
});

test('LocalLogger withContext binds fields to every entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-child-'));
  const logger = new LocalLogger({ projectPath: dir }).child({ project: 'test', session: 'a' });
  logger.info('first');
  logger.info('second');

  const logFile = join(dir, '.docgraph', 'docgraph.log');
  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.ctx.project, 'test');
    assert.equal(parsed.ctx.session, 'a');
  }
});

test('LocalLogger rotates the log when size exceeds maxBytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-rot-'));
  // Tiny cap so we definitely overflow.
  const logger = new LocalLogger({ projectPath: dir, maxBytes: 1024, maxFiles: 2 });
  for (let i = 0; i < 500; i++) logger.info('filler', { i, payload: 'x'.repeat(50) });

  const logFile = join(dir, '.docgraph', 'docgraph.log');
  assert.ok(existsSync(logFile), 'active log still present');
  assert.ok(existsSync(logFile + '.1'), 'rotated .1 present');
  // The active log must remain smaller than the cap.
  assert.ok(readFileSync(logFile, 'utf-8').length <= 2 * 1024);
});

test('readLog returns the last N entries, decoded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-read-'));
  const logger = new LocalLogger({ projectPath: dir });
  logger.info('one');
  logger.info('two');
  logger.info('three');
  logger.info('four');
  logger.info('five');

  const result = await readLog(dir, { tail: 3 });
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].msg, 'three');
  assert.equal(result.entries[2].msg, 'five');
  assert.equal(result.stats.byLevel.info, 3);
});

test('readLog level filter excludes lower-severity entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-filter-'));
  const logger = new LocalLogger({ projectPath: dir });
  logger.debug('debug 1');
  logger.info('info 1');
  logger.warn('warn 1');
  logger.error('error 1');

  const errors = await readLog(dir, { level: 'error', tail: 10 });
  assert.equal(errors.entries.length, 1);
  assert.equal(errors.entries[0].msg, 'error 1');
});

test('readLog grep substring search works across fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-grep-'));
  const logger = new LocalLogger({ projectPath: dir });
  logger.info('startup complete', { mode: 'vector', provider: 'local' });
  logger.info('indexed 12 docs', { mode: 'filesystem' });
  logger.warn('partial pull', { source: 'notion' });

  const vectorHits = await readLog(dir, { grep: 'vector', tail: 10 });
  assert.equal(vectorHits.entries.length, 1);
  assert.equal(vectorHits.entries[0].msg, 'startup complete');
});

import { noopLogger } from '../src/infrastructure/logging/local-logger.js';

test('no-op logger swallows writes silently', () => {
  assert.doesNotThrow(() => {
    noopLogger.info('silent');
    noopLogger.error('silent');
    noopLogger.debug('silent');
  });
});

test('logError normalises Error objects into structured entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-err-'));
  const logger = new LocalLogger({ projectPath: dir });
  logger.logError(new Error('boom'), { source: 'jira' });
  logger.logError('a plain string', { context: 'handles-non-errors' });

  const lines = readFileSync(join(dir, '.docgraph', 'docgraph.log'), 'utf-8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  assert.equal(first.level, 'error');
  assert.match(first.ctx.message, /boom/);
  assert.match(first.ctx.stack, /Error: boom/);
  assert.equal(first.ctx.source, 'jira');

  const second = JSON.parse(lines[1]);
  assert.equal(second.ctx.message, 'a plain string');
});

test('logger survives a missing .docgraph directory and creates it lazily', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-logger-fresh-'));
  // No .docgraph dir exists yet.
  assert.equal(existsSync(join(dir, '.docgraph')), false);
  const logger = new LocalLogger({ projectPath: dir });
  logger.info('created on demand');
  assert.ok(existsSync(join(dir, '.docgraph', 'docgraph.log')));
});
