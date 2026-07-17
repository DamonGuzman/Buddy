const DEFAULT_API_URL = 'https://api.firecrawl.dev/v2';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type FirecrawlJson = Record<string, unknown>;

export interface FirecrawlClientPort {
  search(query: string, options: FirecrawlJson, signal: AbortSignal): Promise<unknown>;
  scrape(url: string, options: FirecrawlJson, signal: AbortSignal): Promise<unknown>;
  map(url: string, options: FirecrawlJson, signal: AbortSignal): Promise<unknown>;
  crawl(action: string, args: FirecrawlJson, signal: AbortSignal): Promise<unknown>;
  batchScrape(action: string, args: FirecrawlJson, signal: AbortSignal): Promise<unknown>;
  research(action: string, args: FirecrawlJson, signal: AbortSignal): Promise<unknown>;
}

export interface FirecrawlClientOptions {
  getApiKey(): string | null;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}

/**
 * Abort-aware Firecrawl v2 transport. The API key is resolved immediately before
 * every request so settings changes take effect without restarting Buddy.
 */
export class FirecrawlClient implements FirecrawlClientPort {
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;

  constructor(private readonly options: FirecrawlClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  }

  search(query: string, options: FirecrawlJson, signal: AbortSignal): Promise<unknown> {
    return this.request('POST', '/search', { ...options, query }, signal);
  }

  scrape(url: string, options: FirecrawlJson, signal: AbortSignal): Promise<unknown> {
    return this.request('POST', '/scrape', { ...options, url }, signal);
  }

  map(url: string, options: FirecrawlJson, signal: AbortSignal): Promise<unknown> {
    return this.request('POST', '/map', { ...options, url }, signal);
  }

  crawl(action: string, args: FirecrawlJson, signal: AbortSignal): Promise<unknown> {
    switch (action) {
      case 'start':
        return this.request('POST', '/crawl', requiredUrlBody(args), signal);
      case 'status':
        return this.request('GET', `/crawl/${requiredId(args)}`, undefined, signal);
      case 'errors':
        return this.request('GET', `/crawl/${requiredId(args)}/errors`, undefined, signal);
      case 'cancel':
        return this.request('DELETE', `/crawl/${requiredId(args)}`, undefined, signal);
      case 'active':
        return this.request('GET', '/crawl/active', undefined, signal);
      case 'preview':
        return this.request(
          'POST',
          '/crawl/params-preview',
          { url: requiredString(args, 'url'), prompt: requiredString(args, 'prompt') },
          signal,
        );
      default:
        throw new Error(`unsupported Firecrawl crawl action: ${action}`);
    }
  }

  batchScrape(action: string, args: FirecrawlJson, signal: AbortSignal): Promise<unknown> {
    switch (action) {
      case 'start':
        return this.request('POST', '/batch/scrape', requiredUrlsBody(args), signal);
      case 'status':
        return this.request('GET', `/batch/scrape/${requiredId(args)}`, undefined, signal);
      case 'errors':
        return this.request('GET', `/batch/scrape/${requiredId(args)}/errors`, undefined, signal);
      case 'cancel':
        return this.request('DELETE', `/batch/scrape/${requiredId(args)}`, undefined, signal);
      default:
        throw new Error(`unsupported Firecrawl batch scrape action: ${action}`);
    }
  }

  research(action: string, args: FirecrawlJson, signal: AbortSignal): Promise<unknown> {
    switch (action) {
      case 'search_papers':
        return this.request(
          'GET',
          withQuery('/search/research/papers', args, [
            'query',
            'k',
            'authors',
            'categories',
            'from',
            'to',
          ]),
          undefined,
          signal,
        );
      case 'get_paper':
        return this.request(
          'GET',
          withQuery(`/search/research/papers/${requiredId(args)}`, args, ['query', 'k']),
          undefined,
          signal,
        );
      case 'related_papers':
        return this.request(
          'GET',
          withQuery(`/search/research/papers/${requiredId(args)}/similar`, args, [
            'intent',
            'mode',
            'k',
            'rerank',
            'anchor',
          ]),
          undefined,
          signal,
        );
      case 'search_github':
        return this.request(
          'GET',
          withQuery('/search/research/github', args, ['query', 'k']),
          undefined,
          signal,
        );
      default:
        throw new Error(`unsupported Firecrawl research action: ${action}`);
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: FirecrawlJson | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const apiKey = this.options.getApiKey();
    if (apiKey === null) {
      throw new Error('Firecrawl is not configured — add its API key in Buddy settings');
    }
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const raw = await readBoundedText(response, MAX_RESPONSE_BYTES);
    const payload = parseJson(raw);
    if (!response.ok) {
      throw new Error(firecrawlError(response.status, payload));
    }
    if (payload === null) {
      if (response.status === 204) return { success: true };
      throw new Error('Firecrawl returned an empty or non-JSON response');
    }
    if (isRecord(payload) && payload['success'] === false) {
      throw new Error(firecrawlError(response.status, payload));
    }
    return payload;
  }
}

function requiredUrlBody(args: FirecrawlJson): FirecrawlJson {
  const { action: _action, description: _description, ...options } = args;
  return { ...options, url: requiredString(args, 'url') };
}

function requiredUrlsBody(args: FirecrawlJson): FirecrawlJson {
  const urls = args['urls'];
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== 'string')) {
    throw new Error('Firecrawl batch scrape requires one or more URLs');
  }
  const { action: _action, description: _description, ...options } = args;
  return { ...options, urls };
}

function requiredId(args: FirecrawlJson): string {
  return encodeURIComponent(requiredString(args, 'id'));
}

function requiredString(args: FirecrawlJson, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Firecrawl ${key} is required`);
  }
  return value.trim();
}

function withQuery(path: string, args: FirecrawlJson, keys: readonly string[]): string {
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error('Firecrawl response exceeded Buddy’s size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('Firecrawl response exceeded Buddy’s size limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseJson(value: string): unknown | null {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function firecrawlError(status: number, payload: unknown): string {
  const detail = isRecord(payload)
    ? firstString(
        payload['error'],
        payload['message'],
        isRecord(payload['details']) ? payload['details']['message'] : undefined,
      )
    : null;
  return `Firecrawl request failed (${status})${detail ? `: ${detail.slice(0, 400)}` : ''}`;
}

function firstString(...values: unknown[]): string | null {
  return (
    values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
