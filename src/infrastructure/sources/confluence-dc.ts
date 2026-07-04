import { HttpRemoteSource, defineSource } from './http-remote-source.js';
import { RemoteDocument } from './types.js';

/**
 * Confluence Data Center REST API (v1) adapter — same auth model as Cloud,
 * different host shape and no "cloudId" prefix required. Useful for
 * self-hosted Confluence deployments.
 */
export class ConfluenceDataCenterSource extends HttpRemoteSource {
  readonly name = 'confluence-dc';
  readonly description = 'Self-hosted Confluence Data Center via REST v1';

  protected get endpoint(): string {
    return 'https://confluence.example.com/rest/api/content';
  }

  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private readonly spaceKey?: string;

  constructor(config: Record<string, unknown>) {
    super();
    this.host = String(config.host || '').replace(/\/$/, '');
    this.username = String(config.username || '');
    this.password = String(config.password || '');
    this.spaceKey = config.spaceKey ? String(config.spaceKey) : undefined;
  }

  protected authHeaders(): Record<string, string> {
    const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${credentials}` };
  }

  protected pageUrl(page: number): string {
    const start = (page - 1) * 25;
    const params = new URLSearchParams({ limit: '25', start: String(start), expand: 'body.view,version' });
    if (this.spaceKey) params.set('spaceKey', this.spaceKey);
    return `${this.host}/rest/api/content?${params.toString()}`;
  }

  protected extractPage(payload: unknown): RemoteDocument[] {
    const data = payload as { results?: any[] };
    return (data?.results ?? []).map((page: any) => this.toDocument(page)).filter(Boolean) as RemoteDocument[];
  }

  protected hasMore(payload: unknown, page: number): boolean {
    const data = payload as { size?: number; start?: number; limit?: number };
    if (!data?.size) return false;
    return (data.start || 0) + (data.limit || 25) < data.size && page < 100;
  }

  protected nextPage(_payload: unknown, current: number): number {
    return current + 1;
  }

  private toDocument(page: any): RemoteDocument | null {
    const id = page?.id;
    if (!id) return null;
    const title = page?.title || id;
    const spaceKey = page?.space?.key;
    const webui = page?._links?.webui;
    const url = webui ? `${this.host}${webui}` : `${this.host}/spaces/${spaceKey}/pages/${id}`;
    const body = extractTextFromStorage(page?.body?.view?.storage?.value);

    return {
      id: `confluence-dc:${id}`,
      path: `confluence-dc://page/${id}`,
      title,
      content: `# ${title}\n\n${body || '_Page body unavailable; fetch via REST and expand body.view._'}`,
      extension: '.md',
      tags: spaceKey ? [spaceKey] : [],
      lastModified: page?.version?.when,
      metadata: {
        source: 'confluence-dc',
        pageId: id,
        spaceKey,
        url,
      },
    };
  }
}

function extractTextFromStorage(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const ConfluenceDcProvider = defineSource(
  'confluence-dc',
  'Self-hosted Confluence Data Center (REST v1, Basic auth)',
  {
    host: { type: 'string', description: 'Confluence base URL (e.g. https://confluence.company.com)', required: true },
    username: { type: 'string', description: 'Username', required: true },
    password: { type: 'string', description: 'Password (or PAT)', required: true, secret: true },
    spaceKey: { type: 'string', description: 'Confluence space key to filter by' },
  },
  (config) => new ConfluenceDataCenterSource(config),
);
