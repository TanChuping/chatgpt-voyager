import { describe, expect, it } from 'vitest';

import { buildClonedButtonClassName } from '../clonedButtonClass';

describe('buildClonedButtonClassName', () => {
  it('strips ChatGPT disabled-state classes while keeping styling classes', () => {
    const source =
      'opacity-50 cursor-not-allowed btn relative btn-ghost rounded-lg hover:bg-token-surface-hover';
    const result = buildClonedButtonClassName(source, 'gv-export-conv-topbar');
    expect(result).not.toMatch(/\bopacity-50\b/);
    expect(result).not.toMatch(/\bcursor-not-allowed\b/);
    expect(result).toContain('btn-ghost');
    expect(result).toContain('rounded-lg');
    expect(result).toContain('gv-export-conv-topbar');
  });

  it('also strips pointer-events-none and disabled', () => {
    const result = buildClonedButtonClassName('btn pointer-events-none disabled', 'gv-x');
    expect(result).toBe('btn gv-x');
  });

  it('handles null/empty source and drops falsy extras', () => {
    expect(buildClonedButtonClassName(null, 'gv-a')).toBe('gv-a');
    expect(buildClonedButtonClassName('', 'gv-a', false, null, undefined)).toBe('gv-a');
    expect(buildClonedButtonClassName('btn', 'gv-a', 'gv-a--unread')).toBe('btn gv-a gv-a--unread');
  });

  it('does not touch classes that merely contain a disabled token as a substring', () => {
    // e.g. a hypothetical "opacity-50/50" or "group-disabled:..." must survive
    const result = buildClonedButtonClassName('btn opacity-50/80 group-disabled:opacity-50', 'gv-x');
    expect(result).toContain('opacity-50/80');
    expect(result).toContain('group-disabled:opacity-50');
    expect(result).toContain('gv-x');
  });
});
