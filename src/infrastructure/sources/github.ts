import { HttpRemoteSource, defineSource } from './http-remote-source.js';
import { RemoteDocument } from './types.js';

/**
 * GitHub issues + pull requests adapter via the REST v3 API.
 * Uses a fine-grained GitHub PAT (or classic token) with `repo` read scope.
 *
 * Authentication: Bearer PAT.
 * Configuration: `{ token, owner, repo, kind?: 'issues' | 'pulls' | 'both', state?: 'open' | 'closed' | 'all' }`.
 */
export class GitHubSource extends HttpRemoteSource {
  readonly name = 'github';
  readonly description = 'GitHub issues + pull requests via REST v3 (fine-grained PAT)';

  protected get endpoint(): string {
    return 'https://api.github.com';
  }

  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly kind: 'issues' | 'pulls' | 'both';
  private readonly state: 'open' | 'closed' | 'all';

  constructor(config: Record<string, unknown>) {
    super();
    this.token = String(config.token || '');
    this.owner = String(config.owner || '');
    this.repo = String(config.repo || '');
    this.kind = (config.kind as 'issues' | 'pulls' | 'both') ?? 'both';
    this.state = (config.state as 'open' | 'closed' | 'all') ?? 'all';
  }

  protected authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  protected pageUrl(page: number): string {
    const base = `https://api.github.com/repos/${this.owner}/${this.repo}`;
    if (this.kind === 'pulls') {
      return `${base}/pulls?state=${this.state}&per_page=100&page=${page}`;
    }
    if (this.kind === 'issues') {
      return `${base}/issues?state=${this.state}&per_page=100&page=${page}`;
    }
    return `${base}/issues?state=${this.state}&per_page=100&page=${page}`;
  }

  protected extractPage(payload: unknown): RemoteDocument[] {
    const list = Array.isArray(payload) ? payload : [];
    return list.map((item: any) => this.toDocument(item)).filter(Boolean) as RemoteDocument[];
  }

  protected hasMore(payload: unknown, page: number): boolean {
    return Array.isArray(payload) && payload.length === 100 && page < 50;
  }

  protected nextPage(_payload: unknown, current: number): number {
    return current + 1;
  }

  private toDocument(item: any): RemoteDocument | null {
    const id = item?.id;
    if (!id) return null;
    const isPull = Boolean(item?.pull_request);
    const number = item?.number;
    const title = item?.title || `#${number}`;
    const body = item?.body || '';
    const state = item?.state;
    const labels = Array.isArray(item?.labels) ? item.labels.map((l: any) => l?.name).filter(Boolean) : [];
    const user = item?.user?.login;
    const htmlUrl = item?.html_url;
    const kind = isPull ? 'pull-request' : 'issue';

    const frontmatter = [
      `repo: ${this.owner}/${this.repo}`,
      `number: ${number}`,
      `kind: ${kind}`,
      state ? `state: ${state}` : '',
      user ? `author: ${user}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      id: `github:${this.owner}/${this.repo}#${kind}:${number}`,
      path: `github://${this.owner}/${this.repo}/${kind}/${number}`,
      title: `${kind === 'pull-request' ? 'PR' : 'Issue'} #${number}: ${title}`,
      content: `${title}\n\n---\n${frontmatter}\n---\n\n${body}`,
      extension: '.md',
      tags: [kind, state, ...labels].filter(Boolean) as string[],
      lastModified: item?.updated_at,
      metadata: {
        source: 'github',
        kind,
        number,
        url: htmlUrl,
        author: user,
        labels,
      },
    };
  }
}

export const GitHubProvider = defineSource(
  'github',
  'GitHub issues and pull requests via REST v3 (fine-grained PAT)',
  {
    token: { type: 'string', description: 'GitHub fine-grained PAT (read-only is enough)', required: true, secret: true },
    owner: { type: 'string', description: 'Repository owner (org or user)', required: true },
    repo: { type: 'string', description: 'Repository name', required: true },
    kind: { type: 'string', description: '`issues`, `pulls`, or `both` (default both)' },
    state: { type: 'string', description: '`open`, `closed`, or `all` (default all)' },
  },
  (config) => new GitHubSource(config),
);
