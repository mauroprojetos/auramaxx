import { describe, expect, it } from 'vitest';
import {
  appendDiaryEntry,
  countDiaryEntries,
  DIARY_ENTRY_COUNT_KEY,
  resolveDiaryEntryCount,
} from '../../lib/diary';

describe('diary helpers', () => {
  it('separates appended entries with a blank line', () => {
    const next = appendDiaryEntry('first post line 1\nfirst post line 2', 'second post line 1');
    expect(next).toBe('first post line 1\nfirst post line 2\n\nsecond post line 1');
  });

  it('counts modern multi-line diary entries by blank-line separator', () => {
    const content = [
      'post one line 1',
      'post one line 2',
      '',
      'post two line 1',
      'post two line 2',
      'post two line 3',
    ].join('\n');
    expect(countDiaryEntries(content)).toBe(2);
  });

  it('keeps legacy header-based counting', () => {
    const content = [
      '--- 09:00 UTC ---',
      'legacy one',
      '',
      '--- 10:00 UTC ---',
      'legacy two',
    ].join('\n');
    expect(countDiaryEntries(content)).toBe(2);
  });

  it('prefers stored entry_count metadata when present', () => {
    const meta = { [DIARY_ENTRY_COUNT_KEY]: 7 };
    const content = 'single line';
    expect(resolveDiaryEntryCount(meta, content)).toBe(7);
  });
});
