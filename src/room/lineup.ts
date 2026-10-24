// Who plays in a match: the connected players plus any bots the host added.
// Pure; unit tested in lineup.test.ts.
import { MAX_PLAYERS, type Gate } from '../types';

/**
 * How many bots fit alongside `humans` players.  Bots hold no seat in the
 * database, so the room's size doesn't limit them, only the board's 8 gates.
 */
export function maxBots(humans: number): number {
  return Math.max(0, MAX_PLAYERS - humans);
}

/**
 * The match's gates, in seat order: the players, plus `bots` bots in the
 * lowest seats nobody holds.  Bots get seats so every gate has a unique one
 * (inputs are addressed by seat), but they hold no seat in the database.
 */
export function lineup(humans: Gate[], bots: number): Gate[] {
  const most = maxBots(humans.length);
  if (bots > most) throw new Error(`Only ${most} bots fit: a match has at most ${MAX_PLAYERS} gates.`);
  const taken = new Set(humans.map((gate) => gate.seat));
  const added: Gate[] = [];
  for (let seat = 0; seat < MAX_PLAYERS && added.length < bots; seat++) {
    if (taken.has(seat)) continue;
    const n = added.length + 1;
    added.push({ seat, playerId: `bot-${n}`, displayName: `Bot ${n}`, bot: true });
  }
  return [...humans, ...added].sort((a, b) => a.seat - b.seat);
}
