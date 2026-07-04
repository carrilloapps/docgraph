import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { RemoteDocument, RemoteSource, SourceProvider } from './types.js';
import { defineSource } from './http-remote-source.js';
import { ApiAuthConfig, ApiAuthMode } from '../config/settings.js';

/**
 * Build a request headers map from an {@link ApiAuthConfig}. Applied on top
 * of the caller-supplied `extra` so simple calls don't repeat the boilerplate.
 */
export function buildAuthHeaders(auth: ApiAuthConfig | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (!auth) return headers;
  switch (auth.mode) {
    case 'none':
      break;
    case 'basic': {
      const creds = Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
      break;
    }
    case 'bearer':
      if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
      break;
    case 'apiKey': {
      const headerName = auth.apiKeyHeader || 'x-api-key';
      if (auth.apiKey) headers[headerName] = auth.apiKey;
      break;
    }
    case 'custom':
      // Auth mode "custom" ignores auth.* fields and trusts headers[] entirely.
      break;
  }
  if (auth.headers) {
    for (const [k, v] of Object.entries(auth.headers)) headers[k] = v;
  }
  return headers;
}

/**
 * Adapter that pulls a Postman v2.1 collection file (local path or remote URL)
 * and renders every endpoint as a {@link RemoteDocument}. Groups become
 * `/`-joined tags so the resulting index is still traversable through the
 * knowledge graph.
 *
 * Authentication: any mode from {@link ApiAuthConfig} (`none` / `basic` /
 * `bearer` / `apiKey` / `custom`).
 */
export class PostmanSource implements RemoteSource {
  readonly name = 'postman';
  readonly description = 'Postman v2.1 collection (local path or URL)';

  private readonly target: string;
  private readonly auth?: ApiAuthConfig;

  constructor(options: Record<string, unknown>) {
    const target = String(options.url || options.path || '');
    if (!target) throw new Error('postman source requires `url` or `path`');
    this.target = target;
    this.auth = (options.auth as ApiAuthConfig | undefined) ?? undefined;
  }

  async list(): Promise<RemoteDocument[]> {
    const json = await this.loadCollection(this.target);
    return flattenCollection(json, this.name);
  }

  async get(id: string): Promise<RemoteDocument | null> {
    const all = await this.list();
    return all.find((d) => d.id === id) ?? null;
  }

  /** Loads from URL or filesystem; supports gzipped responses too. */
  private async loadCollection(target: string): Promise<any> {
    if (/^https?:\/\//i.test(target)) {
      const headers = buildAuthHeaders(this.auth, {
        Accept: 'application/json',
        'User-Agent': 'docgraph/1.0',
      });
      const response = await fetch(target, { headers });
      if (!response.ok) throw new Error(`[postman] HTTP ${response.status}: ${await response.text()}`);
      return await response.json();
    }
    if (!existsSync(target)) throw new Error(`[postman] file not found: ${target}`);
    const content = readFileSync(target, 'utf-8');
    return target.toLowerCase().endsWith('.yaml') || target.toLowerCase().endsWith('.yml')
      ? parseYaml(content)
      : JSON.parse(content);
  }
}

interface PostmanCollection {
  info?: { name?: string; _postman_id?: string; schema?: string; description?: string };
  item?: PostmanItem[];
  variable?: any[];
}

interface PostmanItem {
  name?: string;
  description?: string | { content?: string; type?: string };
  item?: PostmanItem[];
  request?: {
    method?: string;
    url?: string | { raw?: string; host?: string[]; path?: string[] };
    header?: { key: string; value: string; description?: string }[];
    body?: { mode?: string; raw?: string; graphql?: string; options?: any };
    description?: string;
  };
}

function flattenCollection(raw: unknown, sourceName: string): RemoteDocument[] {
  const collection = raw as PostmanCollection;
  if (!collection || typeof collection !== 'object' || !collection.info) {
    throw new Error('Invalid Postman collection: missing `info` block');
  }
  const collectionName = collection.info.name || 'Postman Collection';
  const docs: RemoteDocument[] = [];

  const walk = (items: PostmanItem[] | undefined, group: string[]): void => {
    if (!items) return;
    for (const item of items) {
      if (Array.isArray(item.item)) {
        walk(item.item, [...group, item.name || ''].filter(Boolean));
      } else if (item.request) {
        docs.push(endpointToDocument(item, [...group], collectionName, sourceName));
      }
    }
  };
  walk(collection.item, []);

  // Emit a top-level collection summary so the search index has a parent record.
  docs.unshift({
    id: `${sourceName}:collection:${collectionName}`,
    path: `${sourceName}://collection/${encodeURIComponent(collectionName)}`,
    title: collectionName,
    content: `${collectionName}\n\nEndpoints: ${docs.length}\nSchema: ${collection.info.schema ?? 'unknown'}\n\n${collection.info.description ?? ''}`.trim(),
    extension: '.md',
    tags: [sourceName, 'collection'],
    lastModified: undefined,
    metadata: { source: sourceName, kind: 'collection', endpointCount: docs.length },
  });

  return docs;
}

