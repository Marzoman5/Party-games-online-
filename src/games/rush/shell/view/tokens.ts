/**
 * SHELL — DOM version of `drawToken`: a coloured disc with a white rim and the emoji on it (+ 👆 for touch
 * players, 🤖 for host bots). The name is always shown next to it, in the player's colour.
 */
import { h } from '../../../../party/ui/dom';

export function disc(p: { emoji: string; color: string; touch?: boolean; bot?: boolean }, size: number): HTMLDivElement {
  const d = h('div', 'rush-disc');
  d.style.setProperty('--c', p.color);
  d.style.setProperty('--d', String(size));
  d.appendChild(h('span', { class: 'rush-disc-emoji', text: p.emoji }));
  if (p.touch) d.appendChild(h('span', { class: 'rush-disc-badge', text: '👆' }));
  else if (p.bot) d.appendChild(h('span', { class: 'rush-disc-badge', text: '🤖' }));
  return d;
}
