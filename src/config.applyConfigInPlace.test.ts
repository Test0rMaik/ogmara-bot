import { describe, expect, it } from 'vitest';
import { applyConfigInPlace, type Config } from './config.js';

/**
 * `applyConfigInPlace` is the one function that makes hot-reload possible —
 * see the doc comment on it in `config.ts` and the object-identity tests in
 * `settingsDeps.test.ts`. These tests cover the merge mechanics in
 * isolation, without the config-file/validation machinery around it.
 */

function fixture(overrides: Partial<{ a: number; b: { c: number; d: number } }> = {}): {
  a: number;
  b: { c: number; d: number };
} {
  return { a: 1, b: { c: 2, d: 3 }, ...overrides };
}

describe('applyConfigInPlace', () => {
  it('copies top-level primitive fields onto the target', () => {
    const target = fixture();
    applyConfigInPlace(target as unknown as Config, fixture({ a: 9 }) as unknown as Config);
    expect(target.a).toBe(9);
  });

  it('recurses into nested objects rather than replacing them wholesale', () => {
    const target = fixture();
    const nestedRef = target.b;
    applyConfigInPlace(
      target as unknown as Config,
      fixture({ b: { c: 99, d: 3 } }) as unknown as Config,
    );
    // The nested object's IDENTITY must survive — only its fields change —
    // or anything holding a reference to `target.b` specifically (not just
    // `target`) would still observe the OLD values.
    expect(target.b).toBe(nestedRef);
    expect(target.b.c).toBe(99);
    expect(target.b.d).toBe(3);
  });

  it('the target object itself keeps its identity across the call', () => {
    const target = fixture();
    const targetRef = target;
    applyConfigInPlace(target as unknown as Config, fixture({ a: 42 }) as unknown as Config);
    expect(target).toBe(targetRef);
  });

  it('overwrites an array wholesale rather than merging element-by-element', () => {
    const target = { list: [1, 2, 3] };
    applyConfigInPlace(
      target as unknown as Config,
      { list: [9] } as unknown as Config,
    );
    expect(target.list).toEqual([9]);
  });

  it('is idempotent: applying the same source twice leaves the same result', () => {
    const target = fixture();
    const source = fixture({ a: 5, b: { c: 6, d: 7 } });
    applyConfigInPlace(target as unknown as Config, source as unknown as Config);
    applyConfigInPlace(target as unknown as Config, source as unknown as Config);
    expect(target).toEqual(source);
  });

  it('deletes a key present in target but absent from source', () => {
    // A Zod `.optional()` field with NO `.default()` is omitted from the
    // parsed output entirely when unset — not present as `undefined` — so a
    // save that clears such a field back to "unset" must delete it here, or
    // the live object keeps reporting the stale value forever. (Real
    // instance in this codebase: `sources.imagedir.contentRating`.)
    const target: Record<string, unknown> = { a: 1, rating: 'mature' };
    const source: Record<string, unknown> = { a: 1 }; // `rating` genuinely absent, not undefined
    applyConfigInPlace(target as unknown as Config, source as unknown as Config);
    expect('rating' in target).toBe(false);
  });

  it('deletes a nested key the same way, not just at the top level', () => {
    const target = { section: { kept: 1, rating: 'mature' } };
    const source = { section: { kept: 1 } };
    applyConfigInPlace(target as unknown as Config, source as unknown as Config);
    expect('rating' in target.section).toBe(false);
    expect(target.section.kept).toBe(1);
  });

  it('never installs a dangerous key, even if one reaches it — defense in depth', () => {
    // `source` should never carry one in practice (see the doc comment on
    // `applyConfigInPlace`), but this is a new, generically-reusable
    // recursive object-mutator, so it must not trust that on its own.
    const target: Record<string, unknown> = { a: 1 };
    const malicious = JSON.parse('{"a": 2, "__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;
    applyConfigInPlace(target as unknown as Config, malicious as unknown as Config);
    expect(target.a).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(false);
  });
});