function endpointToDocument(item: PostmanItem, group: string[], collectionName: string, sourceName: string): RemoteDocument {
  const request = item.request!;
  const method = (request.method || 'GET').toUpperCase();
  const url = describeUrl(request.url);
  const description = describeBody(item.description, request.description);
  const headers = (request.header || []).map((h) => `- \`${h.key}: ${h.value}\``).join('\n');
  const body = describeBody(undefined, request.body?.raw);

  const content = [
    `# ${method} ${url}`,
    description ? `> ${description}` : '',
    `Collection: ${collectionName}`,
    group.length > 0 ? `Group: ${group.join(' / ')}` : '',
    '',
    `## Request`,
    headers ? `### Headers\n${headers}` : '### Headers\n_(none)_',
    body ? `### Body\n\`\`\`\n${body.slice(0, 4000)}\n\`\`\`` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    id: `${sourceName}:${collectionName}:${method}:${encodeURIComponent(url)}`,
    path: `${sourceName}://${encodeURIComponent(collectionName)}/${method.toLowerCase()}/${encodeURIComponent(url)}`,
    title: `${method} ${url}`,
    content,
    extension: '.md',
    tags: ['api', sourceName, method.toLowerCase(), ...group],
    lastModified: undefined,
    metadata: {
      source: sourceName,
      kind: 'endpoint',
      method,
      url,
      collection: collectionName,
      group,
    },
  };
}

function describeUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as { raw?: unknown; host?: unknown; path?: unknown };
    if (typeof obj.raw === 'string') return obj.raw;
    if (obj.host && obj.path) {
      const host = Array.isArray(obj.host) ? obj.host.join('.') : String(obj.host || '');
      const path = Array.isArray(obj.path) ? '/' + obj.path.join('/') : '';
      return `${host}${path}`;
    }
  }
  return '(no url)';
}

function describeBody(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      const obj = candidate as { content?: string };
      if (typeof obj.content === 'string' && obj.content.trim()) return obj.content;
    }
  }
  return '';
}

export const PostmanProvider: SourceProvider = defineSource(
  'postman',
  'Postman v2.1 collection — read-only, local file or URL',
  {
    url: { type: 'string', description: 'URL to a Postman v2.1 collection (JSON or YAML)' },
    path: { type: 'string', description: 'Local filesystem path to the collection file' },
    auth: { type: 'string', description: 'Auth config: `none` | `basic` | `bearer` | `apiKey` | `custom`' },
  },
  (options) => new PostmanSource(options),
);

/* -------------------------------------------------------------------------- */
/*                            OpenAPI / Swagger / Scalar                       */
/* -------------------------------------------------------------------------- */

/**
 * Adapter that loads any OpenAPI 3.x or Swagger 2.0 spec (JSON or YAML),
 * supports a list of URLs in `settings.json`, and emits one document per
 * operation. `x-tagGroups` and `tags` collapse to slash-joined tags so the
 * CLI's `docgraph search foo openapi` finds both the tag bucket and the
 * endpoint body.
 *
 * Authentication: any {@link ApiAuthMode} (no / basic / bearer / apiKey /
 * custom headers).
 */
export class OpenApiSource implements RemoteSource {
  readonly name = 'openapi';
  readonly description = 'OpenAPI 3.x / Swagger 2.0 / Scalar — local path or URL';

  private readonly target: string;
  private readonly auth?: ApiAuthConfig;

  constructor(options: Record<string, unknown>) {
    const target = String(options.url || options.path || '');
    if (!target) throw new Error('openapi source requires `url` or `path`');
    this.target = target;
    this.auth = (options.auth as ApiAuthConfig | undefined) ?? undefined;
  }

  async list(): Promise<RemoteDocument[]> {
    const spec = await loadSpec(this.target, this.auth);
    const info = (spec.info ?? {}) as { title?: string; version?: string; description?: string };
    const paths = (spec.paths ?? {}) as Record<string, Record<string, any>>;
    const servers = (spec.servers ?? []) as { url: string; description?: string }[];
    const baseUrl = servers[0]?.url || (spec as any).host ? `${(spec as any).schemes?.[0] || 'https'}://${(spec as any).host || ''}${(spec as any).basePath || ''}` : '';
    const documents: RemoteDocument[] = [];

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!isHttpMethod(method)) continue;
        documents.push(operationToDocument(operation, path, method, info, baseUrl, this.name));
      }
    }

    documents.unshift({
      id: `${this.name}:spec:${info.title || 'api'}`,
      path: `${this.name}://spec/${encodeURIComponent(info.title || 'api')}`,
      title: `${info.title || 'API'} (${info.version || '0.0.0'})`,
      content: `# ${info.title || 'API'}\n\nVersion: \`${info.version || '0.0.0'}\`\nBase URL: \`${baseUrl || '(none)'}\`\nEndpoints: ${documents.length}\n\n${info.description ?? ''}`.trim(),
      extension: '.md',
      tags: [this.name, 'spec'],
      lastModified: undefined,
      metadata: { source: this.name, kind: 'spec', version: info.version, baseUrl, endpointCount: documents.length },
    });
    return documents;
  }

  async get(id: string): Promise<RemoteDocument | null> {
    const all = await this.list();
    return all.find((d) => d.id === id) ?? null;
  }
}

