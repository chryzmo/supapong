// src/stats/api.ts against the local stack.  Results from other test files
// stay in the database (they outlive their players), so checks look only at
// this file's players and matches.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoom, joinRoom } from '../../src/lobby/api';
import { finishMatch, setRoomStatus } from '../../src/room/api';
import { fetchLeaderboard, fetchRecentMatches, fetchStanding } from '../../src/stats/api';
import { actAs, createPlayer, type TestPlayer } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

let ada: TestPlayer;
let bob: TestPlayer;
let cy: TestPlayer;

/** Plays a match through the real RPCs, hosted by the first player. */
async function play(roomName: string, scores: [TestPlayer, number][]): Promise<void> {
  const [host, ...guests] = scores.map(([player]) => player);
  actAs(host!);
  const roomId = await createRoom(roomName, 4);
  for (const guest of guests) {
    actAs(guest);
    await joinRoom(roomId);
  }
  await setRoomStatus(host!.client, roomId, 'playing');
  await finishMatch(host!.client, roomId, Object.fromEntries(scores.map(([player, points]) => [player.id, points])));
}

beforeAll(async () => {
  [ada, bob, cy] = await Promise.all([createPlayer('Ada'), createPlayer('Bob'), createPlayer('Cy')]);
  await play('Opening', [
    [ada, 3],
    [bob, 7],
  ]);
  await play('Rematch', [
    [ada, 10],
    [bob, 2],
    [cy, 2],
  ]);
});

describe('fetchStanding', () => {
  it("returns a player's totals", async () => {
    actAs(cy);
    expect(await fetchStanding(ada.id)).toEqual(
      expect.objectContaining({ displayName: 'Ada', matches: 2, wins: 1, points: 13 }),
    );
  });

  it("returns null for a player who hasn't finished a match", async () => {
    const newcomer = await createPlayer('New');
    actAs(newcomer);
    expect(await fetchStanding(newcomer.id)).toBeNull();
  });
});

describe('fetchLeaderboard', () => {
  it('orders players by rank', async () => {
    actAs(bob);
    const ranks = (await fetchLeaderboard(1000)).map((entry) => entry.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('respects the limit', async () => {
    actAs(bob);
    expect(await fetchLeaderboard(1)).toHaveLength(1);
  });
});

describe('fetchRecentMatches', () => {
  it("lists a player's matches newest first, with everyone in them by place", async () => {
    actAs(cy);
    const matches = await fetchRecentMatches({ playerId: bob.id });
    expect(
      matches.map((m) => [m.roomName, m.players.map((p) => [p.displayName, p.score, p.place, p.won])]),
    ).toEqual([
      [
        'Rematch',
        [
          ['Ada', 10, 1, true],
          ['Bob', 2, 2, false],
          ['Cy', 2, 2, false],
        ],
      ],
      [
        'Opening',
        [
          ['Bob', 7, 1, true],
          ['Ada', 3, 2, false],
        ],
      ],
    ]);
  });

  it('includes the latest matches for everyone', async () => {
    actAs(ada);
    const matches = await fetchRecentMatches({ limit: 2 });
    expect(matches.map((m) => m.roomName)).toEqual(['Rematch', 'Opening']);
  });
});
