// GitHub REST + GraphQL client (fetch-based, no dependencies) with bounded retries, secondary
// rate-limit handling and token redaction. The token is held only by the supervisor process.
import { registerSecret } from '../core/redact.js';

export class GitHubError extends Error {
  constructor(public status: number, public body: string, public method: string, public path: string) {
    super(`GitHub ${method} ${path} → ${status}: ${body.slice(0, 300)}`);
  }
}

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  graphqlUrl?: string;
  uploadsUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class GitHubClient {
  readonly apiUrl: string;
  private graphqlUrl: string;
  private uploadsUrl: string;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private o: GitHubClientOptions) {
    registerSecret(o.token);
    this.apiUrl = (o.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.graphqlUrl = o.graphqlUrl ?? `${this.apiUrl}/graphql`;
    this.uploadsUrl = (o.uploadsUrl ?? 'https://uploads.github.com').replace(/\/$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.o.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.o.apiVersion ?? '2022-11-28',
      'User-Agent': 'agent-workflow-orchestrator',
      ...extra,
    };
  }

  async request<T = any>(method: string, path: string, body?: unknown, opts: { base?: string; raw?: Buffer; contentType?: string; allow404?: boolean } = {}): Promise<T> {
    const url = `${opts.base ?? this.apiUrl}${path}`;
    const max = this.o.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: this.headers(opts.raw ? { 'Content-Type': opts.contentType ?? 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          body: opts.raw ? new Uint8Array(opts.raw) : body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt >= max) throw e;
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 404 && opts.allow404) return null as T;
      if (res.ok) {
        if (res.status === 204) return null as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const text = await res.text();
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const rateLimited = res.status === 429 || (res.status === 403 && (remaining === '0' || /secondary rate limit|abuse/i.test(text)));
      if ((rateLimited || res.status >= 500) && attempt < max) {
        const wait = retryAfter ? retryAfter * 1000 : rateLimited && reset ? Math.max(1000, reset * 1000 - Date.now()) : 1000 * 2 ** attempt;
        await this.sleep(Math.min(wait, 15 * 60_000));
        continue;
      }
      throw new GitHubError(res.status, text, method, path);
    }
  }

  async paginate<T = any>(path: string, max = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; out.length < max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await this.request<T[]>('GET', `${path}${sep}per_page=100&page=${page}`);
      if (!batch?.length) break;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await this.request<{ data?: T; errors?: Array<{ message: string }> }>('POST', '', { query, variables }, { base: this.graphqlUrl });
    if (r?.errors?.length) throw new GitHubError(200, r.errors.map((e) => e.message).join('; '), 'POST', 'graphql');
    return r!.data as T;
  }

  upload(path: string, data: Buffer, contentType: string): Promise<any> {
    return this.request('POST', path, undefined, { base: this.uploadsUrl, raw: data, contentType });
  }
}
