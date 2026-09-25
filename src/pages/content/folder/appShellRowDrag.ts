/**
 * Drag ChatGPT sidebar rows into folders on the 2026-09 app shell.
 *
 * The rows are dnd-kit draggables now (ChatGPT's own "drag a chat into a
 * project"). While the pointer is down, dnd-kit cancels every native
 * `dragstart` (a window listener calls preventDefault), so a row can no longer
 * start the HTML5 drag the folder drop zones listen for. Instead of fighting
 * it, ride ChatGPT's pointer drag — it already draws the ghost row — and, while
 * the pointer is over the folder panel, replay it as HTML5 `dragover` /
 * `dragleave` / `drop` events on the panel element under the pointer, carrying
 * the usual `application/json` payload. The existing drop zones handle those
 * unchanged, and ChatGPT's own project drop keeps working.
 */

const ACTIVATION_DISTANCE_PX = 5;

export interface RowDragBridgeOptions {
  /** Only elements inside this root receive the replayed drag events. */
  getDropRoot: () => HTMLElement | null;
  /** Called once the pointer has moved far enough; returns the JSON payload, or null to abort. */
  begin: () => string | null;
  /** Called after the drop or cancel to undo `begin`'s visual state. */
  end: () => void;
}

/** Starts tracking from a row's `pointerdown`; returns a function that cancels it. */
export function trackAppShellRowDrag(
  down: PointerEvent,
  options: RowDragBridgeOptions,
): () => void {
  const startX = down.clientX;
  const startY = down.clientY;
  let transfer: DataTransfer | null = null;
  let hovered: Element | null = null;
  let stopped = false;

  const targetAt = (event: PointerEvent): Element | null => {
    const root = options.getDropRoot();
    if (!root) return null;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    return hit && root.contains(hit) ? hit : null;
  };

  const fire = (type: string, target: Element, event: PointerEvent | null) =>
    target.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: event?.clientX ?? 0,
        clientY: event?.clientY ?? 0,
        dataTransfer: transfer,
      }),
    );

  const onMove = (event: PointerEvent) => {
    // Missed the release (e.g. outside the window): end without dropping.
    if ((event.buttons & 1) === 0) {
      finish(event, false);
      return;
    }
    if (!transfer) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < ACTIVATION_DISTANCE_PX) {
        return;
      }
      const payload = options.begin();
      if (!payload) {
        stop();
        return;
      }
      transfer = new DataTransfer();
      transfer.setData('application/json', payload);
      transfer.effectAllowed = 'move';
    }
    const target = targetAt(event);
    if (hovered && hovered !== target) fire('dragleave', hovered, event);
    if (target) fire('dragover', target, event);
    hovered = target;
  };

  /** `event` is null when the caller cancels tracking. */
  const finish = (event: PointerEvent | null, drop: boolean) => {
    if (stopped) return;
    stop();
    if (!transfer) return;
    const target = drop && event ? targetAt(event) : null;
    if (target) fire('drop', target, event);
    else if (hovered) fire('dragleave', hovered, event);
    options.end();
  };
  const onUp = (event: PointerEvent) => finish(event, true);
  const onCancel = (event: PointerEvent) => finish(event, false);

  function stop(): void {
    stopped = true;
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
  }

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
  return () => finish(null, false);
}
