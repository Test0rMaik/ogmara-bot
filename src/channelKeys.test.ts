import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VAULT_SIGN_CLAIM,
  WalletSigner,
  computeChannelScope,
  deriveVaultBackupKey,
  encryptDmContent,
  generateDeviceEncKeypair,
  openKeyVault,
  sealKeyVault,
  wrapConvKey,
  type VaultKeyring,
} from '@ogmara/sdk';
import { ChannelKeyService, DeviceIdentityError, loadOrCreateDeviceIdentity } from './channelKeys.js';

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * A real `WalletSigner` (fixed private key, so the address and every
 * signature are stable across a test run) — a plain mock object can't stand
 * in here because `buildEncryptedChannelMessage`/`buildDeviceEncBinding`
 * call real `WalletSigner` internals, not just `signKleverMessage`. Ed25519
 * signing is deterministic (RFC 8032), so this is also a genuine exercise of
 * `deriveVaultBackupKey`'s "same signature every time" assumption.
 */
async function testSigner(): Promise<WalletSigner> {
  const signer = await WalletSigner.fromPrivateKey(new Uint8Array(32).fill(11));
  signer.network = 'testnet';
  return signer;
}

/** The deterministic wallet signature `testSigner()` produces for the vault claim. */
let FAKE_SIG: Uint8Array;
beforeAll(async () => {
  FAKE_SIG = await (await testSigner()).signKleverMessage(new TextEncoder().encode(VAULT_SIGN_CLAIM));
});

function fakeClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}): any {
  return {
    getEncKeys: vi.fn(async () => ({ address: 'klv1bot', keys: [] })),
    publishEncKeyEnvelope: vi.fn(async () => ({})),
    getKeyEnvelope: vi.fn(async () => {
      throw new Error('API error (404): not found');
    }),
    getKeyVault: vi.fn(async () => null),
    syncKeyVault: vi.fn(async () => {}),
    getChannel: vi.fn(async () => ({
      channel: { key_epoch_floor: 0 },
      member_count: 1,
      message_count: 0,
    })),
    ...overrides,
  };
}

describe('loadOrCreateDeviceIdentity', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ogmara-devenc-'));
    path = join(dir, 'device-enc.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a fresh identity, persisted 0600, when no file exists yet', () => {
    const identity = loadOrCreateDeviceIdentity(path);
    expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.encPriv).toHaveLength(32);
    expect(identity.encPubHex).toMatch(/^[0-9a-f]{64}$/);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reloads the SAME identity on a second call, not a new one', () => {
    const first = loadOrCreateDeviceIdentity(path);
    const second = loadOrCreateDeviceIdentity(path);
    expect(second.deviceId).toBe(first.deviceId);
    expect(toHex(second.encPriv)).toBe(toHex(first.encPriv));
    expect(second.encPubHex).toBe(first.encPubHex);
  });

  it('refuses to silently replace a corrupt identity file', () => {
    writeFileSync(path, 'not json at all', { mode: 0o600 });
    expect(() => loadOrCreateDeviceIdentity(path)).toThrow(DeviceIdentityError);
  });

  it('refuses a file with the wrong shape', () => {
    writeFileSync(path, JSON.stringify({ version: 1, deviceId: 'abcd' }), { mode: 0o600 });
    expect(() => loadOrCreateDeviceIdentity(path)).toThrow(DeviceIdentityError);
  });

  it('refuses a malformed private key hex', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, deviceId: 'ab'.repeat(32), encPrivHex: 'zz' }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreateDeviceIdentity(path)).toThrow(DeviceIdentityError);
  });
});

