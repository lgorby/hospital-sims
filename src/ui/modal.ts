/** Shared modal-card DOM builders (audit #9) — the daily report and the
 *  game-over screen must never drift apart visually. */

export function modalSection(parent: HTMLElement, label: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = label;
  parent.appendChild(h);
  const box = document.createElement('div');
  box.className = 'modal-rows';
  parent.appendChild(box);
  return box;
}

export function modalRow(parent: HTMLElement, label: string, value: string, tone = ''): void {
  const row = document.createElement('div');
  row.className = 'modal-row';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.textContent = value;
  if (tone) v.classList.add(tone);
  row.append(l, v);
  parent.appendChild(row);
}
