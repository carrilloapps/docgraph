import { HttpRemoteSource, defineSource, fetchWithRetry } from './http-remote-source.js';
import { RemoteDocument } from './types.js';

/**
 * Notion adapter. Pulls pages from a Notion database (or workspace search)
 * via the public REST API and renders them as Markdown so the indexing
 * pipeline can chunk and embed them like any other doc.
 *
 * Authentication: Notion integration token (Bearer header).
 * Configuration: `{ token: string, databaseId?: string, query?: string }`.
 *
 * Pagination: Notion's `/search` and `/databases/:id/query` endpoints are
 * cursor-based (`start_cursor` in the request, `next_cursor`/`has_more` in
 * the response) — they have no notion of a page *number*. That doesn't fit
 * {@link HttpRemoteSource}'s generic page-number pagination loop (which
 * would re-request the exact same first page forever), so `list()` below
 * implements its own cursor walk instead of relying on the base class's
 * `fetchAll()`. `extractPage`/`hasMore`/`nextPage` are still implemented to
 * satisfy the abstract base contract but are not on this class's hot path.
 */
export class NotionSource extends HttpRemoteSource {
  readonly name = 'notion';
  readonly description = 'Notion workspace pages and databases';

  protected get endpoint(): string {
    return 'https://api.notion.com/v1';
  }

  private readonly token: string;
  private readonly databaseId?: string;
  private readonly query?: string;
  private readonly version = '2022-06-28';
  private static readonly PAGE_SIZE = 100;

  constructor(config: Record<string, unknown>) {
    super();
    this.token = String(config.token || '');
    this.databaseId = config.databaseId ? String(config.databaseId) : undefined;
    this.query = config.query ? String(config.query) : undefined;
  }

  protected authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Notion-Version': this.version,
    };
  }

  protected pageUrl(_page: number): string {
    return this.databaseId ? `${this.endpoint}/databases/${this.databaseId}/query` : `${this.endpoint}/search`;
  }

  private requestBody(cursor: string | undefined): Record<string, unknown> {
    const body: Record<string, unknown> = this.databaseId
      ? { page_size: NotionSource.PAGE_SIZE, sorts: [{ direction: 'descending', timestamp: 'last_edited_time' }] }
      : {
          page_size: NotionSource.PAGE_SIZE,
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          ...(this.query ? { query: this.query } : {}),
        };
    if (cursor) body.start_cursor = cursor;
    return body;
  }

  /** Issue one cursor page of the search/database-query POST, with retry-on-429/5xx. */
  private async fetchCursorPage(cursor: string | undefined): Promise<unknown> {
    const response = await fetchWithRetry(this.pageUrl(0), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'docgraph/1.0',
        ...this.authHeaders(),
      },
      body: JSON.stringify(this.requestBody(cursor)),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[notion] HTTP ${response.status}: ${text}`);
    }
    return await response.json();
  }

  /**
   * Cursor-based walk: thread `next_cursor` from each response into the next
   * request's `start_cursor`, stopping once `has_more` is false (or the
   * cursor is missing) so pages are never re-fetched and results never
   * duplicate. Bounded by `this.maxPages` (see `configureMaxPages`).
   */
  async list(): Promise<RemoteDocument[]> {
    const documents: RemoteDocument[] = [];
    let cursor: string | undefined;
    let pages = 0;

    while (pages < this.maxPages) {
      pages++;
      let payload: unknown;
      try {
        payload = await this.fetchCursorPage(cursor);
      } catch (err) {
        // Retries (see fetchWithRetry) already exhausted for this page. Don't
        // discard pages already collected — return the partial result. Only
        // rethrow if we have nothing at all (source is effectively down).
        if (documents.length > 0) break;
        throw err;
      }
      documents.push(...this.extractPage(payload));

      const data = payload as { has_more?: boolean; next_cursor?: string | null };
      if (!data?.has_more || !data?.next_cursor) break;
      cursor = data.next_cursor;
    }

    return documents;
  }

  async listSince(since: Date): Promise<RemoteDocument[]> {
    const all = await this.list();
    return all.filter((doc) => !doc.lastModified || new Date(doc.lastModified) >= since);
  }

  async get(id: string): Promise<RemoteDocument | null> {
    const all = await this.list();
    return all.find((doc) => doc.id === id) ?? null;
  }

  protected extractPage(payload: unknown): RemoteDocument[] {
    const data = payload as { results?: any[] };
    if (!data?.results) return [];
    return data.results.map((page) => this.toDocument(page)).filter(Boolean) as RemoteDocument[];
  }

  protected hasMore(payload: unknown): boolean {
    const data = payload as { has_more?: boolean; next_cursor?: string | null };
    return Boolean(data?.has_more && data?.next_cursor);
  }

  protected nextPage(_payload: unknown, current: number): number | null {
    // Not used: cursor pagination is handled entirely by `list()`'s own loop
    // above. Implemented only to satisfy HttpRemoteSource's abstract contract.
    return current + 1;
  }

  private toDocument(page: any): RemoteDocument | null {
    const id = page?.id;
    if (!id) return null;
    const title = extractTitle(page);
    const lastModified = page?.last_edited_time;
    const properties = extractProperties(page);
    const tags = (properties.tags as string[]) || [];
    const markdown = renderBlocks(page?.children ?? []);
    const content = [properties.heading || '', markdown].filter(Boolean).join('\n\n');

    return {
      id: `notion:${id}`,
      path: `notion://page/${id}`,
      title,
      content,
      extension: '.md',
      tags,
      lastModified,
      metadata: {
        source: 'notion',
        url: page?.url,
        createdTime: page?.created_time,
        properties,
      },
    };
  }
}

