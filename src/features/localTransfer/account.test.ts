import { expect, it } from 'vitest';

import { accountMatch } from './account';

it('blocks two different known accounts, independently of overlap or an empty library', () => {
  const first = '1'.repeat(64),
    second = '2'.repeat(64);
  expect(accountMatch(first, first)).toBe('matched');
  expect(() => accountMatch(first, second)).toThrow('account-mismatch');
  expect(() => accountMatch('invalid', first)).toThrow('invalid');
});

it('treats exports without a login hint and unavailable sessions as unverified', () => {
  expect(accountMatch(undefined, '1'.repeat(64))).toBe('unknown');
  expect(accountMatch('1'.repeat(64), null)).toBe('unknown');
});
