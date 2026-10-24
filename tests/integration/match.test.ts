// Networked play over the local stack: a HostGame and ClientGames wired to
// real RoomSessions, as the match screen wires them.
import { afterEach, expect, it, vi } from 'vitest';
import { ClientGame } from '../../src/game/client';
import { HostGame } from '../../src/game/host';
import type { Ticker } from '../../src/game/loop';
import { DEFAULT_CONFIG, gateCenter, paddleTravel, wrapAngle, type PhysicsConfig } from '../../src/game/physics';
import { RoomSession } from '../../src/room/session';
import { scoresByPlayer } from '../../src/room/standings';
import type { Gate, RoomEvent, SeatedRoom } from '../../src/types';
import { createPlayer, delay, waitFor, type TestPlayer } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

const GRACE_MS = 600;
const intervalTicker: Ticker = (onTick) => {
  const timer = setInterval(onTick, 8);
  return () => clearInterval(timer);
};

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

interface Guest {
  player: TestPlayer;
  session: RoomSession;
  client: ClientGame;
  events: RoomEvent[];
  snapshots: number;
}

// A fixed seed makes each match deterministic: with nobody pressing keys, the
// ball does the same thing every run.  Random seeds made the goal tests
// flaky: a ball launched along a diameter can bounce between idle paddles
// for a long time without a goal.
const SEED = 1;

async function startMatch(guestCount: number, config: PhysicsConfig = DEFAULT_CONFIG) {
  const hostGoals: number[] = [];
  const players = await Promise.all([createPlayer('Host'), ...Array.from({ length: guestCount }, (_, i) => createPlayer(`G${i + 1}`))]);
  const [hostPlayer, ...guestPlayers] = players as [TestPlayer, ...TestPlayer[]];
  const { data: roomId, error } = await hostPlayer.client.rpc('create_room', { p_name: 'Match test', p_max_players: 4 });
  if (error) throw error;
  const base: SeatedRoom = { id: roomId, name: 'Match test', hostId: hostPlayer.id, maxPlayers: 4, seat: 0 };

  const open = (player: TestPlayer, seat: number) => {
    const session = new RoomSession({ ...base, seat }, { id: player.id, displayName: player.name }, {
      client: player.client,
      graceMs: GRACE_MS,
      checkIntervalMs: 100,
    });
    cleanup.push(() => session.close());
    return session;
  };

  const hostSession = open(hostPlayer, 0);
  await hostSession.whenReady();
  const guestSessions: RoomSession[] = [];
  for (const player of guestPlayers) {
    const { data: seat, error: joinError } = await player.client.rpc('join_room', { p_room_id: roomId });
    if (joinError) throw joinError;
    const session = open(player, seat);
    await session.whenReady();
    guestSessions.push(session);
  }
  await waitFor(() => hostSession.getRoster().length === players.length, 'everyone connected');

  // Guests listen before the host starts, as their waiting rooms would.
  let gates: Gate[] = [];
  const started = guestSessions.map(
    (session) => new Promise<Gate[]>((resolve) => session.listen({ event: (e) => e.type === 'start' && resolve(e.gates) })),
  );
  gates = await hostSession.startMatch();
  await Promise.all(started);

  const goneIds: string[] = [];
  const host = new HostGame(hostSession, gates, 0, { config, seed: SEED, ticker: intervalTicker, onGoal: (g) => hostGoals.push(g) });
  hostSession.listen({
    input: (m) => host.applyInput(m.seat, m.dir),
    playerGone: (id) => {
      goneIds.push(id);
      host.removePlayer(id);
    },
  });

  const guests: Guest[] = guestSessions.map((session, i) => {
    const myGate = gates.findIndex((g) => g.playerId === guestPlayers[i]!.id);
    const guest: Guest = {
      player: guestPlayers[i]!,
      session,
      client: new ClientGame(gates, myGate, (dir) => session.sendInput({ seat: session.room.seat, dir }), { config }),
      events: [],
      snapshots: 0,
    };
    session.listen({
      state: (m) => {
        guest.snapshots++;
        guest.client.onState(m);
      },
      event: (e) => guest.events.push(e),
    });
    return guest;
  });

  host.start();
  cleanup.push(() => host.stop());
  return { host, hostSession, guests, gates, goneIds, hostGoals, roomId };
}

