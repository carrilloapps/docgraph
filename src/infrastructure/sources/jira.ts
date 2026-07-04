import { HttpRemoteSource, defineSource } from './http-remote-source.js';
import { RemoteDocument } from './types.js';

/**
 * Atlassian Jira adapter. Pulls issues via the v3 REST API using either
 * Basic auth (email + API token) or OAuth bearer tokens. Converts issues into
 * ADF-adjacent Markdown so the indexing pipeline can chunk and embed them.
 *
 * Authentication: Basic auth (email + API token) — set both `email` and `apiToken`,
 * or use `bearerToken` for OAuth-style flows.
 * Configuration: `{ host, email?, apiToken?, bearerToken?, jql?, maxResults? }`.
 */
export class JiraSource extends HttpRemoteSource {
  readonly name = 'jira';
  readonly description = 'Atlassian Jira issues via REST API v3';

  protected get endpoint(): string {
    return 'https://example.atlassian.net';
  }

  private readonly host: string;
  private readonly email?: string;
  private readonly apiToken?: string;
  private readonly bearerToken?: string;
  private readonly jql: string;
  private readonly maxResults: number;

  constructor(config: Record<string, unknown>) {
    super();
    this.host = String(config.host || '').replace(/\/$/, '');
    this.email = config.email ? String(config.email) : undefined;
    this.apiToken = config.apiToken ? String(config.apiToken) : undefined;
    this.bearerToken = config.bearerToken ? String(config.bearerToken) : undefined;
    this.jql = String(config.jql || 'ORDER BY updated DESC');
    this.maxResults = Math.min(Number(config.maxResults) || 100, 100);
  }

  protected authHeaders(): Record<string, string> {
    if (this.bearerToken) {
      return { Authorization: `Bearer ${this.bearerToken}` };
    }
    if (this.email && this.apiToken) {
      const credentials = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }
    return {};
  }

  protected pageUrl(page: number): string {
    const startAt = (page - 1) * this.maxResults;
    const params = new URLSearchParams({
      jql: this.jql,
      startAt: String(startAt),
      maxResults: String(this.maxResults),
      fields: 'summary,description,status,priority,assignee,reporter,labels,updated,created,issuetype,project,parent',
    });
    return `${this.host}/rest/api/3/search?${params.toString()}`;
  }

  protected extractPage(payload: unknown): RemoteDocument[] {
    const data = payload as { issues?: any[] };
    if (!data?.issues) return [];
    return data.issues.map((issue) => this.toDocument(issue)).filter(Boolean) as RemoteDocument[];
  }

  protected hasMore(payload: unknown, page: number): boolean {
    const data = payload as { total?: number; startAt?: number; maxResults?: number };
    if (!data?.total) return false;
    const loaded = (data.startAt || 0) + (data.maxResults || this.maxResults);
    return loaded < data.total && page * this.maxResults < data.total;
  }

  protected nextPage(_payload: unknown, current: number): number {
    return current + 1;
  }

  private toDocument(issue: any): RemoteDocument | null {
    const key = issue?.key;
    if (!key) return null;
    const fields = issue?.fields || {};
    const summary = fields.summary || key;
    const description = renderAdf(fields.description);
    const status = fields.status?.name;
    const priority = fields.priority?.name;
    const assignee = fields.assignee?.displayName;
    const project = fields.project?.name;
    const issueType = fields.issuetype?.name;
    const parent = fields.parent?.key;
    const labels: string[] = Array.isArray(fields.labels) ? fields.labels : [];

    const frontmatter = [
      `key: ${key}`,
      status ? `status: ${status}` : '',
      priority ? `priority: ${priority}` : '',
      issueType ? `type: ${issueType}` : '',
      project ? `project: ${project}` : '',
      assignee ? `assignee: ${assignee}` : '',
      parent ? `parent: ${parent}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const tags = [issueType, status, ...labels].filter(Boolean) as string[];

    const content = `${summary}\n\n${frontmatter ? '---\n' + frontmatter + '\n---\n' : ''}${description ? '\n' + description : ''}`;

    return {
      id: `jira:${key}`,
      path: `jira://issue/${key}`,
      title: `${key}: ${summary}`,
      content,
      extension: '.md',
      tags,
      lastModified: fields.updated,
      metadata: {
        source: 'jira',
        key,
        url: `${this.host.replace(/\/$/, '')}/browse/${key}`,
        status,
        priority,
        assignee,
        project,
        labels,
      },
    };
  }
}

function renderAdf(adf: unknown): string {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  const node = adf as { type?: string; content?: any[]; text?: string };
  if (node?.type === 'text' && typeof node.text === 'string') return node.text;
  if (Array.isArray(node?.content)) {
    return node.content.map(renderAdf).filter(Boolean).join('\n\n');
  }
  return '';
}

export const JiraProvider = defineSource(
  'jira',
  'Atlassian Jira issues via REST API v3 (Basic auth or OAuth bearer)',
  {
    host: { type: 'string', description: 'Atlassian host (e.g. https://yourcompany.atlassian.net)', required: true },
    email: { type: 'string', description: 'Atlassian account email (Basic auth)' },
    apiToken: { type: 'string', description: 'Atlassian API token (Basic auth)', secret: true },
    bearerToken: { type: 'string', description: 'OAuth bearer token (alternative to Basic auth)', secret: true },
    jql: { type: 'string', description: 'JQL filter (default: ORDER BY updated DESC)' },
    maxResults: { type: 'number', description: 'Max results per page (max 100, default 100)' },
  },
  (config) => new JiraSource(config),
);
