import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider } from '../src/infrastructure/embeddings/local.js';
import { chunkText } from '../src/domain/chunker.js';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

test('LocalProvider produces fixed-length, L2-normalized vectors', async () => {
  const provider = new LocalProvider({ dimension: 128 });
  const { embedding } = await provider.embed({ text: 'authentication tokens and login' });
  assert.equal(embedding.length, 128);
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected unit norm, got ${norm}`);
});

test('LocalProvider is deterministic', async () => {
  const provider = new LocalProvider();
  const a = await provider.embed({ text: 'the quick brown fox' });
  const b = await provider.embed({ text: 'the quick brown fox' });
  assert.deepEqual(a.embedding, b.embedding);
});

test('LocalProvider gives higher similarity to related text', async () => {
  const provider = new LocalProvider();
  const base = (await provider.embed({ text: 'how to configure authentication and login tokens' })).embedding;
  const related = (await provider.embed({ text: 'authentication login token setup guide' })).embedding;
  const unrelated = (await provider.embed({ text: 'kubernetes docker deployment pipeline' })).embedding;
  assert.ok(cosine(base, related) > cosine(base, unrelated));
});

test('LocalProvider handles empty text without crashing', async () => {
  const provider = new LocalProvider({ dimension: 64 });
  const { embedding } = await provider.embed({ text: '' });
  assert.equal(embedding.length, 64);
  assert.ok(embedding.every((v) => v === 0));
});

test('LocalProvider batchEmbed matches embed', async () => {
  const provider = new LocalProvider();
  const single = (await provider.embed({ text: 'hello world' })).embedding;
  const batch = (await provider.batchEmbed({ texts: ['hello world', 'other'] })).embeddings;
  assert.deepEqual(batch[0], single);
  assert.equal(batch.length, 2);
});

test('chunkText returns a single chunk for short text', () => {
  const chunks = chunkText('short text', { chunkSize: 100, chunkOverlap: 10 });
  assert.deepEqual(chunks, ['short text']);
});

test('chunkText splits long text with overlap and terminates', () => {
  const text = 'a'.repeat(1000);
  const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 100));
});

test('chunkText returns empty array for blank input', () => {
  assert.deepEqual(chunkText('   \n  ', { chunkSize: 100, chunkOverlap: 10 }), []);
});
