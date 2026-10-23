// RoomSession against the local stack: Presence roster, host seat cleanup,
// room events, starting and leaving.  Each player gets their own client, as
// they would in their own browser tab.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type SessionListener } from '../../src/room/session';
import type { RoomEvent, RosterEntry, SeatedRoom } from '../../src/types';
import { admin, createPlayer, delay, waitFor, type TestPlayer } from './helpers';

// RoomSession imports the app client module; the tests always pass a client explicitly.
vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

const GRACE_MS = 600;
const sessions: RoomSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

/** A session plus everything its listener has heard. */
interface Seat {
  player: TestPlayer;
  session: RoomSession;
  roster: RosterEntry[];
  events: RoomEvent[];
  hostGone: boolean;
  seatLost: boolean;
}

async function openSeat(player: TestPlayer, room: SeatedRoom): Promise<Seat> {
  const session = new RoomSession(room, { id: player.id, displayName: player.name }, {
    client: player.client,
    graceMs: GRACE_MS,
    checkIntervalMs: 100,
  });
  sessions.push(session);
  const seat: Seat = { player, session, roster: [], events: [], hostGone: false, seatLost: false };
  const listener: SessionListener = {
    roster: (roster) => (seat.roster = roster),
    event: (event) => seat.events.push(event),
    hostGone: () => (seat.hostGone = true),
    seatLost: () => (seat.seatLost = true),
  };
  session.listen(listener);
  await session.whenReady();
  return seat;
}

async function createRoom(host: TestPlayer, maxPlayers = 4): Promise<SeatedRoom> {
  const { data, error } = await host.client.rpc('create_room', { p_name: 'Session test', p_max_players: maxPlayers });
  if (error) throw error;
  return { id: data, name: 'Session test', hostId: host.id, maxPlayers, seat: 0 };
}

async function join(player: TestPlayer, room: SeatedRoom): Promise<SeatedRoom> {
  const { data, error } = await player.client.rpc('join_room', { p_room_id: room.id });
  if (error) throw error;
  return { ...room, seat: data };
}

async function seatIds(roomId: string): Promise<string[]> {
  const { data } = await admin.from('room_players').select('player_id').eq('room_id', roomId).order('seat');
  return (data ?? []).map((row) => row.player_id);
}

async function roomStatus(roomId: string): Promise<string | undefined> {
  const { data } = await admin.from('rooms').select('status').eq('id', roomId).maybeSingle();
  return data?.status;
}

const ids = (roster: RosterEntry[]) => roster.map((entry) => entry.playerId);

/** Host plus `guests` connected guests, all in one room. */
async function setup(guests: number) {
  const players = await Promise.all([createPlayer('Host'), ...Array.from({ length: guests }, (_, i) => createPlayer(`Guest ${i + 1}`))]);
  const [hostPlayer, ...guestPlayers] = players as [TestPlayer, ...TestPlayer[]];
  const room = await createRoom(hostPlayer);
  const host = await openSeat(hostPlayer, room);
  const seated: Seat[] = [];
  for (const guest of guestPlayers) seated.push(await openSeat(guest, await join(guest, room)));
  const everyone = [hostPlayer.id, ...guestPlayers.map((g) => g.id)];
  for (const seat of [host, ...seated]) await waitFor(() => ids(seat.roster).length === everyone.length, 'everyone in the roster');
  return { room, host, guests: seated };
}

describe('roster', () => {
  it('shows every connected player, by seat, to everyone', async () => {
    const { host, guests } = await setup(2);
    const expected = [
      { playerId: host.player.id, displayName: 'Host', seat: 0 },
      { playerId: guests[0]!.player.id, displayName: 'Guest 1', seat: 1 },
      { playerId: guests[1]!.player.id, displayName: 'Guest 2', seat: 2 },
    ];
    expect(host.roster).toEqual(expected);
    expect(guests[0]!.roster).toEqual(expected);
    expect(guests[1]!.roster).toEqual(expected);
  });

  it('drops a player who disconnects', async () => {
    const { host, guests } = await setup(1);
    await guests[0]!.session.close();
    await waitFor(() => ids(host.roster).length === 1, 'the guest to leave the roster');
    expect(ids(host.roster)).toEqual([host.player.id]);
  });
});

