// Who plays in a match: the connected players plus any bots the host added.
// Pure; unit tested in lineup.test.ts.
import type { Gate } from '../types';

/** How many bots fit alongside `humans` players in a room of `seats`. */
export function maxBots(humans: number, seats: number): number {
  return Math.max(0, seats - humans);
}

/**
 * The match's gates, in seat order: the players, plus `bots` bots in the
 * lowest seats nobody holds.  Bots get seats so every gate has a unique one
 * (inputs are addressed by seat), but they hold no seat in the database.
 */
export function lineup(humans: Gate[], bots: number, seats: number): Gate[] {
  if (bots > maxBots(humans.length, seats)) throw new Error(`Only ${maxBots(humans.length, seats)} bots fit in this room.`);
  const taken = new Set(humans.map((gate) => gate.seat));
  const added: Gate[] = [];
  for (let seat = 0; seat < seats && added.length < bots; seat++) {
    if (taken.has(seat)) continue;
    const n = added.length + 1;
    added.push({ seat, playerId: `bot-${n}`, displayName: `Bot ${n}`, bot: true });
  }
  return [...humans, ...added].sort((a, b) => a.seat - b.seat);
}
