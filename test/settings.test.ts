import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings, resolveEnvVariables, getEffectiveExcludePatterns } from '../src/infrastructure/config/settings.js';

test('loadSettings returns defaults when no config exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-settings-'));
  try {
    const settings = loadSettings(dir);
    assert.equal(settings.embedding.provider, 'auto');
    assert.equal(settings.indexing.chunkSize, 512);
    assert.equal(settings.search.minScore, 0.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings merges user overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-settings-'));
  try {
    mkdirSync(join(dir, '.docgraph'), { recursive: true });
    writeFileSync(
      join(dir, '.docgraph', 'settings.json'),
      JSON.stringify({ search: { limit: 42 }, embedding: { provider: 'openai' } }),
    );
    const settings = loadSettings(dir);
    assert.equal(settings.search.limit, 42);
    assert.equal(settings.embedding.provider, 'openai');
    // Untouched defaults remain intact.
    assert.equal(settings.indexing.chunkSize, 512);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveEnvVariables expands ${VAR} placeholders', () => {
  process.env.DOCGRAPH_TEST_KEY = 'secret-value';
  const resolved = resolveEnvVariables({ apiKey: '${DOCGRAPH_TEST_KEY}', model: 'auto' });
  assert.deepEqual(resolved, { apiKey: 'secret-value', model: 'auto' });
  delete process.env.DOCGRAPH_TEST_KEY;
});

test('getEffectiveExcludePatterns includes defaults and custom patterns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-settings-'));
  try {
    const settings = loadSettings(dir);
    settings.exclude.patterns = ['**/secret/**'];
    const patterns = getEffectiveExcludePatterns(settings);
    assert.ok(patterns.includes('**/node_modules/**'));
    assert.ok(patterns.includes('**/secret/**'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore negation (!) rules are dropped, never turned into exclude patterns', () => {
  // A leading `!` passed to minimatch as an exclude pattern matches EVERYTHING
  // except the pattern, which would exclude the whole project and index zero
  // documents. Negations must be skipped; a leading `/` is normalized.
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-gitignore-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n.vscode/*\n!.vscode/settings.json\n/dist\n');
    const settings = loadSettings(dir);
    settings.exclude.useGitignore = true;
    const patterns = getEffectiveExcludePatterns(settings, dir);
    assert.ok(!patterns.some((p) => p.startsWith('!')), 'no pattern may start with "!" (would match-all)');
    assert.ok(patterns.includes('node_modules'), 'plain gitignore entries are kept');
    assert.ok(patterns.includes('dist'), 'leading-slash entries are normalized to relative');
    assert.ok(!patterns.includes('/dist'), 'the anchored form must be normalized away');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
