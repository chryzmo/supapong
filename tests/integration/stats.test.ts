// src/stats/api.ts against the local stack.  Results from other test files
// stay in the database (they outlive their players), so checks look only at
// this file's players and matches.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoom, joinRoom } from '../../src/lobby/api';
import { confirmResult, finishMatch, setRoomStatus } from '../../src/room/api';
import { fetchLeaderboard, fetchRecentMatches, fetchStanding } from '../../src/stats/api';
import { actAs, backdateStart, createPlayer, type TestPlayer } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

let ada: TestPlayer;
let bob: TestPlayer;
let cy: TestPlayer;

/** Plays a match through the real RPCs, hosted by the first player and confirmed by the rest. */
async function play(roomName: string, scores: [TestPlayer, number][], confirm = true): Promise<void> {
  const [host, ...guests] = scores.map(([player]) => player);
  actAs(host!);
  const roomId = await createRoom(roomName, 4);
  for (const guest of guests) {
    actAs(guest);
    await joinRoom(roomId);
  }
  await setRoomStatus(host!.client, roomId, 'playing');
  await backdateStart(roomId); // finish_match refuses a match quicker than its points could take.
  const result = Object.fromEntries(scores.map(([player, points]) => [player.id, points]));
  await finishMatch(host!.client, roomId, result);
  // Everyone confirms, so the leaderboard counts it.
  if (confirm) for (const guest of guests) await confirmResult(guest.client, roomId, result);
}

beforeAll(async () => {
  [ada, bob, cy] = await Promise.all([createPlayer('Ada'), createPlayer('Bob'), createPlayer('Cy')]);
  await play('Opening', [
    [ada, 3],
    [bob, 7],
  ]);
  await play('Rematch', [
    [ada, 6],
    [bob, 2],
    [cy, 2],
  ]);
});

describe('fetchStanding', () => {
  it("returns a player's totals", async () => {
    actAs(cy);
    expect(await fetchStanding(ada.id)).toEqual(
      expect.objectContaining({ displayName: 'Ada', matches: 2, wins: 1, points: 9 }),
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
          ['Ada', 6, 1, true],
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

// Last, so the matches above stay the latest while their tests run.
describe('unconfirmed matches', () => {
  it('show in history, tagged, but not on the leaderboard', async () => {
    const [dee, eve] = await Promise.all([createPlayer('Dee'), createPlayer('Eve')]);
    await play('Unconfirmed', [
      [dee, 5],
      [eve, 1],
    ], false);
    actAs(eve);
    const [match] = await fetchRecentMatches({ playerId: dee.id });
    expect(match).toEqual(expect.objectContaining({ roomName: 'Unconfirmed', ranked: false }));
    expect(await fetchStanding(dee.id)).toBeNull();
  });
});
