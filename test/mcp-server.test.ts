import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * End-to-end regression for the MCP server (`docgraph-mcp serve`). It speaks
 * newline-delimited JSON-RPC over stdio, so this drives it exactly like an
 * MCP client would: spawn the compiled server, write a batch of requests,
 * close stdin, and assert on the responses it streams back on stdout.
 */

const cliPath = fileURLToPath(new URL('../src/presentation/cli/cli.js', import.meta.url));
const serverPath = fileURLToPath(new URL('../src/presentation/mcp/server.js', import.meta.url));

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function driveServer(project: string, requests: object[]): Promise<RpcResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, 'serve'], {
      env: { ...process.env, DOCGRAPH_PROJECT: project, DOCGRAPH_NO_WATCH: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server timed out. stderr: ${stderr}`));
    }, 30000);

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      const responses = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RpcResponse);
      resolve(responses);
    });

    for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
    child.stdin.end();
  });
}

describe('MCP server end-to-end (stdio JSON-RPC)', () => {
  let root: string;
  let fixture: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'docgraph-mcp-'));
    fixture = join(root, 'fixture');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(
      join(fixture, 'README.md'),
      '# Sample\nThis document is about authentication and vector search.\n',
    );
    const indexed = spawnSync(process.execPath, [cliPath, 'index', `--path=${fixture}`], { encoding: 'utf-8' });
    assert.equal(indexed.status, 0, `index failed: ${indexed.stderr}`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('initialize returns protocol version and server info with the real package version', async () => {
    const [res] = await driveServer(fixture, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    assert.equal(res.id, 1);
    assert.ok(res.result, 'expected an initialize result');
    const result = res.result as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
    assert.ok(result.protocolVersion, 'expected a protocolVersion');
    assert.equal(result.serverInfo?.name, 'docgraph');
    // Version must be resolved dynamically from package.json, never hard-coded.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));
    assert.equal(result.serverInfo?.version, pkg.version, 'serverInfo.version must match package.json');
  });

  it('tools/list advertises the full tool set', async () => {
    const [res] = await driveServer(fixture, [{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
    const result = res.result as { tools: { name: string }[] };
    const names = new Set(result.tools.map((t) => t.name));
    for (const expected of [
      'search',
      'explore',
      'get_document',
      'get_related',
      'get_stats',
      'list_documents',
      'get_document_graph',
      'list_projects',
      'index_project',
      'index_file',
    ]) {
      assert.ok(names.has(expected), `missing tool: ${expected}`);
    }
  });

  it('tools/call search returns results for an indexed term', async () => {
    const [res] = await driveServer(fixture, [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'authentication' } } },
    ]);
    assert.equal(res.id, 3);
    assert.ok(!res.error, `search errored: ${JSON.stringify(res.error)}`);
    assert.ok(res.result, 'expected a search result');
  });

  it('tools/call get_stats reports the indexed corpus', async () => {
    const [res] = await driveServer(fixture, [
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_stats', arguments: {} } },
    ]);
    assert.equal(res.id, 4);
    assert.ok(!res.error, `get_stats errored: ${JSON.stringify(res.error)}`);
  });

  it('the `docgraph mcp` CLI subcommand starts the same server', async () => {
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: { ...process.env, DOCGRAPH_PROJECT: fixture, DOCGRAPH_NO_WATCH: '1' },
    });
    let stdout = '';
    const done = new Promise<RpcResponse[]>((resolve) => {
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.on('close', () =>
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l) as RpcResponse),
        ),
      );
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} }) + '\n');
    child.stdin.end();
    const [res] = await done;
    assert.equal(res.id, 9);
    assert.equal((res.result as { serverInfo?: { name?: string } }).serverInfo?.name, 'docgraph');
  });

  it('read-only mode rejects the index_project write tool', async () => {
    const child = spawn(process.execPath, [serverPath, 'serve', '--read-only'], {
      env: { ...process.env, DOCGRAPH_PROJECT: fixture, DOCGRAPH_NO_WATCH: '1' },
    });
    let stdout = '';
    const done = new Promise<RpcResponse[]>((resolve) => {
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.on('close', () =>
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l) as RpcResponse),
        ),
      );
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'index_project', arguments: {} } }) + '\n',
    );
    child.stdin.end();
    const responses = await done;
    const res = responses.find((r) => r.id === 5);
    assert.ok(res, 'expected a response for id=5');
    assert.ok(res!.error, 'expected an error rejecting index_project in read-only mode');
    assert.match(res!.error!.message, /read-only/i);
  });
});
