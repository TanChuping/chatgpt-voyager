export const IMAGE_RENDER_EVENT_ERROR_CODE = 'image_render_event_error' as const;

/** Distinguishes our null-Blob failure from third-party errors with similar text. */
export class EmptyImageRenderError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    super(`Image render failed (${width}x${height})`);
  }
}

export function isEventLikeImageRenderError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const maybeEvent = error as {
    type?: unknown;
    preventDefault?: unknown;
    stopPropagation?: unknown;
  };

  return (
    maybeEvent.type === 'error' &&
    typeof maybeEvent.preventDefault === 'function' &&
    typeof maybeEvent.stopPropagation === 'function'
  );
}
