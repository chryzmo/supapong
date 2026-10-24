import { describe, expect, it } from 'vitest';
import { lineup, maxBots } from './lineup';

const ada = { seat: 0, playerId: 'a', displayName: 'Ada' };
const bob = { seat: 2, playerId: 'b', displayName: 'Bob' };

describe('lineup', () => {
  it('is just the players with no bots', () => {
    expect(lineup([bob, ada], 0, 4)).toEqual([ada, bob]);
  });

  it('puts bots in the lowest free seats, in seat order', () => {
    expect(lineup([ada, bob], 2, 4)).toEqual([
      ada,
      { seat: 1, playerId: 'bot-1', displayName: 'Bot 1', bot: true },
      bob,
      { seat: 3, playerId: 'bot-2', displayName: 'Bot 2', bot: true },
    ]);
  });

  it('refuses more bots than the room has seats for', () => {
    expect(() => lineup([ada, bob], 3, 4)).toThrow('Only 2 bots fit in this room.');
  });
});

describe('maxBots', () => {
  it('fills the room and never goes negative', () => {
    expect(maxBots(2, 8)).toBe(6);
    expect(maxBots(4, 4)).toBe(0);
    expect(maxBots(5, 4)).toBe(0);
  });
});
