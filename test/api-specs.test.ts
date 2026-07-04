import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthHeaders, PostmanSource, OpenApiSource } from '../src/infrastructure/sources/api-specs.js';

test('buildAuthHeaders honours each mode', () => {
  assert.deepEqual(buildAuthHeaders(undefined, { 'X-Foo': '1' }), { 'X-Foo': '1' });
  assert.deepEqual(buildAuthHeaders({ mode: 'none' }, {}), {});
  assert.deepEqual(
    buildAuthHeaders({ mode: 'basic', username: 'alice', password: 's3cret' }),
    { Authorization: 'Basic YWxpY2U6czNjcmV0' },
  );
  assert.deepEqual(
    buildAuthHeaders({ mode: 'bearer', token: 'tk' }),
    { Authorization: 'Bearer tk' },
  );
  assert.deepEqual(
    buildAuthHeaders({ mode: 'apiKey', apiKey: 'k', apiKeyHeader: 'X-Api-Key' }),
    { 'X-Api-Key': 'k' },
  );
  assert.deepEqual(
    buildAuthHeaders({ mode: 'custom', headers: { 'X-Tenant': 'acme' } }),
    { 'X-Tenant': 'acme' },
  );
});

test('buildAuthHeaders stacks custom headers on top of mode headers', () => {
  const headers = buildAuthHeaders(
    { mode: 'bearer', token: 'tk', headers: { 'X-Tenant': 'acme' } },
    { 'X-Existing': '1' },
  );
  assert.equal(headers.Authorization, 'Bearer tk');
  assert.equal(headers['X-Tenant'], 'acme');
  assert.equal(headers['X-Existing'], '1');
});

test('OpenApiSource constructor validates target', () => {
  assert.throws(() => new OpenApiSource({ url: '', path: '' }));
  assert.throws(() => new OpenApiSource({}));
  const source = new OpenApiSource({ url: 'https://example.com/openapi.json' });
  assert.equal(source.name, 'openapi');
  assert.ok(source);
});

test('OpenApiSource rejects when remote endpoint returns non-OK', async () => {
  const source = new OpenApiSource({ url: 'https://example.com/openapi-missing.json' });
  await assert.rejects(() => source.list(), /HTTP 404/);
});

test('PostmanSource rejects when target is empty', () => {
  assert.throws(() => new PostmanSource({}), /requires `url` or `path`/);
});
