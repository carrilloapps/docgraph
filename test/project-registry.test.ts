import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProjectRegistry } from '../src/project-registry.js';

// Windows holds a lock on .docgraph/docgraph.db while the Container is alive;
// rather than fight Temp cleanup, these tests create temp dirs without deleting
// (the OS reaps tmpdirs at session boundaries), and close every Container so
// each test leaves no locked file behind.

test('ProjectRegistry creates one container per project path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'docgraph-registry-'));
  const reg = new ProjectRegistry({ maxProjects: 4 });
  const a = reg.get(tmp);
  const b = reg.get(tmp);
  assert.equal(a, b, 'same project path returns same container');
  assert.ok(reg.has(tmp));
  reg.close();
});

test('ProjectRegistry treats project paths with different trailing separators as the same project', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'docgraph-registry-trailing-'));
  const reg = new ProjectRegistry({ maxProjects: 4 });
  const a = reg.get(tmp);
  const b = reg.get(tmp + (process.platform === 'win32' ? '\\\\' : '/'));
  assert.equal(a, b);
  reg.close();
});

test('ProjectRegistry evicts the least-recently-used project when full', () => {
  const tmpA = mkdtempSync(join(tmpdir(), 'docgraph-a-'));
  const tmpB = mkdtempSync(join(tmpdir(), 'docgraph-b-'));
  const tmpC = mkdtempSync(join(tmpdir(), 'docgraph-c-'));
  const reg = new ProjectRegistry({ maxProjects: 2 });
  reg.get(tmpA);
  reg.get(tmpB);
  reg.get(tmpC);
  assert.equal(reg.has(tmpA), false, 'oldest project evicted');
  assert.ok(reg.has(tmpB));
  assert.ok(reg.has(tmpC));
  reg.close();
});

test('ProjectRegistry.resolveProjectPath prefers explicit > env > cwd', () => {
  const old = process.env.DOCGRAPH_PROJECT;
  process.env.DOCGRAPH_PROJECT = '/from/env';
  const reg = new ProjectRegistry();
  assert.equal(reg.resolveProjectPath('/explicit/path'), '/explicit/path');
  delete process.env.DOCGRAPH_PROJECT;
  assert.equal(reg.resolveProjectPath('/explicit/path'), '/explicit/path');
  process.env.DOCGRAPH_PROJECT = old;
});
