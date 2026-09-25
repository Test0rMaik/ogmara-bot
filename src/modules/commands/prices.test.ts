import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupToken, _resetPriceCacheForTests } from './prices.js';

/** Route `fetch(url)` calls to canned `Response`s, keyed by exact URL string — same shape as http.test.ts. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch to ${url}`);
      return handler();
    }),
  );
}

const TOKENS_URL = 'https://api.bitcoin.me/tokens';

const sampleResponse = () =>
  new Response(
    JSON.stringify([
      { tokenInAbbr: 'KLV', price: '0.00123', sparkline7d: Array.from({ length: 168 }, (_, i) => 0.001 + i * 0.00001) },
      { tokenInAbbr: 'BTC', price: '65000.5', sparkline7d: [64000, 64500, 65000.5] },
    ]),
    { status: 200 },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  _resetPriceCacheForTests();
});

describe('lookupToken', () => {
  it('finds a token case-insensitively and returns its canonical ticker', async () => {
    stubFetch({ [TOKENS_URL]: sampleResponse });
    const out = await lookupToken('klv');
    expect(out).not.toBeNull();
    expect(out!.symbol).toBe('KLV');
    expect(out!.price).toBeCloseTo(0.00123);
    expect(out!.sparkline).toHaveLength(168);
  });

  it('returns null for an unknown symbol rather than throwing', async () => {
    stubFetch({ [TOKENS_URL]: sampleResponse });
    expect(await lookupToken('NOPE')).toBeNull();
  });

  it('caches across calls within the TTL — only one fetch for two lookups', async () => {
    const spy = vi.fn(async () => sampleResponse());
    vi.stubGlobal('fetch', spy);
    await lookupToken('KLV');
    await lookupToken('BTC');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent lookups into a single in-flight fetch', async () => {
    let resolveResponse: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const spy = vi.fn(async () => pending);
    vi.stubGlobal('fetch', spy);
    const a = lookupToken('KLV');
    const b = lookupToken('BTC');
    resolveResponse!(sampleResponse());
    const [ra, rb] = await Promise.all([a, b]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ra?.symbol).toBe('KLV');
    expect(rb?.symbol).toBe('BTC');
  });

  it('skips malformed entries rather than failing the whole response', async () => {
    stubFetch({
      [TOKENS_URL]: () =>
        new Response(
          JSON.stringify([
            { tokenInAbbr: 'GOOD', price: '1.5', sparkline7d: [1, 2] },
            { tokenInAbbr: 'BAD', price: 'not-a-number', sparkline7d: [] },
            { price: '2', sparkline7d: [] }, // missing tokenInAbbr
            'not-even-an-object',
          ]),
          { status: 200 },
        ),
    });
    expect(await lookupToken('GOOD')).not.toBeNull();
    // BAD has an unparseable price — lookupToken itself returns null for it.
    expect(await lookupToken('BAD')).toBeNull();
  });

  it('rejects a tokenInAbbr that is not a plain short alphanumeric ticker (security audit, BLOCKING)', async () => {
    // tokenInAbbr reaches a bot-signed reply's text AND a button's literal
    // `command` string by direct interpolation — an unfiltered feed entry
    // could carry `@`/`#`/URL-shaped text into a message signed by the
    // operator's wallet, or something long enough to blow l2-node's
    // MAX_BUTTON_COMMAND cap and silently kill the whole reply. Bad entries
    // must never enter the cache at all, not merely be escaped on the way
    // out (the same value has to survive round-tripping through a button's
    // command too, where there is no escaping mechanism).
    stubFetch({
      [TOKENS_URL]: () =>
        new Response(
          JSON.stringify([
            { tokenInAbbr: 'OK', price: '1', sparkline7d: [] },
            { tokenInAbbr: '@klv1attacker', price: '1', sparkline7d: [] },
            { tokenInAbbr: '#hashtag', price: '1', sparkline7d: [] },
            { tokenInAbbr: 'https://evil.example', price: '1', sparkline7d: [] },
            { tokenInAbbr: 'A'.repeat(17), price: '1', sparkline7d: [] }, // one over the 16-char cap
            { tokenInAbbr: '', price: '1', sparkline7d: [] },
            { tokenInAbbr: 'has space', price: '1', sparkline7d: [] },
          ]),
          { status: 200 },
        ),
    });
    expect(await lookupToken('OK')).not.toBeNull();
    expect(await lookupToken('@klv1attacker')).toBeNull();
    expect(await lookupToken('#hashtag')).toBeNull();
    expect(await lookupToken('https://evil.example')).toBeNull();
    expect(await lookupToken('A'.repeat(17))).toBeNull();
    expect(await lookupToken('has space')).toBeNull();
  });

  it('accepts a ticker right up to the 16-character cap', async () => {
    stubFetch({
      [TOKENS_URL]: () =>
        new Response(JSON.stringify([{ tokenInAbbr: 'B'.repeat(16), price: '1', sparkline7d: [] }]), {
          status: 200,
        }),
    });
    expect(await lookupToken('B'.repeat(16))).not.toBeNull();
  });

  it('throws on a genuinely malformed (non-array) response, for the caller to word', async () => {
    stubFetch({ [TOKENS_URL]: () => new Response(JSON.stringify({ oops: true }), { status: 200 }) });
    await expect(lookupToken('KLV')).rejects.toThrow(/unexpected response shape/);
  });

  it('throws on an HTTP error status', async () => {
    stubFetch({ [TOKENS_URL]: () => new Response('', { status: 503 }) });
    await expect(lookupToken('KLV')).rejects.toThrow();
  });
});
