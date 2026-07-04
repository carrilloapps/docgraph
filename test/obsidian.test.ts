import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObsidianSource } from '../src/infrastructure/sources/obsidian.js';

test('ObsidianSource walks a vault and parses front-matter + body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-obsidian-'));
  try {
    // Daily-note with front matter.
    const withFm = join(dir, 'daily', '2026-07-01.md');
    mkdirSync(join(dir, 'daily'));
    writeFileSync(
      withFm,
      `---
title: Skyzer MVP status
tags: [mvp, skyzer, mobile]
---

# Daily note

Working on the auth flow before [[RNFirebase]] integration.

#priority-high more progress tomorrow.
`,
      'utf-8',
    );

    // Plain markdown, no front matter.
    const plain = join(dir, 'README.md');
    writeFileSync(plain, '# Vault\nThis vault explains architecture decisions.\n', 'utf-8');

    // Hidden config dir that must be skipped.
    const ignored = join(dir, '.obsidian', 'app.json');
    mkdirSync(join(dir, '.obsidian'));
    writeFileSync(ignored, '{}', 'utf-8');

    const source = new ObsidianSource(dir);
    const docs = await source.list();

    assert.equal(docs.length, 2, 'should find two notes (.obsidian skipped)');
    const withFmDoc = docs.find((d) => d.id === 'obsidian:daily/2026-07-01.md');
    assert.ok(withFmDoc, 'expected the daily note to be indexed');
    assert.equal(withFmDoc.title, 'Skyzer MVP status');
    // Wikilinks preserve case ("RNFirebase" stays uppercase); inline #tags stay as written.
    const actualTags = (withFmDoc.tags ?? []).slice().sort();
    assert.deepEqual(actualTags, ['RNFirebase', 'mobile', 'mvp', 'priority-high', 'skyzer'].sort());

    const readme = docs.find((d) => d.id === 'obsidian:README.md');
    assert.ok(readme);
    assert.match(readme.content, /architecture decisions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ObsidianSource returns empty list when vault missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-empty-'));
  rmSync(dir, { recursive: true, force: true });
  const source = new ObsidianSource(dir);
  const docs = await source.list();
  assert.deepEqual(docs, []);
});