function extractTitle(page: any): string | undefined {
  const props = page?.properties || {};
  for (const value of Object.values(props) as any[]) {
    if (value?.type === 'title') {
      const plain = value?.title?.[0]?.plain_text;
      if (plain) return plain;
    }
  }
  return undefined;
}

function extractProperties(page: any): Record<string, unknown> {
  const props = page?.properties || {};
  const tags: string[] = [];
  let heading = '';
  for (const [name, value] of Object.entries(props) as [string, any][]) {
    if (value?.type === 'multi_select') {
      value.multi_select?.forEach((opt: any) => {
        if (opt?.name) tags.push(opt.name);
      });
    } else if (value?.type === 'select') {
      if (value.select?.name) tags.push(value.select.name);
    } else if (value?.type === 'rich_text') {
      const text = value.rich_text?.map((t: any) => t?.plain_text || '').join('') || '';
      if (name.toLowerCase() === 'tags') {
        if (text) tags.push(text);
      } else {
        heading = text;
      }
    }
  }
  return { tags, heading };
}

function renderBlocks(blocks: any[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const type = block?.type;
    if (!type) continue;
    const text = renderRichText(block[type]?.rich_text) || '';
    if (type === 'heading_1') lines.push(`# ${text}`);
    else if (type === 'heading_2') lines.push(`## ${text}`);
    else if (type === 'heading_3') lines.push(`### ${text}`);
    else if (type === 'paragraph' && text) lines.push(text);
    else if (type === 'bulleted_list_item') lines.push(`- ${text}`);
    else if (type === 'numbered_list_item') lines.push(`1. ${text}`);
    else if (type === 'code') lines.push('```' + (block[type]?.language || '') + '\n' + text + '\n```');
    else if (type === 'quote') lines.push(`> ${text}`);
    else if (type === 'to_do') lines.push(`- [${block[type]?.checked ? 'x' : ' '}] ${text}`);
    else if (text) lines.push(text);
  }
  return lines.join('\n\n');
}

function renderRichText(rich: any[] | undefined): string {
  if (!Array.isArray(rich)) return '';
  return rich.map((t) => t?.plain_text || '').join('');
}

export const NotionProvider = defineSource(
  'notion',
  'Notion database or workspace via REST API (Notion integration token)',
  {
    token: { type: 'string', description: 'Notion integration token (Bearer)', required: true, secret: true },
    databaseId: { type: 'string', description: 'Optional Notion database id to query (omit to use workspace search)' },
    query: { type: 'string', description: 'Optional workspace search query' },
  },
  (config) => new NotionSource(config),
);
