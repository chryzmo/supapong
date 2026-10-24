import { describe, expect, it } from 'vitest';
import { lineup, maxBots } from './lineup';

const ada = { seat: 0, playerId: 'a', displayName: 'Ada' };
const bob = { seat: 2, playerId: 'b', displayName: 'Bob' };

describe('lineup', () => {
  it('is just the players with no bots', () => {
    expect(lineup([bob, ada], 0)).toEqual([ada, bob]);
  });

  it('puts bots in the lowest free seats, in seat order', () => {
    expect(lineup([ada, bob], 2)).toEqual([
      ada,
      { seat: 1, playerId: 'bot-1', displayName: 'Bot 1', bot: true },
      bob,
      { seat: 3, playerId: 'bot-2', displayName: 'Bot 2', bot: true },
    ]);
  });

  it('fills up to 8 gates', () => {
    const gates = lineup([ada, bob], 6);
    expect(gates.map((g) => g.seat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gates.filter((g) => g.bot)).toHaveLength(6);
  });

  it('refuses more than 8 gates', () => {
    expect(() => lineup([ada, bob], 7)).toThrow('Only 6 bots fit: a match has at most 8 gates.');
  });
});

describe('maxBots', () => {
  it('fills the room and never goes negative', () => {
    expect(maxBots(2)).toBe(6);
    expect(maxBots(8)).toBe(0);
    expect(maxBots(9)).toBe(0);
  });
});
