/**
 * Channel-key handling — device encryption identity, key fetch/cache/decrypt,
 * encrypted replies, and network key-vault backup/restore (protocol §2.4,
 * §2.5, §8).
 *
 * Single-account port of desktop's `deviceEnc.ts` + `channelCrypto.ts`: this
 * bot is always exactly one wallet, so every piece of multi-account/
 * account-switch-race machinery those files carry (per-account storage keys,
 * "generation" freshness checks) simply does not apply here and is omitted.
 *
 * This bot is a pure key CONSUMER, never an establisher: it never creates a
 * channel's first epoch, never rotates one, and never "covers" a newly
 * joined member (all creator/mod-only operations). It only binds its own
 * device identity, waits for some other already-a-member client to wrap the
 * current epoch key to it (the ONLY delivery path the protocol defines —
 * spec §8.1.1), and once it has a key, decrypts incoming commands and
 * encrypts its replies.
 *
 * The only local secret this introduces is the device X25519 encryption
 * private key (never the wallet key, never a content key) — persisted like
 * any other bot state file, 0600 + atomic write. Channel/DM content keys
 * live only in memory, restored at startup from the network-stored,
 * wallet-signature-derived key vault (spec §2.5) — deliberately not given a
 * second local file, since the vault already exists to serve exactly this
 * purpose and a redeploy should recover the same way a fresh device would.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildDeviceEncBinding,
  buildEncryptedChannelMessage,
  computeChannelScope,
  decryptDmContent,
  deriveVaultBackupKey,
  emptyKeyring,
  encPublicKeyHex,
  generateDeviceEncKeypair,
  openKeyVault,
  sealKeyVault,
  unwrapConvKey,
  VAULT_SIGN_CLAIM,
  type OgmaraClient,
  type VaultKeyring,
  type WalletSigner,
  type WrappedKey,
} from '@ogmara/sdk';
import { httpStatusFromError } from './ogmara.js';

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function hexToBytes(h: string): Uint8Array {
  const clean = h.toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Raised when the on-disk device encryption identity cannot be trusted as-is. */
export class DeviceIdentityError extends Error {
  override readonly name = 'DeviceIdentityError';
}

/** This wallet's device encryption identity. */
export interface DeviceEncIdentity {
  /** 32-byte device id, hex — a random, stable public identifier (spec §2.4). */
  readonly deviceId: string;
  /** 32-byte X25519 private key. Never transmitted, never in the key vault. */
  readonly encPriv: Uint8Array;
  /** Hex of the matching X25519 public key. */
  readonly encPubHex: string;
}

interface StoredIdentity {
  version: 1;
  deviceId: string;
  encPrivHex: string;
}

/**
 * Load this wallet's device encryption identity from `path`, creating one on
 * first run. Persisted exactly like `autojoin.ts`'s state file — atomic
 * temp-file + rename, `0o600` — because a torn write here would either lose
 * the identity (forcing every channel to re-serve a key to a new one) or,
 * worse, leave two different processes believing they hold the same device
 * id with different keys.
 *
 * A corrupt file is NOT treated as "generate a new identity" — unlike
 * auto-join's cursor state, silently minting a new device id here throws
 * away every key already wrapped to the old one, so this fails loudly
 * instead and lets the operator decide (restore a backup, or accept the
 * reset by moving the file aside).
 */