it('streams snapshots to every guest at about 20 Hz', async () => {
  const { guests } = await startMatch(2);
  await delay(300); // Let the stream settle.
  const before = guests.map((g) => g.snapshots);
  await delay(2000);
  for (const [i, guest] of guests.entries()) {
    const perSecond = (guest.snapshots - before[i]!) / 2;
    expect(perSecond).toBeGreaterThan(15);
    expect(perSecond).toBeLessThan(25);
    expect(guest.client.hasState()).toBe(true);
  }
});

it("moves a guest's paddle on the host when the guest presses a key", async () => {
  const { host, guests, gates } = await startMatch(1);
  const guest = guests[0]!;
  const gate = gates.findIndex((g) => g.playerId === guest.player.id);
  const n = gates.length;
  const limit = wrapAngle(gateCenter(gate, n) + paddleTravel(n, DEFAULT_CONFIG));

  guest.client.setOwnInput(1);
  await vi.waitFor(() => expect(host.view().gates[gate]!.paddle).toBeCloseTo(limit, 3), { timeout: 3000 });
  // ...and the guest sees the host's version in its snapshots too.
  await vi.waitFor(() => expect(guest.client.view().gates[gate]!.paddle).toBeCloseTo(limit, 3));
});

it("turns a disconnected guest's gate into wall", async () => {
  const { guests, gates, goneIds } = await startMatch(2);
  const leaver = guests[1]!;
  const stayer = guests[0]!;
  const gate = gates.findIndex((g) => g.playerId === leaver.player.id);
  await leaver.session.close();

  await waitFor(() => goneIds.includes(leaver.player.id), 'the host to notice', 5000);
  await vi.waitFor(() => expect(stayer.client.view().gates[gate]!.active).toBe(false), { timeout: 3000 });
});

it('announces every goal and the final score', async () => {
  // Tiny paddles and a 12-second match (3 s of it countdown): goals come
  // fast and the clock runs out.
  const config = { ...DEFAULT_CONFIG, paddleFraction: 0.01, matchDuration: 12, scoreCap: 99 };
  const { host, guests, hostGoals } = await startMatch(2, config);
  await waitFor(() => host.isOver(), 'the match to end', 20_000);
  expect(hostGoals.length).toBeGreaterThan(0);
  for (const guest of guests) {
    await waitFor(() => guest.events.some((e) => e.type === 'end'), 'the end event');
    const goals = guest.events.flatMap((e) => (e.type === 'goal' ? [e.gate] : []));
    expect(goals).toEqual(hostGoals);
    const end = guest.events.find((e) => e.type === 'end');
    expect(end?.type === 'end' && end.scores).toEqual(host.view().scores);
  }
});

it('records the result once, finishes the room, and lets guests read it', async () => {
  const config = { ...DEFAULT_CONFIG, paddleFraction: 0.01, matchDuration: 5, scoreCap: 99 };
  const { host, hostSession, guests, gates, roomId } = await startMatch(2, config);
  await waitFor(() => host.isOver(), 'the match to end', 12_000);

  const state = host.view();
  const scores = scoresByPlayer({ gates, scores: state.scores, active: state.gates.map((g) => g.active) });
  // The match screen and the results screen both ask; only one row is written.
  await Promise.all([hostSession.finishMatch(scores), hostSession.finishMatch(scores)]);

  const guest = guests[0]!.player.client;
  const { data: results } = await guest.from('match_results').select('scores').eq('room_id', roomId);
  expect(results).toEqual([{ scores }]);
  const { data: room } = await guest.from('rooms').select('status').eq('id', roomId).single();
  expect(room?.status).toBe('finished');
});
