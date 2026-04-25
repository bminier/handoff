import { describe, expect, it } from 'bun:test';
import { slugify } from '../src/slug.ts';

describe('slugify', () => {
  it('lowercases and dasherizes simple titles', () => {
    expect(slugify('Fix Login Bug')).toBe('fix-login-bug');
  });

  it('strips punctuation', () => {
    expect(slugify('Fix: a really, really weird bug!?')).toBe('fix-a-really-really-weird-bug');
  });

  it('collapses runs of separators', () => {
    expect(slugify('a   b___c---d')).toBe('a-b-c-d');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('truncates at maxLen on a word boundary when possible', () => {
    const out = slugify('this is a fairly long title that we need to truncate', { maxLen: 30 });
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith('-')).toBe(false);
    expect(out).toBe('this-is-a-fairly-long-title');
  });

  it('returns a fallback for empty input', () => {
    expect(slugify('')).toBe('task');
    expect(slugify('!!!')).toBe('task');
  });

  it('strips diacritics rather than the base letter', () => {
    expect(slugify('café résumé')).toBe('cafe-resume');
  });
});
