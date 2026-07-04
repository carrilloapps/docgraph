import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectPath } from '../src/presentation/cli/args.js';

const CWD = '/home/project';

test('search query is never treated as a project path', () => {
  const argv = ['node', 'cli.js', 'search', 'authentication'];
  assert.equal(resolveProjectPath(argv, CWD), CWD);
});

test('search with flags still resolves to cwd', () => {
  const argv = ['node', 'cli.js', 'search', 'authentication', '--limit=5'];
  assert.equal(resolveProjectPath(argv, CWD), CWD);
});

test('index uses the first positional as the path', () => {
  const argv = ['node', 'cli.js', 'index', './my-docs'];
  assert.equal(resolveProjectPath(argv, CWD), './my-docs');
});

test('index without a path falls back to cwd', () => {
  const argv = ['node', 'cli.js', 'index'];
  assert.equal(resolveProjectPath(argv, CWD), CWD);
});

test('--path flag wins for any command', () => {
  const argv = ['node', 'cli.js', 'search', 'auth', '--path=/opt/repo'];
  assert.equal(resolveProjectPath(argv, CWD), '/opt/repo');
});

test('settings subcommand is not treated as a path', () => {
  const argv = ['node', 'cli.js', 'settings', 'show'];
  assert.equal(resolveProjectPath(argv, CWD), CWD);
});

test('search with an explicit trailing path uses that path', () => {
  const argv = ['node', 'cli.js', 'search', 'authentication', './repo', '--limit=5'];
  assert.equal(resolveProjectPath(argv, CWD), './repo');
});
