import { describe, expect, it } from 'vitest';

import { extractPlainTitle } from '../compactTitle';

describe('extractPlainTitle', () => {
  it('returns empty string for empty or whitespace-only input', () => {
    expect(extractPlainTitle('')).toBe('');
    expect(extractPlainTitle('   \n  \n\t')).toBe('   \n  \n\t'.trim());
  });

  it('strips a leading H1 marker', () => {
    expect(extractPlainTitle('# 璇戝\n鑻辨枃鍏ュ銆?)).toBe('璇戝');
  });

  it('strips higher-level heading markers', () => {
    expect(extractPlainTitle('### Section title')).toBe('Section title');
    expect(extractPlainTitle('###### Deep heading')).toBe('Deep heading');
  });

  it('strips bullet and numeric list markers', () => {
    expect(extractPlainTitle('- first bullet\nrest')).toBe('first bullet');
    expect(extractPlainTitle('1. first step')).toBe('first step');
    expect(extractPlainTitle('* starred bullet')).toBe('starred bullet');
  });

  it('strips blockquote markers', () => {
    expect(extractPlainTitle('> a quoted prompt')).toBe('a quoted prompt');
    expect(extractPlainTitle('>>> triple quoted')).toBe('triple quoted');
  });

  it('strips wrapping emphasis around the whole line', () => {
    expect(extractPlainTitle('**bold title**')).toBe('bold title');
    expect(extractPlainTitle('__underline title__')).toBe('underline title');
  });

  it('skips blank leading lines and uses the first non-empty line', () => {
    expect(extractPlainTitle('\n\n\n瀹為檯鏍囬\n鏇村鍐呭')).toBe('瀹為檯鏍囬');
  });

  it('preserves inner punctuation and content', () => {
    expect(extractPlainTitle('# Translate: English 鈫?Chinese')).toBe(
      'Translate: English 鈫?Chinese',
    );
  });

  it('falls back to the full trimmed text when every line is empty after stripping', () => {
    // A line that consists purely of marker tokens trims to empty and we skip it,
    // but if every line is empty the helper returns trimmed original.
    expect(extractPlainTitle('   ')).toBe('');
  });

  it('does not strip a trailing # inside the line', () => {
    expect(extractPlainTitle('issue #586 repro')).toBe('issue #586 repro');
  });

  it('returns the first plaintext line when the prompt starts with no markers', () => {
    expect(extractPlainTitle('缈昏瘧\n鑻辨枃娈佃惤')).toBe('缈昏瘧');
  });
});