import type { AttachmentInfo } from './attachments';

export type DotElement = HTMLButtonElement & {
  dataset: DOMStringMap & {
    targetTurnId?: string;
    markerIndex?: string;
  };
};

export type MarkerLevel = 1 | 2 | 3;

export interface PreviewMarkerData {
  readonly id: string;
  readonly summary: string;
  readonly index: number;
  readonly starred: boolean;
  /** Timestamp (ms since epoch) when the message was starred; undefined if not starred. */
  readonly starredAt?: number;
  /** File attachments ChatGPT rendered into this user turn, in DOM order. */
  readonly attachments?: ReadonlyArray<AttachmentInfo>;
}