import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `src/presentation/installer/installer.ts` exports nothing — every config
 * builder (`buildTomlServerBlock`, `upsertMcpConfig`, `printConfigSnippet`,
 * ...) is a module-private function, and the module runs `main()` as a
 * side-effecting top-level statement guarded only by
 * `process.argv[1]?.endsWith('installer.js')`. Importing the compiled module
 * directly from a test would therefore either skip `main()` silently (no
 * assertions possible) or — once run as its own process — actually execute
 * it, so it cannot be unit-tested via a normal `import`.
 *
 * Instead, this exercises the installer's pure, side-effect-free CLI paths
 * (`--print-config=<id>` and `--help`) by spawning the compiled script as a
 * child process. Both paths return before any agent detection or config
 * file I/O happens (see `main()`'s early `if (printConfigFlag) { ... return; }`
 * and `if (args.includes('--help')) { ... return; }` branches), so nothing
 * on disk is touched and no network calls are made — this is safe to run
 * anywhere, including CI, without mocking.
 */

const installerPath = fileURLToPath(new URL('../src/presentation/installer/installer.js', import.meta.url));

function runInstaller(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [installerPath, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('--print-config=claude prints an mcpServers JSON block with command/args', () => {
  const { status, stdout } = runInstaller(['--print-config=claude']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.mcpServers?.docgraph, `expected mcpServers.docgraph, got ${stdout}`);
  assert.equal(typeof parsed.mcpServers.docgraph.command, 'string');
  assert.ok(Array.isArray(parsed.mcpServers.docgraph.args));
  assert.equal(parsed.mcpServers.docgraph.type, 'stdio');
});

test('--print-config=cursor prints the same generic mcpServers JSON shape', () => {
  const { status, stdout } = runInstaller(['--print-config=cursor']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.mcpServers?.docgraph);
  assert.ok(Array.isArray(parsed.mcpServers.docgraph.args));
});

test('--print-config=opencode prints an mcp{} JSON block with a command array', () => {
  const { status, stdout } = runInstaller(['--print-config=opencode']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.mcp?.docgraph, `expected mcp.docgraph, got ${stdout}`);
  assert.ok(Array.isArray(parsed.mcp.docgraph.command));
  assert.equal(parsed.mcp.docgraph.enabled, true);
});

test('--print-config=codex prints a [mcp_servers.docgraph] TOML table with command/args', () => {
  const { status, stdout } = runInstaller(['--print-config=codex']);
  assert.equal(status, 0);
  assert.match(stdout, /\[mcp_servers\.docgraph\]/);
  assert.match(stdout, /command\s*=\s*"/);
  assert.match(stdout, /args\s*=\s*\[/);
});

for (const agent of ['gemini', 'kiro', 'antigravity', 'hermes']) {
  test(`--print-config=${agent} prints a valid mcpServers JSON block`, () => {
    const { status, stdout } = runInstaller([`--print-config=${agent}`]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.mcpServers?.docgraph, `expected mcpServers.docgraph for ${agent}, got ${stdout}`);
    assert.equal(typeof parsed.mcpServers.docgraph.command, 'string');
    assert.ok(Array.isArray(parsed.mcpServers.docgraph.args));
  });
}

test('--print-config with an unknown agent id exits non-zero and prints nothing', () => {
  const { status, stdout } = runInstaller(['--print-config=not-a-real-agent']);
  assert.notEqual(status, 0);
  assert.equal(stdout.trim(), '');
});

test('--help prints usage listing supported agents and exits 0 without touching any config', () => {
  const { status, stdout } = runInstaller(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /Usage: docgraph-install/);
  assert.match(stdout, /claude/);
  assert.match(stdout, /codex/);
});
