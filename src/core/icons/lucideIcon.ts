import type { IconNode } from 'lucide-react';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function toSvgAttributeName(attribute: string): string {
  if (attribute === 'className') return 'class';
  return attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Create Lucide SVGs for the plain-DOM content-script controls. */
export function createLucideIcon(name: string, iconNode: IconNode, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('xmlns', SVG_NAMESPACE);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('lucide', `lucide-${name}`);

  for (const [elementName, attributes] of iconNode) {
    const child = document.createElementNS(SVG_NAMESPACE, elementName);
    for (const [attribute, value] of Object.entries(attributes)) {
      if (attribute === 'key') continue;
      child.setAttribute(toSvgAttributeName(attribute), value);
    }
    svg.appendChild(child);
  }

  return svg;
}
