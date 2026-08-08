/**
 * Shared folder glyph.
 *
 * The folder UI was forked from Gemini Voyager, where icons were Material
 * ligatures (`<mat-icon class="google-symbols">folder</mat-icon>`) rendered by
 * a font the Gemini page provides. ChatGPT ships no such font, so any leftover
 * ligature renders as the literal word "folder" — which is exactly what issue
 * #7 reported in the "move to folder" dialog. Everything that needs a folder
 * glyph on ChatGPT must therefore draw a real SVG instead.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Stroked folder outline, sized in px and inheriting `currentColor`. */
export function createFolderSvgIcon(size: number = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute(
    'd',
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  );
  svg.appendChild(path);
  return svg;
}
