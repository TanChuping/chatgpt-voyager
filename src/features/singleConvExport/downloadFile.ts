/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */

/**
 * Trigger a browser download for an in-memory blob. Uses a temporary anchor
 * + URL.createObjectURL — works inside content scripts because no extension
 * privileges are required for same-origin Object URLs.
 */
export function downloadBlob(content: string, filename: string, mime: string): void {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Defer revoke to next tick so the browser has time to actually start the
    // download — same pattern as the existing export module.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
        a.remove();
      } catch {
        /* ignore */
      }
    }, 1000);
  } catch (err) {
    console.warn('[GPT-Voyager] downloadBlob failed', err);
  }
}