describe('ChannelKeyService.ensureBinding', () => {
  it('does nothing when the registry already lists this exact device/enc_pub', async () => {
    const { privateKey, publicKeyHex } = generateDeviceEncKeypair();
    const identity = { deviceId: 'ab'.repeat(32), encPriv: privateKey, encPubHex: publicKeyHex };
    const signer = await testSigner();
    const client = fakeClient({
      getEncKeys: vi.fn(async () => ({
        address: signer.address,
        keys: [{ device_id: identity.deviceId, enc_pub: identity.encPubHex, created_at: 1 }],
      })),
    });
    const warn = vi.fn();
    const service = new ChannelKeyService(client, signer, identity, warn);

    await service.ensureBinding(signer.address, 'testnet');

    expect(client.publishEncKeyEnvelope).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('publishes a binding when the registry does not list this device yet', async () => {
    const { privateKey, publicKeyHex } = generateDeviceEncKeypair();
    const identity = { deviceId: 'ab'.repeat(32), encPriv: privateKey, encPubHex: publicKeyHex };
    const signer = await testSigner();
    const client = fakeClient();
    const warn = vi.fn();
    const service = new ChannelKeyService(client, signer, identity, warn);

    await service.ensureBinding(signer.address, 'testnet');

    expect(client.publishEncKeyEnvelope).toHaveBeenCalledTimes(1);
    const [walletArg, envelopeArg] = client.publishEncKeyEnvelope.mock.calls[0];
    expect(walletArg).toBe(signer.address);
    expect(envelopeArg).toBeInstanceOf(Uint8Array);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw when the registry check fails', async () => {
    const { privateKey, publicKeyHex } = generateDeviceEncKeypair();
    const identity = { deviceId: 'ab'.repeat(32), encPriv: privateKey, encPubHex: publicKeyHex };
    const signer = await testSigner();
    const client = fakeClient({
      getEncKeys: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const warn = vi.fn();
    const service = new ChannelKeyService(client, signer, identity, warn);

    await expect(service.ensureBinding(signer.address, 'testnet')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(client.publishEncKeyEnvelope).not.toHaveBeenCalled();
  });
});

describe('ChannelKeyService read/write path', () => {
  const CHANNEL_ID = 42;
  let identity: { deviceId: string; encPriv: Uint8Array; encPubHex: string };

  beforeEach(() => {
    const { privateKey, publicKeyHex } = generateDeviceEncKeypair();
    identity = { deviceId: 'cd'.repeat(32), encPriv: privateKey, encPubHex: publicKeyHex };
  });

  /** Simulate another member's client wrapping `channelKey` to this bot's device. */
  function wrapToBot(channelKey: Uint8Array, epoch: number) {
    const scope = computeChannelScope(CHANNEL_ID);
    const wrapped = wrapConvKey(channelKey, fromHex(identity.encPubHex), scope);
    return {
      key_scope: toHex(scope),
      epoch,
      envelope: {
        eph_pub: toHex(wrapped.ephPub),
        nonce: toHex(wrapped.nonce),
        wrapped: toHex(wrapped.wrapped),
      },
    };
  }

  function encryptedFrame(channelKey: Uint8Array, epoch: number, text: string) {
    const scope = computeChannelScope(CHANNEL_ID);
    const { content, nonce } = encryptDmContent(channelKey, scope, epoch, { text });
    return { encContent: content, encNonce: nonce };
  }

  it('decrypts a message once the key envelope is fetched and unwrapped', async () => {
    const channelKey = new Uint8Array(32).fill(3);
    const client = fakeClient({
      getKeyEnvelope: vi.fn(async () => wrapToBot(channelKey, 1)),
    });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());
    const { encContent, encNonce } = encryptedFrame(channelKey, 1, '/about');

    const outcome = await service.decryptChannelMessage(CHANNEL_ID, encContent, encNonce, 1);

    expect(outcome).toEqual({ text: '/about' });
    expect(client.getKeyEnvelope).toHaveBeenCalledTimes(1);
    // REGRESSION GUARD: channel keys are stored author-agnostically (a
    // shared group key), unlike DM keys — the empty-string third argument
    // is deliberate, not a leftover placeholder. Passing this wallet's own
    // address instead would make the node default `author` to the caller,
    // and every encrypted channel would permanently 404 with nothing
    // failing loudly.
    expect(client.getKeyEnvelope).toHaveBeenCalledWith(expect.any(String), identity.deviceId, '', 1);
  });

  it('caches the key — a second message in the same epoch does not re-fetch', async () => {
    const channelKey = new Uint8Array(32).fill(3);
    const client = fakeClient({ getKeyEnvelope: vi.fn(async () => wrapToBot(channelKey, 1)) });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());

    const first = encryptedFrame(channelKey, 1, '/about');
    await service.decryptChannelMessage(CHANNEL_ID, first.encContent, first.encNonce, 1);
    const second = encryptedFrame(channelKey, 1, '/help');
    const outcome = await service.decryptChannelMessage(CHANNEL_ID, second.encContent, second.encNonce, 1);

    expect(outcome).toEqual({ text: '/help' });
    expect(client.getKeyEnvelope).toHaveBeenCalledTimes(1);
  });

  it('returns "waiting" when no key envelope has been delivered (404)', async () => {
    const client = fakeClient(); // default getKeyEnvelope throws API error (404)
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());

    const outcome = await service.decryptChannelMessage(
      CHANNEL_ID,
      new Uint8Array([1, 2, 3]),
      new Uint8Array(24),
      1,
    );

    expect(outcome).toBe('waiting');
  });

  it('throttles fetch attempts per channel — a burst of distinct fake epochs costs one network call', async () => {
    // `key_epoch` rides in on an incoming message and is fully attacker-
    // controlled. Without a per-channel cooldown, a burst of messages each
    // claiming a different, never-real epoch would force one network round
    // trip per message — this proves it costs at most one per cooldown
    // window, regardless of how many distinct epochs are thrown at it.
    const client = fakeClient(); // default getKeyEnvelope always 404s
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());

    for (let epoch = 1; epoch <= 5; epoch++) {
      const outcome = await service.decryptChannelMessage(
        CHANNEL_ID,
        new Uint8Array([1]),
        new Uint8Array(24),
        epoch,
      );
      expect(outcome).toBe('waiting');
    }

    expect(client.getKeyEnvelope).toHaveBeenCalledTimes(1);
  });

  it('returns "error" when a key exists but decryption fails (wrong/rotated epoch)', async () => {
    const channelKey = new Uint8Array(32).fill(3);
    const wrongKey = new Uint8Array(32).fill(9);
    const client = fakeClient({ getKeyEnvelope: vi.fn(async () => wrapToBot(channelKey, 1)) });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());
    // Sealed under a DIFFERENT key than the one the envelope will unwrap to.
    const { encContent, encNonce } = encryptedFrame(wrongKey, 1, '/about');

    const outcome = await service.decryptChannelMessage(CHANNEL_ID, encContent, encNonce, 1);

    expect(outcome).toBe('error');
  });

  it('propagates a non-404 fetch failure rather than treating it as "waiting"', async () => {
    const client = fakeClient({
      getKeyEnvelope: vi.fn(async () => {
        throw new Error('API error (500): node hiccup');
      }),
    });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());

    await expect(
      service.decryptChannelMessage(CHANNEL_ID, new Uint8Array([1]), new Uint8Array(24), 1),
    ).rejects.toThrow('500');
  });

  it('encryptedReplyEnvelope returns null when this channel has no cached key yet', async () => {
    const client = fakeClient();
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());

    const envelope = await service.encryptedReplyEnvelope(CHANNEL_ID, 'hi', []);

    expect(envelope).toBeNull();
    expect(client.getKeyEnvelope).not.toHaveBeenCalled(); // cache-only — never a fresh fetch
  });

  it('refuses to reply under a cached epoch the channel has since rotated past', async () => {
    // spec §8.1.2: a client must never encrypt new content under an epoch
    // below the channel's key_epoch_floor — a just-removed member still
    // holds every key below it. The floor can rise (a kick/ban) at any time
    // independent of when this bot last decrypted something, so the cached
    // epoch alone is not enough evidence that it's still safe to use.
    const channelKey = new Uint8Array(32).fill(3);
    const client = fakeClient({
      getKeyEnvelope: vi.fn(async () => wrapToBot(channelKey, 1)),
      getChannel: vi.fn(async () => ({ channel: { key_epoch_floor: 2 }, member_count: 1, message_count: 0 })),
    });
    const warn = vi.fn();
    const service = new ChannelKeyService(client, await testSigner(), identity, warn);
    const { encContent, encNonce } = encryptedFrame(channelKey, 1, '/about');
    await service.decryptChannelMessage(CHANNEL_ID, encContent, encNonce, 1); // caches epoch 1

    const envelope = await service.encryptedReplyEnvelope(CHANNEL_ID, 'hi', []);

    expect(envelope).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('refuses to reply when the channel floor cannot be verified, rather than assuming it is 0', async () => {
    const channelKey = new Uint8Array(32).fill(3);
    const client = fakeClient({
      getKeyEnvelope: vi.fn(async () => wrapToBot(channelKey, 1)),
      getChannel: vi.fn(async () => {
        throw new Error('node unreachable');
      }),
    });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());
    const { encContent, encNonce } = encryptedFrame(channelKey, 1, '/about');
    await service.decryptChannelMessage(CHANNEL_ID, encContent, encNonce, 1);

    const envelope = await service.encryptedReplyEnvelope(CHANNEL_ID, 'hi', []);

    expect(envelope).toBeNull();
  });

  it('encryptedReplyEnvelope builds a real, decryptable envelope once a key is cached', async () => {
    const channelKey = new Uint8Array(32).fill(3);
    const client = fakeClient({ getKeyEnvelope: vi.fn(async () => wrapToBot(channelKey, 1)) });
    const signer = await testSigner();
    const service = new ChannelKeyService(client, signer, identity, vi.fn());
    const { encContent, encNonce } = encryptedFrame(channelKey, 1, '/about');
    await service.decryptChannelMessage(CHANNEL_ID, encContent, encNonce, 1); // populates the cache

    const envelope = await service.encryptedReplyEnvelope(CHANNEL_ID, 'hi there', ['klv1user']);

    expect(envelope).not.toBeNull();
    // Round-trip: decode the envelope and decrypt its own content under the
    // same channel key, proving this is a genuinely usable reply, not just
    // "some bytes came back".
    const { decode } = await import('@msgpack/msgpack');
    const decoded = decode(envelope!) as Record<string, unknown>;
    const payload = decode(decoded['payload'] as Uint8Array) as Record<string, unknown>;
    expect(payload['channel_id']).toBe(CHANNEL_ID);
    expect(payload['key_epoch']).toBe(1);
    const { decryptDmContent } = await import('@ogmara/sdk');
    const scope = computeChannelScope(CHANNEL_ID);
    const pt = decryptDmContent(
      channelKey,
      scope,
      1,
      payload['enc_content'] as Uint8Array,
      payload['enc_nonce'] as Uint8Array,
    );
    expect(pt.text).toBe('hi there');
  });

  it('prefers the highest epoch when more than one is cached for the same channel', async () => {
    // Exercised via restoreFromVault (rather than two decryptChannelMessage
    // calls) because #resolveKey prunes older epochs itself as soon as it
    // learns a newer one — a vault restore is the one path that can hand
    // the cache several epochs for the same channel at once, e.g. shared
    // with another of this wallet's clients that kept older history.
    const oldKey = new Uint8Array(32).fill(1);
    const newKey = new Uint8Array(32).fill(2);
    const scopeHex = toHex(computeChannelScope(CHANNEL_ID));
    const bk = deriveVaultBackupKey(await (await testSigner()).signKleverMessage(new TextEncoder().encode(VAULT_SIGN_CLAIM)));
    const sealed = sealKeyVault(bk, {
      conv: {},
      chan: { [`${scopeHex}:1`]: oldKey, [`${scopeHex}:5`]: newKey },
    });
    const client = fakeClient({ getKeyVault: vi.fn(async () => sealed) });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());
    await service.restoreFromVault();

    const envelope = await service.encryptedReplyEnvelope(CHANNEL_ID, 'hi', []);

    expect(envelope).not.toBeNull();
    const { decode } = await import('@msgpack/msgpack');
    const payload = decode(
      (decode(envelope!) as Record<string, unknown>)['payload'] as Uint8Array,
    ) as Record<string, unknown>;
    expect(payload['key_epoch']).toBe(5); // the higher of the two, never the older one
  });
});

