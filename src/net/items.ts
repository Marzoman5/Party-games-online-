/**
 * FROZEN CONTRACT — player-facing item names (original, no third-party IP).
 * Internal ids (ItemType in src/core/types.ts) are kept from the base game for
 * code compatibility; anything a human READS must use these labels.
 * No imports so the phone bundle stays three.js-free.
 */
export interface ItemInfo {
  /** Short ALL-CAPS label for HUD / phone button. */
  label: string;
  /** Single emoji fallback icon. */
  emoji: string;
  /** Main colour (CSS). */
  color: string;
  /** One-line hint used by tips / tutorial. */
  hint: string;
}

export const ITEM_INFO: Record<string, ItemInfo> = {
  none: { label: '', emoji: '', color: '#333344', hint: '' },
  banana: { label: 'BANANA', emoji: '🍌', color: '#ffd23f', hint: 'Drop it behind you' },
  triple_banana: { label: 'BANANA ×3', emoji: '🍌', color: '#ffd23f', hint: 'Three peels to drop' },
  green_shell: { label: 'BOUNCER', emoji: '🟢', color: '#3ddc5a', hint: 'Fires straight and bounces off walls' },
  triple_green_shell: { label: 'BOUNCER ×3', emoji: '🟢', color: '#3ddc5a', hint: 'Three bouncers orbit you' },
  red_shell: { label: 'SEEKER', emoji: '🔴', color: '#ff4040', hint: 'Homes in on the kart ahead' },
  triple_red_shell: { label: 'SEEKER ×3', emoji: '🔴', color: '#ff4040', hint: 'Three homing seekers' },
  blue_shell: { label: 'LEADER ZAP', emoji: '🔵', color: '#3f7fff', hint: 'Flies to 1st place and explodes' },
  mushroom: { label: 'TURBO', emoji: '🚀', color: '#ff5a3a', hint: 'Instant speed boost' },
  triple_mushroom: { label: 'TURBO ×3', emoji: '🚀', color: '#ff5a3a', hint: 'Three boosts' },
  golden_mushroom: { label: 'GOLD TURBO', emoji: '✨', color: '#ffc800', hint: 'Spam boosts for a few seconds' },
  star: { label: 'SUPERNOVA', emoji: '⭐', color: '#ffe14a', hint: 'Invincible and faster' },
  lightning: { label: 'THUNDER', emoji: '⚡', color: '#ffef70', hint: 'Shrinks everyone else' },
  bob_omb: { label: 'BOOMER', emoji: '💣', color: '#555566', hint: 'Throw it — big explosion' },
};

export function itemInfo(id: string): ItemInfo {
  return ITEM_INFO[id] ?? ITEM_INFO.none;
}
