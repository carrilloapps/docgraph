import { RemoteDocument, RemoteSource, SourceProvider } from './types.js';

/**
 * Options controlling {@link fetchWithRetry}'s backoff behaviour.
 */
export interface RetryOptions {
  /** Number of retry attempts after the first try (default 3, so up to 4 total attempts). */
  retries?: number;
  /** Base delay (ms) for exponential backoff, before jitter (default 500). */
  baseDelayMs?: number;
  /** Ceiling for the computed backoff delay, before jitter (default 8000). */
  maxDelayMs?: number;
}

/**
 * Perform an HTTP request, retrying with exponential backoff (+ jitter) when
 * the response is HTTP 429 (rate limited) or 5xx (server error), or when the
 * underlying `fetch` throws (transient network failure). Honors a numeric or
 * HTTP-date `Retry-After` header when the server sends one.
 *
 * On the final attempt, a 429/5xx response is returned as-is (not thrown) so
 * callers keep their existing `!response.ok` handling; a persistent network
 * error is re-thrown.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;

  let lastNetworkError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      lastNetworkError = err;
      if (attempt === retries) throw err;
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
      continue;
    }

    const isRetryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (!isRetryable || attempt === retries) {
      return response;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    await sleep(retryAfterMs ?? backoffDelay(attempt, baseDelayMs, maxDelayMs));
  }

  // Unreachable in practice (the loop always returns or throws), but keeps
  // TypeScript's control-flow analysis happy and gives a sane error if it
  // ever is.
  throw lastNetworkError instanceof Error ? lastNetworkError : new Error(`fetchWithRetry: exhausted retries for ${url}`);
}

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  // Full jitter: spreads out retries from many sources hitting the same
  // rate-limited API at once instead of thundering back in lockstep.
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight calls.
 * Used to bound how many remote sources are pulled in parallel: pulling
 * hundreds of configured sources fully sequentially is slow, but unbounded
 * concurrency can trip provider rate limits or exhaust local sockets.
 * Results preserve input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const boundedLimit = Math.max(1, Math.floor(limit) || 1);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.min(boundedLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Generic HTTP/REST source that performs JSON requests against an API, then
 * projects the response into {@link RemoteDocument}s via a caller-supplied
 * extractor. Concrete sources (Notion, Jira, Confluence, Linear, GitHub) wire
 * this base class to their endpoints without duplicating pagination, retry,
 * and auth logic.
 *
 * Keep dependencies small: only Node built-ins (fetch is stable in Node ≥ 18).
 */
export abstract class HttpRemoteSource implements RemoteSource {
  abstract readonly name: string;
  abstract readonly description: string;

  protected abstract get endpoint(): string;
  protected abstract authHeaders(): Record<string, string>;

  protected abstract extractPage(payload: unknown, page: number): RemoteDocument[];
  protected abstract hasMore(payload: unknown, page: number): boolean;
  protected abstract nextPage(payload: unknown, page: number): number | null;

  /**
   * Hard cap on the number of pages `fetchAll()` will traverse. Defaults to
   * 200 (a generous ceiling for runaway `hasMore()` implementations) and is
   * narrowed by {@link configureMaxPages}, which the indexing service calls
   * with `settings.sources.maxPagesPerSource`.
   */
  protected maxPages = 200;

  /** See {@link RemoteSource.configureMaxPages}. */
  configureMaxPages(maxPages: number): void {
    if (Number.isFinite(maxPages) && maxPages > 0) {
      this.maxPages = Math.floor(maxPages);
    }
  }

  async list(): Promise<RemoteDocument[]> {
    return this.fetchAll();
  }

  async listSince(since: Date): Promise<RemoteDocument[]> {
    const all = await this.fetchAll();
    return all.filter((doc) => {
      if (!doc.lastModified) return true;
      return new Date(doc.lastModified) >= since;
    });
  }

  async get(id: string): Promise<RemoteDocument | null> {
    const all = await this.fetchAll();
    return all.find((doc) => doc.id === id) ?? null;
  }

  private async fetchAll(): Promise<RemoteDocument[]> {
    const documents: RemoteDocument[] = [];
    let page = 1;

    while (page <= this.maxPages) {
      const url = this.pageUrl(page);
      let payload: unknown;
      try {
        payload = await this.fetchJson(url);
      } catch (err) {
        // A single bad page (retries exhausted on a 429/5xx, or a genuine
        // network failure) must not discard pages already fetched. If we
        // have nothing yet (e.g. the very first page is unreachable), the
        // source is effectively down — rethrow so the caller can log/handle
        // total failure the way it always has.
        if (documents.length > 0) break;
        throw err;
      }
      const pageDocuments = this.extractPage(payload, page);
      documents.push(...pageDocuments);

      if (!this.hasMore(payload, page)) break;
      const next = this.nextPage(payload, page);
      if (next === null || next <= page) break;
      page = next;
    }

    return documents;
  }

  protected pageUrl(_page: number): string {
    return this.endpoint;
  }

  protected async fetchJson(url: string): Promise<unknown> {
    const response = await fetchWithRetry(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'docgraph/1.0 (+https://github.com/carrilloapps/docgraph)',
        ...this.authHeaders(),
      },
    });
    if (!response.ok) {
      throw new Error(`[${this.name}] HTTP ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  }
}

/**
 * Helper for the source registry: small adapters shouldn't each need a factory.
 * Wraps a {@link RemoteSource} constructor plus a static configSchema into the
 * SourceProvider shape the registry expects.
 */
export function defineSource(
  name: string,
  description: string,
  configSchema: SourceProvider['configSchema'],
  factory: (config: Record<string, unknown>, projectPath: string) => RemoteSource,
): SourceProvider {
  return { name, description, configSchema, create: factory };
}
