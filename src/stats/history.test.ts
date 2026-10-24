import { describe, expect, it } from 'vitest';
import { groupMatches, ordinal, timeAgo, toLeaderboardEntry, UNKNOWN_PLAYER, type MatchPlayerRow } from './history';

function row(result: string, player: string, score: number, place: number, won = place === 1): MatchPlayerRow {
  return {
    result_id: result,
    finished_at: '2026-10-23T12:00:00Z',
    room_name: `Room ${result}`,
    player_id: player,
    display_name: player.toUpperCase(),
    score,
    place,
    won,
    player_count: 2,
  };
}

describe('groupMatches', () => {
  it('groups rows into matches in the order given', () => {
    const matches = groupMatches(['m2', 'm1'], [row('m1', 'a', 3, 1), row('m2', 'b', 1, 1), row('m1', 'b', 0, 2)]);
    expect(matches.map((m) => [m.id, m.roomName, m.players.map((p) => p.playerId)])).toEqual([
      ['m2', 'Room m2', ['b']],
      ['m1', 'Room m1', ['a', 'b']],
    ]);
  });

  it('sorts players by place, then name', () => {
    const [match] = groupMatches(['m'], [row('m', 'c', 1, 3), row('m', 'b', 5, 1), row('m', 'a', 5, 1)]);
    expect(match?.players.map((p) => [p.place, p.displayName])).toEqual([
      [1, 'A'],
      [1, 'B'],
      [3, 'C'],
    ]);
  });

  it('skips ids with no rows and rows with no player', () => {
    expect(groupMatches(['gone', 'm'], [row('m', 'a', 1, 1), { ...row('m', 'b', 0, 2), player_id: null }])).toEqual([
      expect.objectContaining({ id: 'm', players: [expect.objectContaining({ playerId: 'a' })] }),
    ]);
  });

  it('names players without a name', () => {
    const [match] = groupMatches(['m'], [{ ...row('m', 'a', 1, 1), display_name: null }]);
    expect(match?.players[0]?.displayName).toBe(UNKNOWN_PLAYER);
  });
});

describe('toLeaderboardEntry', () => {
  it('maps a row', () => {
    expect(
      toLeaderboardEntry({ player_id: 'a', display_name: 'Ada', rank: 1, matches: 3, wins: 2, points: 15 }),
    ).toEqual({ playerId: 'a', displayName: 'Ada', rank: 1, matches: 3, wins: 2, points: 15 });
  });

  it('drops a row with no player', () => {
    expect(toLeaderboardEntry({ player_id: null, display_name: null, rank: null, matches: null, wins: null, points: null })).toBeNull();
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [102, '102nd'],
  ])('%i -> %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const ago = (seconds: number): string => timeAgo(new Date(now.getTime() - seconds * 1000), now);

  it('formats recent times relative to now', () => {
    expect(ago(30)).toBe('just now');
    expect(ago(5 * 60)).toBe('5 minutes ago');
    expect(ago(3 * 3600)).toBe('3 hours ago');
    expect(ago(30 * 3600)).toBe('yesterday');
  });

  it('shows a date after a week', () => {
    expect(ago(10 * 86400)).toBe('Oct 13, 2026');
  });
});
