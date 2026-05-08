import { describe, expect, it } from 'vitest';

import { composeForkInputWithContext } from '../forkContext';

describe('composeForkInputWithContext', () => {
  it('should use Chinese context when language is zh', () => {
    const output = composeForkInputWithContext('# title\n\n### 馃懁 User\n\nhello', 'zh');
    expect(output).toContain('# 鍒嗘敮涓婁笅鏂?);
    expect(output).toContain('# Conversation History');
  });

  it('should fallback to English for unknown language', () => {
    const output = composeForkInputWithContext('history', 'xx');
    expect(output).toContain('# Branch Context');
    expect(output).toContain('history');
  });
});