describe('ChannelKeyService key vault', () => {
  let identity: { deviceId: string; encPriv: Uint8Array; encPubHex: string };

  beforeEach(() => {
    const { privateKey, publicKeyHex } = generateDeviceEncKeypair();
    identity = { deviceId: 'ef'.repeat(32), encPriv: privateKey, encPubHex: publicKeyHex };
  });

  it('restoreFromVault populates the cache — a subsequent decrypt needs no network fetch', async () => {
    const channelId = 7;
    const channelKey = new Uint8Array(32).fill(5);
    const scope = computeChannelScope(channelId);
    const scopeHex = toHex(scope);
    const bk = deriveVaultBackupKey(FAKE_SIG);
    const keyring: VaultKeyring = { conv: {}, chan: { [`${scopeHex}:1`]: channelKey } };
    const sealed = sealKeyVault(bk, keyring);

    const client = fakeClient({ getKeyVault: vi.fn(async () => sealed) });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());
    await service.restoreFromVault();

    const { content, nonce } = encryptDmContent(channelKey, scope, 1, { text: '/about' });
    const outcome = await service.decryptChannelMessage(channelId, content, nonce, 1);

    expect(outcome).toEqual({ text: '/about' });
    expect(client.getKeyEnvelope).not.toHaveBeenCalled();
  });

  it('restoreFromVault is a no-op, not an error, when nothing has been published yet', async () => {
    const client = fakeClient(); // getKeyVault → null
    const warn = vi.fn();
    const service = new ChannelKeyService(client, await testSigner(), identity, warn);

    await expect(service.restoreFromVault()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('backs up a newly-fetched key by merging into the remote vault, never overwriting it', async () => {
    const otherChannelId = 1;
    const otherScope = computeChannelScope(otherChannelId);
    const otherScopeHex = toHex(otherScope);
    const otherKey = new Uint8Array(32).fill(1);
    const bk = deriveVaultBackupKey(FAKE_SIG);
    const existingRemote = sealKeyVault(bk, { conv: {}, chan: { [`${otherScopeHex}:1`]: otherKey } });

    const newChannelId = 2;
    const newKey = new Uint8Array(32).fill(2);
    let currentRemote = existingRemote;
    const client = fakeClient({
      getKeyEnvelope: vi.fn(async () => {
        const scope = computeChannelScope(newChannelId);
        const wrapped = wrapConvKey(newKey, fromHex(identity.encPubHex), scope);
        return {
          key_scope: toHex(scope),
          epoch: 1,
          envelope: { eph_pub: toHex(wrapped.ephPub), nonce: toHex(wrapped.nonce), wrapped: toHex(wrapped.wrapped) },
        };
      }),
      getKeyVault: vi.fn(async () => currentRemote),
      syncKeyVault: vi.fn(async (data: any) => {
        currentRemote = data;
      }),
    });
    const service = new ChannelKeyService(client, await testSigner(), identity, vi.fn());

    const scope = computeChannelScope(newChannelId);
    const { content, nonce } = encryptDmContent(newKey, scope, 1, { text: '/about' });
    await service.decryptChannelMessage(newChannelId, content, nonce, 1);
    // The backup fires fire-and-forget after resolving the key — poll rather
    // than guess how many ticks its own signing/network awaits need.
    await vi.waitFor(() => expect(client.syncKeyVault).toHaveBeenCalledTimes(1));
    const merged = openKeyVault(bk, currentRemote);
    expect(toHex(merged.chan[`${otherScopeHex}:1`]!)).toBe(toHex(otherKey)); // old key preserved
    const newScopeHex = toHex(computeChannelScope(newChannelId));
    expect(toHex(merged.chan[`${newScopeHex}:1`]!)).toBe(toHex(newKey)); // new key added
  });
});
