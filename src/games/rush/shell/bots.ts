/**
 * SHELL — host-side solo bots. With exactly one present human the round is filled up to
 * `LOOP.soloTotal` participants with bots (🤖 badge), driven by the minigame's pure bot brain
 * (`BOTS[id]`) exactly like headless.ts does: the bot sees the RushPhoneMsg a phone would get,
 * `cueAgeMs` and the minigame's `botHint(id)`. Bots never appear on the all-time scoreboard.
 */
import { SLOT_COLORS } from '../../../net/protocol';
import { BOTS } from '../bots';
import { seededRandom } from '../draw';
import type { RushPlayer } from '../types';
import type { BotRec } from './state';

const BOT_LOOKS = [
  { name: 'Bot Bolt', emoji: '🤖' },
  { name: 'Bot Bleep', emoji: '👾' },
  { name: 'Bot Boop', emoji: '🛸' },
  { name: 'Bot Byte', emoji: '🦾' },
  { name: 'Bot Blink', emoji: '📟' },
  { name: 'Bot Buzz', emoji: '🔋' },
];

export function isBotId(id: string): boolean {
  return id.startsWith('bot:');
}

/** Create `count` bots for a round, using colours the human participants don't use. */
export function makeBots(gameId: string, count: number, usedColors: ReadonlySet<string>, seed: number): Map<string, BotRec> {
  const out = new Map<string, BotRec>();
  const free = [...SLOT_COLORS].reverse().filter((c) => !usedColors.has(c));
  const factory = BOTS[gameId];
  for (let i = 0; i < count; i++) {
    const look = BOT_LOOKS[i % BOT_LOOKS.length];
    const id = `bot:${i + 1}`;
    const p: RushPlayer = { id, name: look.name, emoji: look.emoji, color: free[i % Math.max(1, free.length)] ?? '#a8b8e0', bot: true, touch: false };
    const rand = seededRandom(seed + i * 7919);
    let bot = null;
    try {
      bot = factory ? factory(rand, 0.35 + 0.4 * rand()) : null;
    } catch (err) {
      console.warn('[rush] bot factory failed', err);
      bot = null;
    }
    out.set(id, { p, bot, acc: 0 });
  }
  return out;
}
