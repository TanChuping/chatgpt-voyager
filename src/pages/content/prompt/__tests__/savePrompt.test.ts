import { beforeEach, expect, it, vi } from 'vitest';

import { promptStorageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';

import { type PromptItem, savePrompt } from '../savePrompt';

vi.mock('@/core/services/StorageService', () => ({ promptStorageService: { set: vi.fn() } }));
const set = vi.mocked(promptStorageService.set);
const prompt = (id: string, text: string): PromptItem => ({ id, text, tags: [], createdAt: 1 });
beforeEach(() => {
  set.mockReset();
  set.mockResolvedValue({ success: true, data: undefined });
});

it('saves a long prompt in full and distinguishes a difference at its end', async () => {
  const text = '长提示词内容\n'.repeat(15000);
  const existing = prompt('old', text + 'A');
  const candidate = { ...prompt('new', text + 'B'), name: 'Long prompt', tags: ['test'] };
  const result = await savePrompt([existing], candidate, null);
  expect(result.status).toBe('saved');
  expect(set).toHaveBeenCalledWith(StorageKeys.PROMPT_ITEMS, [candidate, existing]);
  expect(existing.text).toBe(text + 'A');
});

it('reports an exact duplicate without writing or replacing the existing prompt', async () => {
  const items = [prompt('old', 'Existing text')];
  expect(await savePrompt(items, prompt('new', ' existing TEXT '), null)).toEqual({
    status: 'duplicate',
  });
  expect(set).not.toHaveBeenCalled();
  expect(items[0].id).toBe('old');
});

it('does not reject saving an unchanged prompt during editing', async () => {
  const existing = prompt('old', 'Same text');
  const edited = { ...existing, name: 'New name' };
  expect(await savePrompt([existing], edited, 'old')).toEqual({ status: 'saved', items: [edited] });
});

it('leaves the original list and edited draft intact after a failed write', async () => {
  set.mockResolvedValue({ success: false, error: new Error('QUOTA_BYTES exceeded') } as never);
  const existing = prompt('old', 'Previous text');
  const items = [existing];
  const edited = { ...existing, text: 'New text', name: 'Draft' };
  expect(await savePrompt(items, edited, 'old')).toEqual({ status: 'failed' });
  expect(items).toEqual([prompt('old', 'Previous text')]);
  expect(edited.text).toBe('New text');
});
