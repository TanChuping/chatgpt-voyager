export interface SettingsSurfaceResult {
  error?: string;
  mode?: 'action-popup' | 'window';
  ok: boolean;
}

export interface SettingsSurfaceDependencies {
  focusWindow: (windowId: number) => Promise<unknown>;
  getSettingsUrl: () => string;
  openActionPopup: () => Promise<void>;
  openWindow: (url: string) => Promise<{ id?: number } | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prefer the browser's anchored action popup. Chromium forks may reject that
 * API after a content-script message loses transient user activation, so keep
 * one extension-owned popup window as a reliable fallback.
 */
export function createSettingsSurfaceOpener(dependencies: SettingsSurfaceDependencies) {
  let fallbackWindowId: number | null = null;

  return async (): Promise<SettingsSurfaceResult> => {
    try {
      await dependencies.openActionPopup();
      return { ok: true, mode: 'action-popup' };
    } catch (popupError) {
      if (fallbackWindowId !== null) {
        try {
          await dependencies.focusWindow(fallbackWindowId);
          return { ok: true, mode: 'window' };
        } catch {
          fallbackWindowId = null;
        }
      }

      try {
        const created = await dependencies.openWindow(dependencies.getSettingsUrl());
        fallbackWindowId = typeof created?.id === 'number' ? created.id : null;
        return { ok: true, mode: 'window' };
      } catch (windowError) {
        return {
          ok: false,
          error: `${errorMessage(popupError)}; fallback: ${errorMessage(windowError)}`,
        };
      }
    }
  };
}
