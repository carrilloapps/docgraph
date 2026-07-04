import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Container } from '../src/container.js';

/**
 * Verifies the remote-document hash-skip added to
 * `IndexingService.indexRemoteDocument`: a remote pull re-fetches every
 * document on every run (there's no filesystem mtime to check cheaply
 * beforehand), so re-indexing an unchanged remote doc must be a no-op
 * rather than re-embedding it every time.
 *
 * Uses the Obsidian source (plain filesystem vault, no network) wired
 * through the Container/SourceRegistry exactly as `docgraph index` would,
 * so this is a true integration test of the remote pull path without any
 * mocking. `embedding.provider` is pinned to `local` for determinism.
 */
function setup(): { projectDir: string; vaultDir: string; cleanup: () => void } {
  const projectDir = mkdtempSync(join(tmpdir(), 'docgraph-remote-it-'));
  // The vault lives outside the project directory so the filesystem
  // DocumentSource (which scans the whole project path) never also picks up
  // the note directly — keeping the remote pull's count unambiguous.
  const vaultDir = mkdtempSync(join(tmpdir(), 'docgraph-remote-vault-'));

  mkdirSync(join(projectDir, '.docgraph'), { recursive: true });
  writeFileSync(
    join(vaultDir, 'note.md'),
    '# Vault Note\n\nSome remote content about caching strategies.\n',
    'utf-8',
  );
  writeFileSync(
    join(projectDir, '.docgraph', 'settings.json'),
    JSON.stringify({
      embedding: { provider: 'local' },
      sources: {
        sources: {
          obsidian: { enabled: true, options: { vaultPath: vaultDir } },
        },
      },
    }),
  );

  return {
    projectDir,
    vaultDir,
    cleanup: () => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(vaultDir, { recursive: true, force: true });
    },
  };
}

test('re-indexing an unchanged remote (Obsidian) document is skipped on the second pass', async () => {
  const { projectDir, cleanup } = setup();

  const first = new Container(projectDir);
  try {
    const firstResult = await first.indexing.indexProject();
    assert.equal(firstResult.remoteSources?.obsidian, 1, 'first pass should index the one vault note');
  } finally {
    first.close();
  }

  const second = new Container(projectDir);
  try {
    const secondResult = await second.indexing.indexProject();
    assert.equal(
      secondResult.remoteSources?.obsidian,
      0,
      'second pass should skip the unchanged vault note (hash unchanged)',
    );
    // The filesystem side of the project has no local docs, so only the
    // remote pull is exercised here.
    assert.equal(secondResult.documents, 0);
  } finally {
    second.close();
    cleanup();
  }
});

test('re-indexing after the remote document changes indexes it again', async () => {
  const { projectDir, vaultDir, cleanup } = setup();

  const first = new Container(projectDir);
  try {
    const firstResult = await first.indexing.indexProject();
    assert.equal(firstResult.remoteSources?.obsidian, 1);
  } finally {
    first.close();
  }

  // Mutate the vault note's content so its hash changes.
  writeFileSync(
    join(vaultDir, 'note.md'),
    '# Vault Note\n\nUpdated content about caching invalidation strategies.\n',
    'utf-8',
  );

  const second = new Container(projectDir);
  try {
    const secondResult = await second.indexing.indexProject();
    assert.equal(
      secondResult.remoteSources?.obsidian,
      1,
      'changed vault note should be re-indexed, not skipped',
    );
  } finally {
    second.close();
    cleanup();
  }
});
