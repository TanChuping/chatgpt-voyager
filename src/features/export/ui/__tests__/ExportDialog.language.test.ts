import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '@locales/en/messages.json';
import ruMessages from '@locales/ru/messages.json';

import { IMAGE_EXPORT_WIDTH_WIDE } from '../../types/export';
import { ExportDialog, type ExportDialogOptions } from '../ExportDialog';

const locale = vi.hoisted(() => ({ messages: {} as Record<string, { message: string }> }));
vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => locale.messages[key]?.message ?? key,
}));

const dialogs: ExportDialog[] = [];

function ready(messages: typeof enMessages | typeof ruMessages): void {
  locale.messages = messages;
  window.dispatchEvent(new CustomEvent('voyager:language-changed'));
}

function element<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const result = root.querySelector<T>(selector);
  if (!result) throw new Error(`Missing export dialog element: ${selector}`);
  return result;
}

function options(): ExportDialogOptions {
  return {
    onExport: vi.fn(),
    onCancel: vi.fn(),
    translations: {
      title: enMessages.export_dialog_title.message,
      selectFormat: enMessages.export_dialog_select.message,
      warning: enMessages.export_dialog_warning.message,
      safariCmdpHint: enMessages.export_dialog_safari_cmdp_hint.message,
      safariMarkdownHint: enMessages.export_dialog_safari_markdown_hint.message,
      cancel: enMessages.pm_cancel.message,
      export: enMessages.pm_export.message,
      fontSizeLabel: enMessages.export_fontsize_label.message,
      fontSizePreview: enMessages.export_fontsize_preview.message,
      imageWidthLabel: enMessages.export_image_width_label.message,
      imageWidthNarrow: enMessages.export_image_width_narrow.message,
      imageWidthMedium: enMessages.export_image_width_medium.message,
      imageWidthWide: enMessages.export_image_width_wide.message,
      formatDescriptions: {
        json: enMessages.export_format_json_description.message,
        markdown: enMessages.export_format_markdown_description.message,
        pdf: enMessages.export_format_pdf_description.message,
        image: enMessages.export_format_image_description.message,
      },
    },
  };
}

function show(opts = options()): ExportDialog {
  const dialog = new ExportDialog();
  dialogs.push(dialog);
  dialog.show(opts);
  return dialog;
}

function formatOption(format: string): HTMLElement {
  const radio = element<HTMLInputElement>(`input[name="export-format"][value="${format}"]`);
  return radio.closest<HTMLElement>('.gv-export-format-option')!;
}

beforeEach(() => {
  locale.messages = enMessages;
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/120.0.0.0 Safari/537.36');
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Google Inc.');
});

afterEach(() => {
  dialogs.splice(0).forEach((dialog) => dialog.hide());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ExportDialog dictionary-ready refresh', () => {
  it.each(['image', 'pdf'] as const)(
    'updates open %s controls in place and exports the unchanged user selection',
    (format) => {
      const opts = options();
      show(opts);
      const wrapper = element('.gv-export-dialog');
      const title = element('.gv-export-dialog-title');
      const radio = element<HTMLInputElement>(`input[name="export-format"][value="${format}"]`);
      radio.click();
      const slider = element<HTMLInputElement>('.gv-export-fontsize-slider');
      const fontSize = format === 'image' ? 25 : 14;
      slider.value = String(fontSize);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const wide = element<HTMLButtonElement>('.gv-export-width-btn:last-child');
      if (format === 'image') wide.click();
      slider.focus();
      wrapper.scrollTop = 37;
      const badge = element('.gv-export-format-badge');

      ready(ruMessages);

      expect(element('.gv-export-dialog')).toBe(wrapper);
      expect(element('.gv-export-dialog-title')).toBe(title);
      expect(title.textContent).toBe(ruMessages.export_dialog_title.message);
      expect(element('.gv-export-dialog-subtitle').textContent).toBe(
        ruMessages.export_dialog_select.message,
      );
      expect(element('.gv-export-dialog-warning').textContent).toBe(
        ruMessages.export_dialog_warning.message,
      );
      expect(element('.gv-export-dialog-btn-secondary').textContent).toBe(
        ruMessages.pm_cancel.message,
      );
      expect(element('.gv-export-dialog-btn-primary').textContent).toBe(
        ruMessages.pm_export.message,
      );
      expect(element('.gv-export-fontsize-label').textContent).toBe(
        ruMessages.export_fontsize_label.message,
      );
      const preview = element('.gv-export-fontsize-preview');
      expect(preview.textContent).toBe(ruMessages.export_fontsize_preview.message);
      expect(preview.style.fontSize).toBe(`${fontSize}${format === 'image' ? 'px' : 'pt'}`);
      expect(element('.gv-export-imagewidth-section .gv-export-fontsize-label').textContent).toBe(
        ruMessages.export_image_width_label.message,
      );
      expect(wide.textContent).toBe(ruMessages.export_image_width_wide.message);
      expect(element('.gv-export-format-badge')).toBe(badge);
      expect(badge.textContent).toBe(ruMessages.exportRecommended.message);
      expect(element('.gv-export-format-label', formatOption('image')).textContent).toBe(
        ruMessages.exportImageLabel.message,
      );
      for (const item of ['json', 'markdown', 'pdf', 'image'] as const) {
        expect(element('.gv-export-format-description', formatOption(item)).textContent).toBe(
          ruMessages[`export_format_${item}_description`].message,
        );
      }
      expect(radio.checked).toBe(true);
      expect(element('.gv-export-fontsize-slider')).toBe(slider);
      expect(slider.value).toBe(String(fontSize));
      expect(document.activeElement).toBe(slider);
      expect(wrapper.scrollTop).toBe(37);
      if (format === 'image') expect(wide.classList.contains('active')).toBe(true);
      expect(opts.onExport).not.toHaveBeenCalled();
      expect(opts.onCancel).not.toHaveBeenCalled();

      ready(enMessages);
      expect(title.textContent).toBe(enMessages.export_dialog_title.message);
      expect(slider.value).toBe(String(fontSize));
      expect(radio.checked).toBe(true);
      element('.gv-export-dialog-btn-primary').click();
      expect(opts.onExport).toHaveBeenCalledWith(
        format,
        fontSize,
        format === 'image' ? IMAGE_EXPORT_WIDTH_WIDE : undefined,
      );
      expect(wrapper.isConnected).toBe(false);

      ready(ruMessages);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(title.textContent).toBe(enMessages.export_dialog_title.message);
      expect(opts.onCancel).not.toHaveBeenCalled();
    },
  );

  it('refreshes both Safari hints and preserves the selected format', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Version/17.0 Safari/605.1.15');
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    show();
    const radio = element<HTMLInputElement>('input[name="export-format"][value="pdf"]');
    radio.click();

    ready(ruMessages);

    expect(element('.gv-export-format-description', formatOption('pdf')).textContent).toBe(
      `${ruMessages.export_format_pdf_description.message} ${ruMessages.export_dialog_safari_cmdp_hint.message}`,
    );
    for (const format of ['markdown', 'image'] as const) {
      expect(element('.gv-export-format-description', formatOption(format)).textContent).toBe(
        `${ruMessages[`export_format_${format}_description`].message} ${ruMessages.export_dialog_safari_markdown_hint.message}`,
      );
    }
    expect(radio.checked).toBe(true);
  });
});
