import { StorageKeys } from '@/core/types/common';

interface ApprovalRecord {
  time: string;
  tool: string;
  path: string;
  result: '点击' | '失败';
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/** One background writer serializes records from every tab; store no card text. */
export function appendDriveApprovalRecord(value: unknown): Promise<void> {
  const input = value as Partial<ApprovalRecord> | null;
  if (
    !input ||
    typeof input.time !== 'string' ||
    !Number.isFinite(Date.parse(input.time)) ||
    typeof input.tool !== 'string' ||
    !input.tool.trim() ||
    input.tool.length > 120 ||
    typeof input.path !== 'string' ||
    !input.path.startsWith('/') ||
    input.path.length > 512 ||
    /[?#]/.test(input.path) ||
    (input.result !== '点击' && input.result !== '失败')
  ) {
    return Promise.reject(new Error('invalid_drive_approval_record'));
  }
  const entry: ApprovalRecord = {
    time: new Date(input.time).toISOString(),
    tool: input.tool,
    path: input.path,
    result: input.result,
  };
  const write = pendingWrite.then(async () => {
    const key = StorageKeys.DRIVE_AUTO_ALLOW_LOG;
    const stored = await chrome.storage.local.get(key);
    const history = Array.isArray(stored[key]) ? stored[key] : [];
    await chrome.storage.local.set({ [key]: [...history.slice(-49), entry] });
  });
  // A storage failure must not poison subsequent records.
  pendingWrite = write.catch(() => undefined);
  return write;
}
