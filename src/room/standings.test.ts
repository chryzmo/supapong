import { describe, expect, it } from 'vitest';
import { headline, scoresByPlayer, standings, type MatchResult } from './standings';

const gates = ['Ada', 'Bob', 'Cy', 'Di'].map((displayName, seat) => ({ seat, playerId: displayName.toLowerCase(), displayName }));

function result(scores: number[], active = scores.map(() => true)): MatchResult {
  return { gates: gates.slice(0, scores.length), scores, active };
}

describe('standings', () => {
  it('sorts by score, highest first', () => {
    expect(standings(result([2, 9, 5])).map((s) => [s.place, s.displayName, s.score])).toEqual([
      [1, 'Bob', 9],
      [2, 'Cy', 5],
      [3, 'Ada', 2],
    ]);
  });

  it('shares places on ties and skips the next place', () => {
    expect(standings(result([4, 7, 7, 1])).map((s) => [s.place, s.displayName])).toEqual([
      [1, 'Bob'],
      [1, 'Cy'],
      [3, 'Ada'],
      [4, 'Di'],
    ]);
  });

  it('marks players who left', () => {
    expect(standings(result([3, 1], [true, false])).find((s) => s.displayName === 'Bob')?.left).toBe(true);
  });
});

describe('headline', () => {
  it('names a single winner', () => {
    expect(headline(standings(result([2, 9, 5])))).toBe('Bob wins!');
  });

  it('names tied winners', () => {
    expect(headline(standings(result([7, 7, 1])))).toBe('Ada and Bob tie for first');
    expect(headline(standings(result([7, 7, 7, 1])))).toBe('Ada, Bob and Cy tie for first');
  });

  it('calls an all-way tie a tie', () => {
    expect(headline(standings(result([0, 0, 0])))).toBe("It's a tie!");
  });
});

describe('scoresByPlayer', () => {
  it('keys points by player id, including players who left', () => {
    expect(scoresByPlayer(result([3, 1], [true, false]))).toEqual({ ada: 3, bob: 1 });
  });

  it('leaves bots out', () => {
    const withBot: MatchResult = { gates: [gates[0]!, { ...gates[1]!, bot: true }, gates[2]!], scores: [3, 5, 1], active: [true, true, true] };
    expect(scoresByPlayer(withBot)).toEqual({ ada: 3, cy: 1 });
    expect(standings(withBot).map((s) => [s.displayName, s.bot])).toEqual([
      ['Bob', true],
      ['Ada', false],
      ['Cy', false],
    ]);
  });
});