describe('host seat cleanup', () => {
  it('removes a disconnected player after the grace period', async () => {
    const { room, host, guests } = await setup(1);
    const guestId = guests[0]!.player.id;
    await guests[0]!.session.close();

    await delay(GRACE_MS / 3);
    expect(await seatIds(room.id)).toContain(guestId);

    await waitFor(() => !host.roster.some((e) => e.playerId === guestId), 'roster update');
    await vi.waitFor(async () => expect(await seatIds(room.id)).toEqual([host.player.id]), { timeout: 5000 });
  });

  it('keeps the seat of a player who reconnects within the grace period (a reload)', async () => {
    const { room, host, guests } = await setup(1);
    const guest = guests[0]!;
    await guest.session.close();
    const back = await openSeat(guest.player, { ...room, seat: 1 });
    await waitFor(() => ids(back.roster).length === 2, 'the guest to rejoin');

    await delay(GRACE_MS * 3);
    expect(await seatIds(room.id)).toEqual([host.player.id, guest.player.id]);
    expect(back.seatLost).toBe(false);
  });

  it('removes a seat whose player never connects', async () => {
    const [hostPlayer, ghost] = await Promise.all([createPlayer('Host'), createPlayer('Ghost')]);
    const room = await createRoom(hostPlayer);
    await openSeat(hostPlayer, room);
    await join(ghost, room);
    expect(await seatIds(room.id)).toContain(ghost.id);

    await vi.waitFor(async () => expect(await seatIds(room.id)).toEqual([hostPlayer.id]), { timeout: 5000 });
  });

  it('tells a removed player they lost their seat', async () => {
    const { host, guests } = await setup(2);
    await host.session.send({ type: 'removed', playerId: guests[0]!.player.id });
    await waitFor(() => guests[0]!.seatLost, 'seatLost');
    await delay(200);
    expect(guests[1]!.seatLost).toBe(false);
    expect(guests[0]!.events).toEqual([]);
  });

  it('notices a lost seat after the socket reconnects', async () => {
    const { room, guests } = await setup(1);
    const guest = guests[0]!;
    guest.player.client.realtime.disconnect();
    await admin.from('room_players').delete().eq('room_id', room.id).eq('player_id', guest.player.id);
    guest.player.client.realtime.connect();
    await waitFor(() => guest.seatLost, 'seatLost after reconnecting');
  });
});

describe('host gone', () => {
  it('tells guests once the host has been missing for the grace period', async () => {
    const { host, guests } = await setup(1);
    await host.session.close();
    await delay(GRACE_MS / 3);
    expect(guests[0]!.hostGone).toBe(false);
    await waitFor(() => guests[0]!.hostGone, 'hostGone');
  });

  it('tells a guest whose host never connected', async () => {
    const [hostPlayer, guestPlayer] = await Promise.all([createPlayer('Host'), createPlayer('Guest')]);
    const room = await createRoom(hostPlayer);
    const guest = await openSeat(guestPlayer, await join(guestPlayer, room));
    await waitFor(() => guest.hostGone, 'hostGone');
  });
});

describe('startMatch', () => {
  it('locks the room, drops unconnected seats, and sends everyone the gates', async () => {
    const { room, host, guests } = await setup(2);
    const ghost = await createPlayer('Ghost');
    await join(ghost, room);

    const gates = await host.session.startMatch();

    const expected = [host, ...guests].map((seat, i) => ({ seat: i, playerId: seat.player.id, displayName: seat.player.name }));
    expect(gates).toEqual(expected);
    expect(await roomStatus(room.id)).toBe('playing');
    expect(await seatIds(room.id)).toEqual(expected.map((g) => g.playerId));
    for (const guest of guests) {
      await waitFor(() => guest.events.length > 0, 'the start event');
      expect(guest.events).toEqual([{ type: 'start', gates: expected }]);
    }
  });

  it('needs at least two connected players', async () => {
    const { room, host } = await setup(0);
    await expect(host.session.startMatch()).rejects.toThrow('Need at least 2 connected players.');
    expect(await roomStatus(room.id)).toBe('waiting');
  });

  it('is host only', async () => {
    const { guests } = await setup(1);
    await expect(guests[0]!.session.startMatch()).rejects.toThrow('Only the host can start the match.');
  });
});

describe('leave', () => {
  it('a guest gives up their seat', async () => {
    const { room, host, guests } = await setup(1);
    await guests[0]!.session.leave();
    expect(await seatIds(room.id)).toEqual([host.player.id]);
  });

  it('the host closes a waiting room: guests hear "closed" and the room is deleted', async () => {
    const { room, host, guests } = await setup(1);
    await host.session.leave();
    await waitFor(() => guests[0]!.events.length > 0, 'the closed event');
    expect(guests[0]!.events).toEqual([{ type: 'closed' }]);
    expect(await roomStatus(room.id)).toBeUndefined();
  });

  it('the host ends a match: guests hear "closed" and the room is finished, not deleted', async () => {
    const { room, host, guests } = await setup(1);
    await host.session.startMatch();
    await host.session.leave();
    await waitFor(() => guests[0]!.events.some((e) => e.type === 'closed'), 'the closed event');
    expect(await roomStatus(room.id)).toBe('finished');
  });
});

describe('message validation', () => {
  it('ignores malformed broadcasts', async () => {
    const { room, guests } = await setup(1);
    const intruder = await createPlayer('Intruder');
    const channel = intruder.client.channel(`room:${room.id}`);
    await new Promise<void>((resolve) => channel.subscribe((status) => status === 'SUBSCRIBED' && resolve()));

    for (const payload of [{ type: 'start', gates: 'all of them' }, { type: 'explode' }, 'closed', null]) {
      await channel.send({ type: 'broadcast', event: 'event', payload });
    }
    await channel.send({ type: 'broadcast', event: 'event', payload: { type: 'closed' } });

    await waitFor(() => guests[0]!.events.length > 0, 'the valid event');
    expect(guests[0]!.events).toEqual([{ type: 'closed' }]);
    await intruder.client.removeChannel(channel);
  });
});