export function loadOrCreateDeviceIdentity(path: string): DeviceEncIdentity {
  let raw: string | undefined;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = undefined;
  }

  if (raw !== undefined) {
    const corrupt = (): never => {
      throw new DeviceIdentityError(
        `device encryption identity at "${path}" is corrupt or has an unexpected shape — ` +
          'refusing to overwrite it with a new identity (that would orphan every channel key ' +
          'already wrapped to the old one). Restore it from backup, or delete it deliberately ' +
          'to accept starting fresh.',
      );
    };
    let parsed: Partial<StoredIdentity>;
    try {
      parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    } catch {
      return corrupt();
    }
    if (
      parsed.version !== 1 ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.encPrivHex !== 'string'
    ) {
      return corrupt();
    }
    let encPriv: Uint8Array;
    try {
      encPriv = hexToBytes(parsed.encPrivHex);
    } catch {
      return corrupt();
    }
    if (encPriv.length !== 32) return corrupt();
    // Re-derived rather than stored separately — one fewer field that could
    // drift from the private key it belongs to.
    return { deviceId: parsed.deviceId, encPriv, encPubHex: encPublicKeyHex(encPriv) };
  }

  const deviceId = toHex(randomBytes(32));
  const { privateKey, publicKeyHex } = generateDeviceEncKeypair();
  const identity: DeviceEncIdentity = { deviceId, encPriv: privateKey, encPubHex: publicKeyHex };
  saveDeviceIdentity(path, identity);
  return identity;
}

function saveDeviceIdentity(path: string, identity: DeviceEncIdentity): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    encPrivHex: toHex(identity.encPriv),
  };
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Outcome of trying to read/decrypt a channel message. */
export type DecryptOutcome = { readonly text: string } | 'waiting' | 'error';

/**
 * Channel-key service for one wallet.
 *
 * Owns the in-memory content-key cache and the device identity, and is the
 * single place that talks to the node for enc-key binding, key envelopes and
 * the key vault. Constructed once at startup and threaded into the commands
 * module's `reply`/`decryptChannelText` dependencies.
 */
export class ChannelKeyService {
  // Not readonly — see setClient(). Every encrypted-channel operation
  // below reads `this.#client` fresh at call time (no method caches it
  // across an await), so swapping the reference is enough.
  #client: OgmaraClient;
  readonly #signer: WalletSigner;
  readonly #identity: DeviceEncIdentity;
  readonly #warn: (message: string) => void;
  /** `${channelScopeHex}:${epoch}` → the unwrapped 32-byte channel key. */
  readonly #cache = new Map<string, Uint8Array>();
  #vaultBackupPending = false;
  /** A `#backupToVault` call arrived while one was already in flight. */
  #vaultBackupDirty = false;
  /**
   * `scopeHex` → last time a key-envelope fetch was ATTEMPTED for it
   * (whether or not it succeeded). Bounded by the number of distinct
   * channels this bot listens to — never grows with message volume.
   */
  readonly #lastFetchAttempt = new Map<string, number>();
  /** Minimum time between key-envelope fetch attempts for the same channel. */
  static readonly FETCH_COOLDOWN_MS = 15_000;

  constructor(
    client: OgmaraClient,
    signer: WalletSigner,
    identity: DeviceEncIdentity,
    warn: (message: string) => void,
  ) {
    this.#client = client;
    this.#signer = signer;
    this.#identity = identity;
    this.#warn = warn;
  }

  /**
   * Live-apply a `node.url`/`node.network`/`node.timeoutMs` change: swap
   * in the freshly-rebuilt client `OgmaraPublisher.rebuildClient()` just
   * built. Without this, every encrypted-channel operation — including
   * the commands module's encrypted reply path — would keep talking to
   * the OLD node forever after a live node change, since this service
   * held its own separate client reference.
   */
  setClient(client: OgmaraClient): void {
    this.#client = client;
  }

  /** This wallet's stable device id, hex. */
  get deviceId(): string {
    return this.#identity.deviceId;
  }