function isHttpMethod(value: string): boolean {
  return /^(get|post|put|patch|delete|head|options|trace)$/i.test(value);
}

function operationToDocument(
  operation: any,
  path: string,
  method: string,
  info: { title?: string; version?: string },
  baseUrl: string,
  sourceName: string,
): RemoteDocument {
  const tags: string[] = Array.isArray(operation.tags)
    ? operation.tags.filter((t: unknown): t is string => typeof t === 'string')
    : [];
  const id = `${sourceName}:${info.title || 'api'}:${method.toUpperCase()}:${path}`;
  const summary = operation.summary || operation.operationId || '';
  const description = operation.description || '';
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const requestBody = operation.requestBody;
  const responses = operation.responses ?? {};
  const fullUrl = `${baseUrl}${path}`;
  const content = [
    `# ${method.toUpperCase()} ${path}`,
    summary ? `## Summary\n${summary}` : '',
    description ? `## Description\n${description}` : '',
    `## Endpoint\n\`${method.toUpperCase()} ${fullUrl}\``,
    parameters.length > 0
      ? `## Parameters\n${parameters
          .map(
            (p: any) =>
              `- \`${p.name}\` (${p.in || 'query'}, ${p.required ? 'required' : 'optional'}, ${p.schema?.type ?? 'string'}): ${p.description ?? ''}`,
          )
          .join('\n')}`
      : '',
    requestBody ? `## Request Body\n\`${JSON.stringify(requestBody.content ?? requestBody, null, 2).slice(0, 3000)}\`` : '',
    `## Responses\n${Object.entries(responses)
      .slice(0, 8)
      .map(([status, response]: [string, any]) => `- **${status}**: ${response.description ?? ''}`)
      .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    id,
    path: `${sourceName}://${encodeURIComponent(info.title || 'api')}/${method.toLowerCase()}${path}`,
    title: `${method.toUpperCase()} ${path}` + (summary ? ` — ${summary}` : ''),
    content,
    extension: '.md',
    tags: ['api', sourceName, method.toLowerCase(), ...tags],
    lastModified: undefined,
    metadata: {
      source: sourceName,
      kind: 'endpoint',
      method: method.toUpperCase(),
      path,
      url: fullUrl,
      operationId: operation.operationId,
      tags,
    },
  };
}

async function loadSpec(target: string, auth?: ApiAuthConfig): Promise<any> {
  if (/^https?:\/\//i.test(target)) {
    const headers = buildAuthHeaders(auth, {
      Accept: 'application/json, application/yaml, text/yaml, */*',
      'User-Agent': 'docgraph/1.0 (+https://github.com/carrilloapps/docgraph)',
    });
    const response = await fetch(target, { headers });
    if (!response.ok) throw new Error(`[openapi] HTTP ${response.status}: ${await response.text()}`);
    const text = await response.text();
    return parseSpecText(text, target);
  }
  if (!existsSync(target)) throw new Error(`[openapi] file not found: ${target}`);
  const text = readFileSync(target, 'utf-8');
  return parseSpecText(text, target);
}

function parseSpecText(text: string, source: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch (err) {
      throw new Error(`[openapi] failed to parse JSON for ${source}: ${(err as Error).message}`);
    }
  }
  try {
    return parseYaml(trimmed);
  } catch (err) {
    throw new Error(`[openapi] failed to parse YAML for ${source}: ${(err as Error).message}`);
  }
}

export const OpenApiProvider: SourceProvider = defineSource(
  'openapi',
  'OpenAPI 3.x / Swagger 2.0 / Scalar — local path or URL (JSON or YAML)',
  {
    url: { type: 'string', description: 'URL to an OpenAPI / Swagger spec' },
    path: { type: 'string', description: 'Local filesystem path to the spec file' },
    auth: { type: 'string', description: 'Auth config: `none` | `basic` | `bearer` | `apiKey` | `custom`' },
  },
  (options) => new OpenApiSource(options),
);

/* -------------------------------------------------------------------------- */
/*                              Postman-shaped writer                           */
/* -------------------------------------------------------------------------- */

/**
 * Helper that walks a list of {@link RemoteDocument}s emitted by a Postman
 * source and writes a fresh collection file at {@link outPath}. Useful as a
 * round-trip: pull a real spec, edit it through docgraph's search results,
 * export it again.
 */
export function writePostmanCollection(documents: RemoteDocument[], outPath: string, collectionName: string): void {
  const items: any[] = [];
  for (const doc of documents) {
    if (doc.metadata?.kind !== 'endpoint') continue;
    const method = doc.metadata.method;
    const url = doc.metadata.url as string;
    items.push({
      name: doc.title || `${method} ${url}`,
      request: {
        method,
        url,
        description: doc.metadata.summary,
      },
    });
  }
  const collection = {
    info: { name: collectionName, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: items,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(collection, null, 2), 'utf-8');
}
