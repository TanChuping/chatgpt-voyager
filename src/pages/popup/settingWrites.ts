type WriteSyncSetting = (items: Record<string, unknown>) => Promise<void>;

interface SettingWriteState {
  confirmed: unknown;
  revision: number;
  tail: Promise<void>;
}

/**
 * Keep optimistic controls responsive, but serialize writes to each original
 * sync key. A failed final intent rolls back to the last successful value;
 * an older failure must not overwrite a newer choice still waiting to save.
 * This queue owns no persistence, fallback area, retry, or preference schema.
 */
export function createSettingWriteQueue(write: WriteSyncSetting) {
  const states = new Map<string, SettingWriteState>();

  return {
    /** The existing font import also writes preset/enabled metadata. Keep a
     * later rollback aligned with those successful writes to the same keys. */
    acknowledge(items: Record<string, unknown>): void {
      for (const [key, value] of Object.entries(items)) {
        const state = states.get(key);
        if (state) state.confirmed = value;
      }
    },
    change<T>(
      key: string,
      value: T,
      previous: T,
      apply: (value: T) => void,
      onFailure: (error: unknown) => void,
    ): Promise<boolean> {
      let state = states.get(key);
      if (!state) {
        state = { confirmed: previous, revision: 0, tail: Promise.resolve() };
        states.set(key, state);
      }
      const current = state;
      const revision = ++current.revision;
      apply(value);

      const result = current.tail.then(async () => {
        try {
          await write({ [key]: value });
          current.confirmed = value;
          return true;
        } catch (error) {
          if (revision === current.revision) {
            apply(current.confirmed as T);
            onFailure(error);
          }
          return false;
        }
      });
      // A callback failure cannot poison subsequent user-initiated writes.
      current.tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
