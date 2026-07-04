import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * End-to-end regression for every user-facing CLI command. Each command is
 * spawned as its own process against a throwaway fixture project, so this
 * exercises the real compiled entrypoint — argument parsing, the ESM module
 * graph, `Container` wiring and SQLite I/O — exactly as an end user would.
 *
 * This is the layer that catches failures unit tests miss: e.g. `install`
 * crashed at runtime with `ReferenceError: __dirname is not defined` under
 * ESM even though every installer unit test (which only spawns the sibling
 * `installer.js` directly) stayed green.
 */

const cliPath = fileURLToPath(new URL('../src/presentation/cli/cli.js', import.meta.url));

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('CLI end-to-end', () => {
  let root: string;
  let fixture: string;
  let home: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'docgraph-cli-'));
    fixture = join(root, 'fixture');
    home = join(root, 'home');
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(fixture, 'README.md'),
      '---\ntitle: Sample Project\ntags: [auth, api]\n---\n# Sample Project\nThis handles authentication and API access.\n',
    );
    writeFileSync(join(fixture, 'docs', 'guide.adoc'), '= Guide\n== Authentication\nLogin flow and tokens.\n');
    writeFileSync(join(fixture, 'docs', 'notes.rst'), 'Notes\n=====\nVector search details.\n');
    writeFileSync(join(fixture, 'src.ts'), 'export function authenticate() { return true }\n');

    const indexed = runCli(['index', `--path=${fixture}`]);
    assert.equal(indexed.status, 0, `index failed: ${indexed.stderr}`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('index reported documents and vectors', () => {
    // Re-run to confirm idempotency of the write path.
    const { status, stdout } = runCli(['reindex', `--path=${fixture}`]);
    assert.equal(status, 0);
    assert.match(stdout, /Documents indexed:\s*\d+/);
  });

  it('stats prints human-readable statistics', () => {
    const { status, stdout } = runCli(['stats', `--path=${fixture}`]);
    assert.equal(status, 0);
    assert.match(stdout, /[Dd]ocuments/);
  });

  it('stats-json emits valid JSON with a document count', () => {
    const { status, stdout } = runCli(['stats-json', `--path=${fixture}`]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(typeof parsed.documents, 'number');
    assert.ok(parsed.documents > 0, 'expected at least one indexed document');
  });

  it('search returns hits for an indexed term', () => {
    const { status, stdout } = runCli(['search', 'authentication', `--path=${fixture}`]);
    assert.equal(status, 0);
    assert.ok(stdout.trim().length > 0, 'expected non-empty search output');
  });

  it('search --format=json emits a valid JSON array of results', () => {
    const { status, stdout } = runCli(['search', 'api', '--format=json', `--path=${fixture}`]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), 'expected a JSON array of results');
  });

  it('list enumerates indexed documents', () => {
    const { status } = runCli(['list', `--path=${fixture}`]);
    assert.equal(status, 0);
  });

  it('files lists supported extensions', () => {
    const { status, stdout } = runCli(['files']);
    assert.equal(status, 0);
    assert.match(stdout, /\.md/);
  });

  it('providers lists embedding providers', () => {
    const { status, stdout } = runCli(['providers']);
    assert.equal(status, 0);
    assert.match(stdout, /local/);
  });

  it('settings show / settings path succeed', () => {
    assert.equal(runCli(['settings', 'show', `--path=${fixture}`]).status, 0);
    assert.equal(runCli(['settings', 'path', `--path=${fixture}`]).status, 0);
  });

  it('exclude list, sources list, apis list succeed', () => {
    assert.equal(runCli(['exclude', 'list', `--path=${fixture}`]).status, 0);
    assert.equal(runCli(['sources', 'list', `--path=${fixture}`]).status, 0);
    assert.equal(runCli(['apis', 'list', `--path=${fixture}`]).status, 0);
  });

  it('logs --tail reads the project log without error', () => {
    const { status } = runCli(['logs', '--tail=5', `--path=${fixture}`]);
    assert.equal(status, 0);
  });

  it('export then import --replace round-trips the database', () => {
    const backup = join(root, 'backup.db');
    assert.equal(runCli(['export', backup, `--path=${fixture}`]).status, 0);
    assert.ok(existsSync(backup), 'export did not write the backup file');
    assert.equal(runCli(['import', backup, '--replace', `--path=${fixture}`]).status, 0);
  });

  it('import without a flag refuses to clobber a populated database', () => {
    const backup = join(root, 'backup2.db');
    assert.equal(runCli(['export', backup, `--path=${fixture}`]).status, 0);
    const { status, stderr, stdout } = runCli(['import', backup, `--path=${fixture}`]);
    assert.notEqual(status, 0, 'import should refuse without --replace/--merge');
    assert.match(stdout + stderr, /--replace|--merge/);
  });

  it('serve prints an MCP configuration', () => {
    const { status, stdout } = runCli(['serve', `--path=${fixture}`]);
    assert.equal(status, 0);
    assert.match(stdout, /docgraph/);
  });

  it('--help prints usage', () => {
    const { status, stdout } = runCli(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /Usage: docgraph/);
  });

  it('install runs end-to-end without a __dirname/ESM crash (sandboxed HOME)', () => {
    const env = { HOME: home, USERPROFILE: home };
    const { status, stderr } = runCli(['install', `--path=${fixture}`], env);
    assert.equal(status, 0, `install failed: ${stderr}`);
    assert.ok(!/__dirname|ReferenceError/.test(stderr), `install regressed with ESM error: ${stderr}`);
    // With no globally-detected agents, install still wires the project-local
    // Claude Code config — proof it got past agent resolution and did real work.
    assert.ok(existsSync(join(fixture, '.mcp.json')), 'install did not write project .mcp.json');
  });

  it('uninstall runs end-to-end without a crash (sandboxed HOME)', () => {
    const env = { HOME: home, USERPROFILE: home };
    const { status, stderr } = runCli(['uninstall', `--path=${fixture}`], env);
    assert.equal(status, 0, `uninstall failed: ${stderr}`);
    assert.ok(!/__dirname|ReferenceError/.test(stderr), `uninstall regressed with ESM error: ${stderr}`);
  });

  it('--read-only forbids write commands (index) and exits non-zero', () => {
    const { status, stderr } = runCli(['index', '--read-only', `--path=${fixture}`]);
    assert.notEqual(status, 0, 'index --read-only should refuse');
    assert.match(stderr, /read-only/i);
  });

  it('DOCGRAPH_READ_ONLY=1 forbids write commands (reindex)', () => {
    const { status } = runCli(['reindex', `--path=${fixture}`], { DOCGRAPH_READ_ONLY: '1' });
    assert.notEqual(status, 0, 'reindex should refuse under DOCGRAPH_READ_ONLY=1');
  });

  it('short command alias `s` resolves to search', () => {
    const { status, stdout } = runCli(['s', 'authentication', `--path=${fixture}`]);
    assert.equal(status, 0);
    assert.ok(stdout.trim().length > 0);
  });

  it('short command alias `st` resolves to stats', () => {
    const { status, stdout } = runCli(['st', `--path=${fixture}`]);
    assert.equal(status, 0);
    assert.match(stdout, /[Dd]ocuments/);
  });

  it('short command alias `ls` resolves to list', () => {
    assert.equal(runCli(['ls', `--path=${fixture}`]).status, 0);
  });

  it('package.json exposes both long and short binary aliases', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));
    for (const bin of ['docgraph', 'dg', 'docgraph-mcp', 'dg-mcp', 'docgraph-install', 'dg-install']) {
      assert.ok(pkg.bin[bin], `missing bin alias: ${bin}`);
    }
  });
});