  /**
   * Publish this device's `DeviceEncBinding` if the node's registry does not
   * already list it — required before ANY other client can wrap a channel
   * key to this bot. Best-effort: a failure here (network hiccup at boot)
   * is logged and does not stop the bot starting, since posting/news still
   * work without it — it just means this run can't receive new keys yet.
   */
  async ensureBinding(walletAddress: string, network: string): Promise<void> {
    // Snapshotted once — this method reads the client twice, across two
    // awaits, so a setClient() swap (a live node.url/network change) landing
    // in between must not let the fetch and the publish it's based on go to
    // two different nodes. Same reasoning as OgmaraPublisher.publish().
    const client = this.#client;
    try {
      const existing = await client.getEncKeys(walletAddress);
      const alreadyBound = existing.keys.some(
        (k) =>
          k.device_id.toLowerCase() === this.#identity.deviceId.toLowerCase() &&
          k.enc_pub.toLowerCase() === this.#identity.encPubHex.toLowerCase(),
      );
      if (alreadyBound) return;

      const envelope = await buildDeviceEncBinding({
        walletAddress,
        encPubHex: this.#identity.encPubHex,
        deviceIdHex: this.#identity.deviceId,
        network,
        walletSign: async (claim: string) =>
          this.#signer.signKleverMessage(new TextEncoder().encode(claim)),
      });
      await client.publishEncKeyEnvelope(walletAddress, envelope);
    } catch (err) {
      this.#warn(
        '  warning: could not publish this device\'s encryption-key binding ' +
          `(${err instanceof Error ? err.message : String(err)}) — encrypted channels will not ` +
          'work until this succeeds; will retry on next start.',
      );
    }
  }

  /**
   * Restore previously-known content keys from the network key-vault.
   *
   * Best-effort, called once at startup after binding. `signKleverMessage`
   * is deterministic for a given claim string on a real Ed25519 key, so this
   * costs nothing to derive fresh every run rather than caching it — unlike
   * a human wallet, there is no popup/UX cost to re-deriving it.
   */
  async restoreFromVault(): Promise<void> {
    try {
      const sig = await this.#signer.signKleverMessage(new TextEncoder().encode(VAULT_SIGN_CLAIM));
      const bk = deriveVaultBackupKey(sig);
      const remote = await this.#client.getKeyVault();
      if (remote === null) return; // nothing published yet — not an error
      const keyring = openKeyVault(bk, remote);
      for (const [scopedEpoch, key] of Object.entries(keyring.chan)) {
        this.#cache.set(scopedEpoch, key);
      }
      // The vault may carry more than one epoch per channel (e.g. shared
      // with another of this wallet's clients that keeps history for
      // FullHistory channels) — this bot only ever needs the current one.
      for (const scopeHex of new Set([...this.#cache.keys()].map((k) => k.split(':')[0]!))) {
        const latest = this.#cachedLatest(scopeHex);
        if (latest !== null) this.#pruneOlderEpochs(scopeHex, latest.epoch);
      }
    } catch (err) {
      this.#warn(
        `  warning: could not restore the key vault (${err instanceof Error ? err.message : String(err)}) ` +
          '— channels this bot already had keys for will need a member to re-serve them.',
      );
    }
  }

  /**
   * Merge the current in-memory cache into the remote vault, fetch-then-merge
   * (never a blind overwrite — a naive publish could clobber content keys a
   * concurrent process or an earlier run stored that this cache never
   * re-fetched). Debounced to at most one in-flight backup at a time. A call
   * that arrives while a pass is already running does not just drop — it
   * marks `#vaultBackupDirty` so the in-flight pass immediately starts
   * another one after it finishes, ensuring a key learned mid-pass (which
   * that pass's own `#cache` snapshot may already have missed) still gets a
   * backup pass of its own rather than silently waiting for some unrelated
   * future cache miss to trigger one.
   */
  async #backupToVault(): Promise<void> {
    if (this.#vaultBackupPending) {
      this.#vaultBackupDirty = true;
      return;
    }
    this.#vaultBackupPending = true;
    this.#vaultBackupDirty = false;
    // Snapshotted once — this is a read-merge-write across two client
    // calls; a setClient() swap landing between them must not read the
    // vault from one node and write the merged result to another.
    const client = this.#client;
    try {
      const sig = await this.#signer.signKleverMessage(new TextEncoder().encode(VAULT_SIGN_CLAIM));
      const bk = deriveVaultBackupKey(sig);
      let keyring: VaultKeyring;
      try {
        const remote = await client.getKeyVault();
        keyring = remote === null ? emptyKeyring() : openKeyVault(bk, remote);
      } catch {
        // Can't safely merge into a vault we can't read — skip this pass
        // rather than risk overwriting content keys we cannot see.
        return;
      }
      for (const [scopedEpoch, key] of this.#cache) {
        keyring.chan[scopedEpoch] = key;
      }
      const sealed = sealKeyVault(bk, keyring);
      await client.syncKeyVault(sealed);
    } catch (err) {
      this.#warn(
        `  warning: could not back up channel keys to the key vault (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      this.#vaultBackupPending = false;
      if (this.#vaultBackupDirty) void this.#backupToVault();
    }
  }

  /** Highest cached epoch key for `channelId`'s scope, or `null`. */
  #cachedLatest(scopeHex: string): { key: Uint8Array; epoch: number } | null {
    let best: { key: Uint8Array; epoch: number } | null = null;
    for (const [k, key] of this.#cache) {
      const [hex, epochStr] = k.split(':');
      if (hex !== scopeHex) continue;
      const epoch = Number(epochStr);
      if (best === null || epoch > best.epoch) best = { key, epoch };
    }
    return best;
  }

  /**
   * Drop every cached epoch for `scopeHex` older than `keepEpoch`. Bounds
   * `#cache` (and, through it, the vault) to at most one live epoch per
   * channel — this bot only ever needs the CURRENT epoch to reply, and
   * `decryptChannelMessage` re-fetches on demand for a specific epoch of an
   * incoming message, so nothing here relies on old epochs staying cached.
   */
  #pruneOlderEpochs(scopeHex: string, keepEpoch: number): void {
    for (const k of this.#cache.keys()) {
      const [hex, epochStr] = k.split(':');
      if (hex === scopeHex && Number(epochStr) < keepEpoch) this.#cache.delete(k);
    }
  }

  /**
   * Resolve the channel key for `epoch`, cache-first. On a cache miss,
   * fetches and unwraps this wallet's per-device envelope; a 404 means no
   * key has been delivered yet.
   *
   * Fetch attempts are throttled PER CHANNEL SCOPE, independent of the
   * requested epoch: `key_epoch` rides in on an incoming message's payload
   * and is fully attacker-controlled (any wallet in the channel can send
   * any value), so without this, a burst of messages each claiming a
   * different, never-real epoch would force a fresh network round trip per
   * message, for every channel the bot listens to. Real key delivery is not
   * time-critical (rotation happens on a member removal, not a hot path),
   * so a channel-wide cooldown between fetch attempts bounds this to a
   * constant rate no matter how many distinct epoch values arrive.
   */
  async #resolveKey(
    channelId: number,
    epoch: number,
  ): Promise<{ key: Uint8Array; epoch: number } | 'missing'> {
    const scope = computeChannelScope(channelId);
    const scopeHex = toHex(scope);

    const cached = this.#cache.get(`${scopeHex}:${epoch}`);
    if (cached !== undefined) return { key: cached, epoch };

    const lastAttempt = this.#lastFetchAttempt.get(scopeHex) ?? 0;
    if (Date.now() - lastAttempt < ChannelKeyService.FETCH_COOLDOWN_MS) return 'missing';
    this.#lastFetchAttempt.set(scopeHex, Date.now());

    let resp;
    try {
      resp = await this.#client.getKeyEnvelope(scopeHex, this.#identity.deviceId, '', epoch);
    } catch (err) {
      if (httpStatusFromError(err) === 404) return 'missing';
      throw err;
    }
    if (resp.envelope === null || resp.epoch === null) return 'missing';

    const wrapped: WrappedKey = {
      ephPub: hexToBytes(resp.envelope.eph_pub),
      nonce: hexToBytes(resp.envelope.nonce),
      wrapped: hexToBytes(resp.envelope.wrapped),
    };
    const key = unwrapConvKey(wrapped, this.#identity.encPriv, scope);
    this.#cache.set(`${scopeHex}:${resp.epoch}`, key);
    this.#pruneOlderEpochs(scopeHex, resp.epoch);
    void this.#backupToVault();
    return { key, epoch: resp.epoch };
  }

  /**
   * Decrypt one channel message. `'waiting'` means no key has been delivered
   * for this epoch yet — the only recovery is another member's client
   * serving it (spec §8.1.1); `'error'` means a key exists but decryption
   * failed (wrong/rotated epoch key, or a corrupt frame).
   */
  async decryptChannelMessage(
    channelId: number,
    encContent: Uint8Array,
    encNonce: Uint8Array,
    keyEpoch: number,
  ): Promise<DecryptOutcome> {
    const resolved = await this.#resolveKey(channelId, keyEpoch);
    if (resolved === 'missing') return 'waiting';
    const scope = computeChannelScope(channelId);
    try {
      const pt = decryptDmContent(resolved.key, scope, keyEpoch, encContent, encNonce);
      return { text: pt.text };
    } catch {
      return 'error';
    }
  }

  /**
   * Build a signed, encrypted `ChatMessage` envelope for `channelId`, using
   * whatever key this wallet already has CACHED — deliberately never a fresh
   * key-envelope fetch. Every reply this module sends is in response to a
   * command it just decrypted in that same channel (see
   * `decryptChannelMessage`), which necessarily already resolved and cached
   * that channel's current key; a plaintext channel never populates the
   * cache at all. So a cache miss here means "this reply is not going into
   * an encrypted channel", not "the key hasn't arrived yet" — the caller
   * falls back to a plain `sendMessage` in that case, which is what makes
   * every existing `bot.channels` reply cost zero extra network round trips.
   *
   * The channel's `key_epoch_floor` (spec §8.1.2) IS fetched fresh every
   * time, though, and checked before sending: it is "the only
   * confidentiality boundary in the group case" — a member removal raises
   * it, and a client must never encrypt new content under an epoch below
   * it, since a just-removed member still holds every key below the floor.
   * A cached epoch can go stale between one reply and the next (a kick/ban
   * can happen at any time, independent of when this bot last decrypted
   * anything), so this cannot be inferred from the cache and must be
   * re-verified on every send. A network hiccup while checking is treated
   * as "cannot verify" and refuses to send — never as "floor is 0".
   */
  async encryptedReplyEnvelope(
    channelId: number,
    text: string,
    mentions: string[],
  ): Promise<Uint8Array | null> {
    const scopeHex = toHex(computeChannelScope(channelId));
    const resolved = this.#cachedLatest(scopeHex);
    if (resolved === null) return null;

    let floor: number;
    try {
      const { channel } = await this.#client.getChannel(channelId);
      floor = channel.key_epoch_floor ?? 0;
    } catch (err) {
      this.#warn(
        `  warning: could not verify channel ${channelId}'s key-epoch floor before replying ` +
          `(${err instanceof Error ? err.message : String(err)}) — not sending this reply.`,
      );
      return null;
    }
    if (resolved.epoch < floor) {
      // The cached key is for an epoch a removal has since rotated past.
      // Drop it so the next decrypt attempt re-fetches rather than reusing
      // a key the node will never again consider current.
      this.#cache.delete(`${scopeHex}:${resolved.epoch}`);
      this.#warn(
        `  warning: channel ${channelId}'s key rotated past this bot's cached epoch ` +
          `(${resolved.epoch} < floor ${floor}) — not replying until a member serves the new key.`,
      );
      return null;
    }

    return buildEncryptedChannelMessage(this.#signer, {
      channelId,
      convKey: resolved.key,
      epoch: resolved.epoch,
      text,
      mentions,
    });
  }
}
