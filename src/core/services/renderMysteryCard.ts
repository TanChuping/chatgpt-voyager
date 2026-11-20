import type { AppLanguage } from '@/utils/language';

import { type Leaf, type MysteryCard, type Tab, cardText } from './mysteryCard';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, css: string) {
  const el = document.createElement(tag);
  el.style.cssText = css;
  return el;
}
function ink(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const v = parseInt(hex.slice(start, start + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722 > 0.179 ? '#111111' : '#ffffff';
}
function renderLeaf(block: Leaf, lang: AppLanguage, accent: string): HTMLElement {
  if (block.type === 'progress') {
    const wrap = element(
      'div',
      'display:grid;gap:5px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums',
    );
    const labels = element(
      'div',
      'display:flex;align-items:baseline;justify-content:space-between;gap:8px',
    );
    const format = new Intl.NumberFormat(lang);
    const caption = `${format.format(block.value)} / ${format.format(block.max)} ${block.unit}`;
    labels.append(caption);
    const percent = element('span', 'opacity:.75');
    percent.textContent = new Intl.NumberFormat(lang, {
      style: 'percent',
      maximumFractionDigits: 0,
    }).format(Math.min(1, block.value / block.max));
    labels.append(percent);
    const track = element(
      'div',
      'height:6px;overflow:hidden;border-radius:9px;background:color-mix(in srgb,currentColor 13%,transparent)',
    );
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', caption);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(block.max));
    track.setAttribute('aria-valuenow', String(Math.min(block.max, block.value)));
    const fill = element('div', 'height:100%;border-radius:inherit');
    fill.style.width = Math.min(100, (100 * block.value) / block.max) + '%';
    fill.style.backgroundColor = accent;
    track.append(fill);
    wrap.append(labels, track);
    return wrap;
  }
  const text = cardText(block.text, lang);
  if (block.type === 'image') {
    const img = element(
      'img',
      'display:block;margin:auto;width:100%;max-height:200px;object-fit:contain;border-radius:8px',
    );
    if (block.fit === 'cover') {
      img.style.aspectRatio = '4 / 3';
      img.style.objectFit = 'cover';
    }
    if (block.fit === 'square') {
      img.style.aspectRatio = '1';
      img.style.maxWidth = '130px';
      img.style.backgroundColor = 'white';
    }
    img.alt = text;
    img.src = block.url;
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  if (block.type === 'link') {
    const link = element(
      'a',
      'display:block;padding:8px 12px;text-align:center;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600',
    );
    const tint = block.color ?? accent;
    link.style.backgroundColor = tint;
    link.style.color = ink(tint);
    link.href = block.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = text;
    return link;
  }
  const el = element(
    block.type === 'heading' ? 'strong' : 'p',
    'display:block;margin:0;white-space:pre-line',
  );
  el.textContent = text;
  if (block.type === 'heading') {
    el.style.fontSize = '17px';
    el.style.lineHeight = '1.28';
    el.style.fontWeight = '650';
  } else if (block.type === 'caption') {
    el.style.fontSize = '11.5px';
    el.style.opacity = '.78';
  }
  return el;
}
function tabs(
  items: Tab[],
  side: boolean,
  lang: AppLanguage,
  accent: string,
  key: string,
  selection: Map<string, number>,
) {
  const wrap = element('div', 'display:grid;align-items:center;gap:10px');
  if (side) wrap.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1fr)';
  const bar = element('div', 'display:flex;flex-wrap:wrap;gap:5px;align-items:stretch');
  if (side) bar.style.flexDirection = 'column';
  const body = element('div', 'display:grid;gap:6px;min-width:0');
  const buttons = items.map((tab, index) => {
    const b = element(
      'button',
      'font:inherit;font-size:12.5px;font-weight:600;min-height:32px;padding:5px 9px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:8px;cursor:pointer;flex:1',
    );
    b.type = 'button';
    b.textContent = cardText(tab.label, lang);
    b.addEventListener('click', () => select(index));
    bar.append(b);
    return b;
  });
  function select(index: number) {
    selection.set(key, index);
    buttons.forEach((b, i) => {
      const active = i === index,
        tint = items[i].color ?? accent;
      b.setAttribute('aria-pressed', String(active));
      b.style.backgroundColor = active ? tint : 'transparent';
      b.style.color = active ? ink(tint) : 'inherit';
    });
    body.replaceChildren(...items[index].blocks.map((x) => renderLeaf(x, lang, accent)));
    wrap.dispatchEvent(new Event('gv-card-resize', { bubbles: true }));
  }
  wrap.append(bar, body);
  select(Math.min(selection.get(key) ?? 0, items.length - 1));
  return wrap;
}
/** All actions and styles originate here. The remote feed supplies bounded content and presentation values. */
export function renderMysteryCard(
  card: MysteryCard,
  lang: AppLanguage,
  selection = new Map<string, number>(),
): HTMLElement {
  const root = element(
    'div',
    'display:grid;min-width:0;overflow-wrap:anywhere;font-size:13px;line-height:1.5',
  );
  root.className = 'gv-mystery-card';
  root.style.textAlign = card.align;
  root.style.gap = { compact: '6px', normal: '12px', wide: '18px' }[card.gap];
  if (card.colors.background) {
    root.style.backgroundColor = card.colors.background;
    root.style.padding = '12px';
    root.style.borderRadius = '10px';
    root.style.color = card.colors.text ?? ink(card.colors.background);
  } else if (card.colors.text) root.style.color = card.colors.text;
  const accent = card.colors.accent ?? '#7052C9';
  card.rows.forEach((row, i) => {
    const line = element('div', 'display:grid;min-width:0;align-items:center');
    line.style.gridTemplateColumns = row.weights.map((w) => `minmax(0,${w}fr)`).join(' ');
    line.style.gap = root.style.gap;
    row.columns.forEach((col, j) => {
      const stack = element('div', 'display:grid;gap:5px;min-width:0');
      col.forEach((b, k) =>
        stack.append(
          b.type === 'tabs'
            ? tabs(b.items, b.side, lang, accent, `${i}/${j}/${k}`, selection)
            : renderLeaf(b, lang, accent),
        ),
      );
      line.append(stack);
    });
    root.append(line);
  });
  return root;
}
