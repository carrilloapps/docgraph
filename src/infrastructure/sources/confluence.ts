import { HttpRemoteSource, defineSource } from './http-remote-source.js';
import { RemoteDocument } from './types.js';

/**
 * Confluence Cloud REST v2 adapter. Pulls pages from a single space or via CQL.
 *
 * Authentication: Basic auth (email + API token) — same as Jira.
 * Configuration: `{ host, email, apiToken, spaceId?, cql? }`.
 */
export class ConfluenceSource extends HttpRemoteSource {
  readonly name = 'confluence';
  readonly description = 'Atlassian Confluence pages via REST API v2';

  protected get endpoint(): string {
    return 'https://example.atlassian.net/wiki/api/v2/pages';
  }

  private readonly host: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly spaceId?: string;
  private readonly cql?: string;

  constructor(config: Record<string, unknown>) {
    super();
    this.host = String(config.host || '').replace(/\/$/, '');
    this.email = String(config.email || '');
    this.apiToken = String(config.apiToken || '');
    this.spaceId = config.spaceId ? String(config.spaceId) : undefined;
    this.cql = config.cql ? String(config.cql) : undefined;
  }

  protected authHeaders(): Record<string, string> {
    const credentials = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
    return { Authorization: `Basic ${credentials}` };
  }

  protected pageUrl(page: number): string {
    // `body-format=storage` (v2) / `expand=body.storage` (v1 CQL search) are
    // required to get real page content back — without them Confluence Cloud
    // only returns metadata (title, id, links), which is what produced the
    // placeholder body previously.
    const params = new URLSearchParams({ limit: '25', 'body-format': 'storage' });
    if (this.spaceId) params.set('space-id', this.spaceId);
    if (this.cql) {
      const cqlUrl = `${this.host}/wiki/rest/api/content/search?cql=${encodeURIComponent(this.cql)}&limit=25&start=${(page - 1) * 25}&expand=body.storage,version,space`;
      return cqlUrl;
    }
    params.set('start', String((page - 1) * 25));
    return `${this.host}/wiki/api/v2/pages?${params.toString()}`;
  }

  protected extractPage(payload: unknown): RemoteDocument[] {
    const data = payload as { results?: any[] };
    const results = data?.results ?? [];
    return results.map((page: any) => this.toDocument(page)).filter(Boolean) as RemoteDocument[];
  }

  protected hasMore(payload: unknown, page: number): boolean {
    const _links = (payload as any)?._links;
    if (_links?.next) return true;
    const size = (payload as any)?.size ?? 0;
    return size > page * 25;
  }

  protected nextPage(_payload: unknown, current: number): number {
    return current + 1;
  }

  private toDocument(page: any): RemoteDocument | null {
    const id = page?.id;
    if (!id) return null;
    const title = page?.title || id;
    const spaceId = page?.spaceId || page?.space?.id || page?.space?.key;
    const webui = (page as any)?._links?.webui;
    const url = webui ? `${this.host}/wiki${webui}` : `${this.host}/wiki/spaces/${spaceId}/pages/${id}`;
    const body = extractTextFromStorage(page?.body?.storage?.value);

    return {
      id: `confluence:${id}`,
      path: `confluence://page/${id}`,
      title,
      content: `# ${title}\n\n${body || '_Page body unavailable — check that `body-format`/`expand` includes body.storage._'}`,
      extension: '.md',
      tags: spaceId ? [spaceId] : [],
      lastModified: page?.version?.createdAt,
      metadata: {
        source: 'confluence',
        pageId: id,
        spaceId,
        url,
      },
    };
  }
}

function extractTextFromStorage(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const ConfluenceProvider = defineSource(
  'confluence',
  'Atlassian Confluence pages via Cloud REST v2 (Basic auth)',
  {
    host: { type: 'string', description: 'Atlassian host (e.g. https://yourcompany.atlassian.net)', required: true },
    email: { type: 'string', description: 'Atlassian account email', required: true },
    apiToken: { type: 'string', description: 'Atlassian API token', required: true, secret: true },
    spaceId: { type: 'string', description: 'Confluence space id to filter by' },
    cql: { type: 'string', description: 'Confluence Query Language filter' },
  },
  (config) => new ConfluenceSource(config),
);
