import { describe, expect, it, vi } from 'vitest';
import { FirecrawlClient } from '../src/main/firecrawl/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FirecrawlClient', () => {
  it('resolves the current key for every request and sends it only in bearer auth', async () => {
    let key = 'fc-first-credential-123456789';
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true, data: { web: [] } }),
    );
    const client = new FirecrawlClient({ getApiKey: () => key, fetchImpl });

    await client.search('first query', { limit: 3 }, new AbortController().signal);
    key = 'fc-second-credential-12345678';
    await client.map('https://example.com', {}, new AbortController().signal);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.firecrawl.dev/v2/search');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fc-first-credential-123456789',
    });
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fc-second-credential-12345678',
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ limit: 3, query: 'first query' }),
    );
  });

  it('fails before network access when no key is configured', async () => {
    const fetchImpl = vi.fn();
    const client = new FirecrawlClient({ getApiKey: () => null, fetchImpl });
    await expect(
      client.scrape('https://example.com', {}, new AbortController().signal),
    ).rejects.toThrow('add its API key in Buddy settings');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps crawl and batch lifecycle actions to the documented v2 endpoints', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const client = new FirecrawlClient({
      getApiKey: () => 'fc-test-credential-1234567890',
      fetchImpl: vi.fn(async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        return jsonResponse({ success: true, id: 'job-1' });
      }),
    });
    const signal = new AbortController().signal;

    await client.crawl('start', { url: 'https://example.com', limit: 20 }, signal);
    await client.crawl('status', { id: 'crawl/job' }, signal);
    await client.crawl('errors', { id: 'crawl/job' }, signal);
    await client.crawl('cancel', { id: 'crawl/job' }, signal);
    await client.crawl('active', {}, signal);
    await client.crawl(
      'preview',
      { url: 'https://example.com', prompt: 'only blog posts' },
      signal,
    );
    await client.batchScrape(
      'start',
      { urls: ['https://example.com/a'], formats: ['markdown'] },
      signal,
    );
    await client.batchScrape('status', { id: 'batch-1' }, signal);
    await client.batchScrape('errors', { id: 'batch-1' }, signal);
    await client.batchScrape('cancel', { id: 'batch-1' }, signal);

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST https://api.firecrawl.dev/v2/crawl',
      'GET https://api.firecrawl.dev/v2/crawl/crawl%2Fjob',
      'GET https://api.firecrawl.dev/v2/crawl/crawl%2Fjob/errors',
      'DELETE https://api.firecrawl.dev/v2/crawl/crawl%2Fjob',
      'GET https://api.firecrawl.dev/v2/crawl/active',
      'POST https://api.firecrawl.dev/v2/crawl/params-preview',
      'POST https://api.firecrawl.dev/v2/batch/scrape',
      'GET https://api.firecrawl.dev/v2/batch/scrape/batch-1',
      'GET https://api.firecrawl.dev/v2/batch/scrape/batch-1/errors',
      'DELETE https://api.firecrawl.dev/v2/batch/scrape/batch-1',
    ]);
  });

  it('supports all current non-agent research operations', async () => {
    const urls: string[] = [];
    const client = new FirecrawlClient({
      getApiKey: () => 'fc-test-credential-1234567890',
      fetchImpl: vi.fn(async (input) => {
        urls.push(String(input));
        return jsonResponse({ success: true, results: [] });
      }),
    });
    const signal = new AbortController().signal;
    await client.research('search_papers', { query: 'diffusion', k: 5 }, signal);
    await client.research('get_paper', { id: 'arxiv:1234', query: 'method' }, signal);
    await client.research(
      'related_papers',
      { id: 'arxiv:1234', intent: 'find replications', k: 4 },
      signal,
    );
    await client.research('search_github', { query: 'retry bug', k: 10 }, signal);

    expect(urls).toEqual([
      'https://api.firecrawl.dev/v2/search/research/papers?query=diffusion&k=5',
      'https://api.firecrawl.dev/v2/search/research/papers/arxiv%3A1234?query=method',
      'https://api.firecrawl.dev/v2/search/research/papers/arxiv%3A1234/similar?intent=find+replications&k=4',
      'https://api.firecrawl.dev/v2/search/research/github?query=retry+bug&k=10',
    ]);
  });

  it('returns actionable API errors without including the credential', async () => {
    const key = 'fc-never-leak-this-credential';
    const client = new FirecrawlClient({
      getApiKey: () => key,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ success: false, error: 'rate limit reached' }, 429),
      ),
    });
    let message = '';
    try {
      await client.map('https://example.com', {}, new AbortController().signal);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Firecrawl request failed (429): rate limit reached');
    expect(message).not.toContain(key);
  });

  it('passes cancellation through to fetch', async () => {
    const controller = new AbortController();
    const client = new FirecrawlClient({
      getApiKey: () => 'fc-test-credential-1234567890',
      fetchImpl: vi.fn(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    });
    const request = client.search('query', {}, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
