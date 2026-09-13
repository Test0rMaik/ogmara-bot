import { describe, expect, it } from 'vitest';
import { EN, LOCALES, TRANSLATIONS } from './i18n.js';

/**
 * Every non-English locale must carry EXACTLY the same key set as English.
 *
 * A missing key falls back to English at runtime rather than crashing, which
 * is the right behaviour in production — but it is also how a locale silently
 * drifts out of date forever, since nothing ever forces anyone to notice. This
 * test is the thing that notices instead.
 */
describe('translation key parity', () => {
  const enKeys = new Set(Object.keys(EN));

  it('is non-trivial — the key set is not accidentally empty', () => {
    expect(enKeys.size).toBeGreaterThan(50);
  });

  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    it(`${locale} has every English key, and no extra ones`, () => {
      const keys = new Set(Object.keys(TRANSLATIONS[locale]));
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      expect(missing, `${locale} is missing keys`).toEqual([]);
      expect(extra, `${locale} has keys English does not`).toEqual([]);
    });

    it(`${locale} has no empty translation`, () => {
      // An empty string is a silent English fallback with no error, no test
      // failure and no visible gap — indistinguishable from "translated to
      // nothing" until an operator reads that language and finds a blank.
      const empties = Object.entries(TRANSLATIONS[locale])
        .filter(([, v]) => v.trim() === '')
        .map(([k]) => k);
      expect(empties).toEqual([]);
    });
  }

  it('every {placeholder} in English also appears in every translation', () => {
    // A translation that drops a {var} placeholder does not fail to render —
    // it renders a sentence quietly missing a number, an address, or an error
    // message, which is worse than a visible gap.
    const placeholderRe = /\{(\w+)\}/g;
    const problems: string[] = [];
    for (const [key, enText] of Object.entries(EN)) {
      const enPlaceholders = new Set([...enText.matchAll(placeholderRe)].map((m) => m[1]));
      if (enPlaceholders.size === 0) continue;
      for (const locale of LOCALES) {
        if (locale === 'en') continue;
        const text = TRANSLATIONS[locale][key];
        if (text === undefined) continue; // already caught by the parity test
        const gotPlaceholders = new Set([...text.matchAll(placeholderRe)].map((m) => m[1]));
        for (const ph of enPlaceholders) {
          if (!gotPlaceholders.has(ph)) problems.push(`${locale}.${key} is missing {${ph}}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
