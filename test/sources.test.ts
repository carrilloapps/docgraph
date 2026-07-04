import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SourceRegistry, SOURCE_PROVIDERS } from '../src/infrastructure/sources/registry.js';
import { ObsidianSource } from '../src/infrastructure/sources/obsidian.js';

test('SOURCE_PROVIDERS contains the expected names', () => {
  const names = SOURCE_PROVIDERS.map((p) => p.name).sort();
  assert.deepEqual(
    names,
    ['confluence', 'confluence-dc', 'github', 'jira', 'linear', 'notion', 'obsidian', 'openapi', 'postman'].sort(),
  );
});

test('SourceRegistry reports enabled / configured status', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'docgraph-sources-'));
  try {
    const configs = {
      obsidian: { enabled: true, options: { vaultPath: tmp } },
      jira: { enabled: false, options: {} },
    };
    const reg = new SourceRegistry(configs as any, tmp);
    const list = reg.list();
    const obsidian = list.find((s) => s.name === 'obsidian')!;
    const jira = list.find((s) => s.name === 'jira')!;
    const notion = list.find((s) => s.name === 'notion')!;
    assert.ok(obsidian.enabled, 'obsidian enabled');
    assert.ok(obsidian.configured, 'obsidian configured');
    assert.equal(jira.enabled, false, 'jira disabled');
    assert.ok(jira.configured, 'jira still appears as configured but disabled');
    assert.equal(notion.enabled, false, 'notion disabled by default');
    assert.equal(notion.configured, false, 'notion not configured by default');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('SourceRegistry.get() returns a live Obsidian source when enabled', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'docgraph-sources-live-'));
  try {
    writeFileSync(join(tmp, 'note.md'), '# Hello\nWorld', 'utf-8');
    const reg = new SourceRegistry(
      { obsidian: { enabled: true, options: { vaultPath: tmp } } } as any,
      tmp,
    );
    const source = reg.get('obsidian');
    assert.ok(source instanceof ObsidianSource, 'returns an ObsidianSource');
    const missing = reg.get('nonexistent');
    assert.equal(missing, null, 'returns null for unknown sources');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('SourceRegistry returns null when source is disabled', () => {
  const reg = new SourceRegistry(
    { notion: { enabled: false, options: { token: 'x' } } } as any,
    '/tmp',
  );
  assert.equal(reg.get('notion'), null, 'disabled sources are never instantiated');
});
