// The file stays in the content script that received the user's file selection.
let pending: { ticket: string; file: File } | undefined;
let timer: number | undefined;
export function forgetFile(ticket: string) {
  if (pending?.ticket !== ticket) return;
  window.clearTimeout(timer);
  pending = undefined;
}
export function offerFile(file: File) {
  window.clearTimeout(timer);
  const ticket = crypto.randomUUID();
  pending = { ticket, file };
  timer = window.setTimeout(() => forgetFile(ticket), 120000);
  return ticket;
}
export function takeFile(ticket: string) {
  if (!pending || pending.ticket !== ticket) throw new Error('changed');
  const file = pending.file;
  forgetFile(ticket);
  return file;
}
