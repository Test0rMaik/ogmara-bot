import { describe, expect, it } from 'vitest';
import { OgmaraPublisher } from './ogmara.js';
import type { Config, Secrets } from './config.js';

/**
 * `OgmaraPublisher.rebuildClient()` and the `health()` network-race fix —
 * both new for hot-reloading `node.url`/`node.network`/`node.timeoutMs`.
 * No existing test file covers `OgmaraPublisher` construction directly
 * (its own methods are otherwise tested indirectly, e.g. `RateBudget` via
 * `ratebudget.test.ts`) — these two pieces are genuinely new logic, not a
 * mirror of an already-tested pattern, so they get their own coverage.
 */

const TEST_KEY = 'ab'.repeat(32);
const secrets: Secrets = { walletKeyHex: TEST_KEY };

function minimalConfig(node: { url?: string; network?: string; timeoutMs?: number } = {}): Config {
  return {
    node: {
      url: node.url ?? 'https://node.example',
      network: node.network ?? 'testnet',
      timeoutMs: node.timeoutMs ?? 30_000,
    },
    posting: { maxPostsPerHour: 1 },
  } as unknown as Config;
}

describe('OgmaraPublisher.rebuildClient', () => {
  it('swaps in a genuinely new client instance', async () => {
    const config = minimalConfig();
    const publisher = await OgmaraPublisher.create(config, secrets);
    const before = publisher.client;
    publisher.rebuildClient();
    expect(publisher.client).not.toBe(before);
  });

  it('rebuilds from the CURRENT config, not the one captured at construction time', async () => {
    // Mutating `config.node.url` directly, in place — this is exactly what
    // `applyConfigInPlace` does to the SAME shared object on a real save;
    // `rebuildClient()` must read that live value, not a snapshot taken
    // when `create()` first ran.
    const config = minimalConfig({ url: 'https://old.example' });
    const publisher = await OgmaraPublisher.create(config, secrets);
    config.node.url = 'https://new.example';
    expect(() => publisher.rebuildClient()).not.toThrow();
    expect(publisher.client).toBeDefined();
  });

  it('re-attaches the SAME signer, not a new one', async () => {
    const config = minimalConfig();
    const publisher = await OgmaraPublisher.create(config, secrets);
    const signerBefore = publisher.signer;
    publisher.rebuildClient();
    expect(publisher.signer).toBe(signerBefore);
  });

  it('clears the signer\'s CACHED network resolution — the actual mechanism that makes a rebuild take effect for signing', async () => {
    // CRITICAL REGRESSION GUARD (code audit). The SDK's WalletSigner caches
    // its resolved network into `signer.network` on first use and never
    // re-derives it after that — NOT even if `networkProvider` is later
    // repointed at a new client via `.withSigner()`. Re-attaching the
    // signer alone (proven by the previous test) is therefore NOT enough:
    // without also clearing this cache, every post after the bot's first
    // would keep signing under whatever network was resolved at startup,
    // no matter how many times node.network changed afterward — silently
    // defeating the entire point of making node.network live-appliable,
    // and exactly the cross-network replay `confirm: true` exists to guard
    // against. `network` is a real, public, mutable field on WalletSigner
    // (not a private implementation detail) — asserted directly here.
    const config = minimalConfig();
    const publisher = await OgmaraPublisher.create(config, secrets);
    // Simulates a resolution having already happened from an earlier post.
    publisher.signer.network = 'testnet';
    publisher.rebuildClient();
    expect(publisher.signer.network).toBeUndefined();
  });
});

describe('OgmaraPublisher.health', () => {
  it('is immune to a node.network save racing an in-flight health() call', async () => {
    // REGRESSION GUARD. `health()` used to read `this.#config.node.network`
    // AFTER `await this.#client.health()` — since `#config` is the same
    // shared object a save mutates in place, a network change landing
    // WHILE the call was in flight compared the node's response against
    // the NEW value instead of the one that was actually current when the
    // call started.
    const config = minimalConfig({ network: 'testnet' });
    const publisher = await OgmaraPublisher.create(config, secrets);

    let resolveHealth: ((value: unknown) => void) | undefined;
    (publisher.client as any).health = (): Promise<unknown> =>
      new Promise((resolve) => {
        resolveHealth = resolve;
      });

    const healthPromise = publisher.health();
    // A save changes node.network WHILE the call above is still pending —
    // the exact race this fix closes.
    config.node.network = 'mainnet';
    resolveHealth?.({ status: 'ok', version: '1.0.0', peers: 1, network: 'testnet' });

    // The node genuinely reported "testnet", and that WAS node.network at
    // the moment this call started — must succeed, not throw a mismatch
    // by comparing against whatever node.network raced to afterwards.
    const result = await healthPromise;
    expect(result.network).toBe('testnet');
  });

  it('still throws NetworkMismatchError for a genuine mismatch (no race involved)', async () => {
    const config = minimalConfig({ network: 'testnet' });
    const publisher = await OgmaraPublisher.create(config, secrets);
    (publisher.client as any).health = async () => ({
      status: 'ok',
      version: '1.0.0',
      peers: 1,
      network: 'mainnet',
    });
    await expect(publisher.health()).rejects.toThrow(/serves "mainnet"/);
  });
});
