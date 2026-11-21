/** An export-session hint. Existing browser-profile stores are not partitioned by login. */
export async function currentAccountFingerprint(): Promise<string | null> {
  try {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const user = (await response.json())?.user;
    if (typeof user?.id !== 'string' || !user.id.trim()) return null;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('gpt-voyager/transfer/account/v1:' + user.id),
    );
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
export function accountMatch(source: unknown, current: string | null): 'matched' | 'unknown' {
  if (source == null) return 'unknown';
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(source)) throw new Error('invalid');
  if (!current) return 'unknown';
  if (source !== current) throw new Error('account-mismatch');
  return 'matched';
}
