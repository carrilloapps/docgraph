import { HttpRemoteSource, defineSource, fetchWithRetry } from './http-remote-source.js';
import { RemoteDocument } from './types.js';

/**
 * Linear adapter. Pulls issues via Linear's GraphQL endpoint (https://api.linear.app/graphql).
 * Built on top of the HTTP base class by issuing a POST with a GraphQL query;
 * the response is a single JSON envelope (no pagination cursor needed for small workspaces).
 *
 * Authentication: Linear personal API key (`Authorization: <key>` header).
 * Configuration: `{ apiKey, teamId?, state? }`.
 */
export class LinearSource extends HttpRemoteSource {
  readonly name = 'linear';
  readonly description = 'Linear issues via GraphQL API';

  protected get endpoint(): string {
    return 'https://api.linear.app/graphql';
  }

  private readonly apiKey: string;
  private readonly teamId?: string;
  private readonly state?: string;

  constructor(config: Record<string, unknown>) {
    super();
    this.apiKey = String(config.apiKey || '');
    this.teamId = config.teamId ? String(config.teamId) : undefined;
    this.state = config.state ? String(config.state) : undefined;
  }

  protected authHeaders(): Record<string, string> {
    return { Authorization: this.apiKey };
  }

  protected pageUrl(_page: number): string {
    return this.endpoint;
  }

  protected async fetchJson(_url: string): Promise<unknown> {
    const filters: Record<string, unknown> = {};
    if (this.teamId) filters.team = { id: { eq: this.teamId } };
    if (this.state) filters.state = { name: { eq: this.state } };

    const query = `query Issues($filter: IssueFilter) { issues(filter: $filter, first: 50, orderBy: updatedAt) { nodes { id identifier title description updatedAt priority priorityLabel state { name } team { key name } labels { nodes { name } } } pageInfo { hasNextPage endCursor } } }`;
    const response = await fetchWithRetry(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'docgraph/1.0',
        ...this.authHeaders(),
      },
      body: JSON.stringify({ query, variables: { filter: filters } }),
    });
    if (!response.ok) throw new Error(`[linear] HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as { data?: { issues?: any } };
  }

  protected extractPage(payload: unknown): RemoteDocument[] {
    const data = (payload as { data?: { issues?: any } }).data?.issues;
    const nodes = data?.nodes ?? [];
    return nodes.map((n: any) => this.toDocument(n)).filter(Boolean) as RemoteDocument[];
  }

  protected hasMore(payload: unknown): boolean {
    return Boolean((payload as { data?: { issues?: any } }).data?.issues?.pageInfo?.hasNextPage);
  }

  protected nextPage(_payload: unknown, current: number): number {
    return current + 1;
  }

  private toDocument(node: any): RemoteDocument | null {
    const id = node?.id;
    if (!id) return null;
    const identifier = node.identifier;
    const title = node.title;
    const description = node.description || '';
    const team = node.team?.key || '';
    const state = node.state?.name;
    const priority = node.priorityLabel;
    const labels = node.labels?.nodes?.map((l: any) => l?.name).filter(Boolean) ?? [];

    const frontmatter = [
      `id: ${identifier}`,
      team ? `team: ${team}` : '',
      state ? `state: ${state}` : '',
      priority ? `priority: ${priority}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      id: `linear:${identifier || id}`,
      path: `linear://issue/${identifier}`,
      title: `${identifier}: ${title}`,
      content: `${title}\n\n---\n${frontmatter}\n---\n\n${description}`,
      extension: '.md',
      tags: [state, ...labels].filter(Boolean) as string[],
      lastModified: node.updatedAt,
      metadata: {
        source: 'linear',
        identifier,
        url: identifier ? `https://linear.app/${team.toLowerCase()}/issue/${identifier}` : undefined,
        team,
        state,
        priority,
        labels,
      },
    };
  }
}

export const LinearProvider = defineSource(
  'linear',
  'Linear issues via GraphQL API (Linear personal API key)',
  {
    apiKey: { type: 'string', description: 'Linear personal API key', required: true, secret: true },
    teamId: { type: 'string', description: 'Filter by Linear team id' },
    state: { type: 'string', description: 'Filter by state name (e.g. "In Progress", "Done")' },
  },
  (config) => new LinearSource(config),
);
