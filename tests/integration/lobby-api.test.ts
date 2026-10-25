// src/lobby/api.ts against the local stack, acting as different players.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createRoom,
  fetchLobbyRooms,
  fetchRoom,
  fetchSeatedRoom,
  joinRoom,
  leaveRoom,
} from '../../src/lobby/api';
import { actAs, admin, createPlayer, type TestPlayer } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

let host: TestPlayer;
let guest: TestPlayer;
let other: TestPlayer;

beforeAll(async () => {
  [host, guest, other] = await Promise.all([createPlayer('Host'), createPlayer('Guest'), createPlayer('Other')]);
});

async function lobbyEntry(roomId: string) {
  return (await fetchLobbyRooms()).find((room) => room.id === roomId);
}

describe('createRoom', () => {
  it('creates a room, seats the host at seat 0 and lists it in the lobby', async () => {
    actAs(host);
    const roomId = await createRoom('Arena', 4);

    expect(await fetchSeatedRoom(host.id)).toEqual({ id: roomId, name: 'Arena', hostId: host.id, maxPlayers: 4, goalLimit: 10, matchSeconds: 120, powerUps: true, multiballOnly: false, seat: 0 });

    actAs(other);
    expect(await lobbyEntry(roomId)).toEqual({
      id: roomId,
      name: 'Arena',
      hostId: host.id,
      hostName: 'Host',
      playerCount: 1,
      maxPlayers: 4,
      goalLimit: 10,
      matchSeconds: 120,
      powerUps: true,
      multiballOnly: false,
    });
  });

  it('keeps the goal limit the creator picked', async () => {
    actAs(host);
    const roomId = await createRoom('Long one', 2, 25);
    expect((await fetchRoom(roomId, 0)).goalLimit).toBe(25);
    actAs(other);
    expect((await lobbyEntry(roomId))?.goalLimit).toBe(25);
  });

  it.each([
    ['classic', { powerUps: false, multiballOnly: false }],
    ['multiball', { powerUps: true, multiballOnly: true }],
    ['power-ups', { powerUps: true, multiballOnly: false }],
  ] as const)('makes a %s room when asked', async (gameType, flags) => {
    actAs(host);
    const roomId = await createRoom('Typed', 2, 10, gameType);
    expect(await fetchRoom(roomId, 0)).toMatchObject(flags);
    actAs(other);
    expect(await lobbyEntry(roomId)).toMatchObject(flags);
  });

  it('rejects sizes outside 2-8 and empty names', async () => {
    actAs(host);
    await expect(createRoom('Too small', 1)).rejects.toMatchObject({ code: '23514' });
    await expect(createRoom('Too big', 9)).rejects.toMatchObject({ code: '23514' });
    await expect(createRoom('   ', 4)).rejects.toMatchObject({ code: '23514' });
  });

  it('lists the newest rooms first', async () => {
    actAs(host);
    const first = await createRoom('First', 2);
    const second = await createRoom('Second', 2);
    const ids = (await fetchLobbyRooms()).map((room) => room.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
  });
});

describe('joinRoom', () => {
  it('assigns the next seat, is idempotent, and updates the lobby count', async () => {
    actAs(host);
    const roomId = await createRoom('Join me', 3);

    actAs(guest);
    expect(await joinRoom(roomId)).toBe(1);
    expect(await joinRoom(roomId)).toBe(1);
    expect((await lobbyEntry(roomId))?.playerCount).toBe(2);
    expect(await fetchRoom(roomId, 1)).toEqual({ id: roomId, name: 'Join me', hostId: host.id, maxPlayers: 3, goalLimit: 10, matchSeconds: 120, powerUps: true, multiballOnly: false, seat: 1 });
  });

  it('surfaces the RPC error messages', async () => {
    actAs(host);
    const roomId = await createRoom('Tiny', 2);
    actAs(guest);
    await joinRoom(roomId);

    actAs(other);
    await expect(joinRoom(roomId)).rejects.toMatchObject({ message: 'That room is full.' });
    await expect(joinRoom('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      message: 'That room no longer exists.',
    });
  });

  it('refuses to join a match in progress, and hides it from the lobby', async () => {
    actAs(host);
    const roomId = await createRoom('Started', 4);
    const { error } = await host.client.rpc('set_room_status', { p_room_id: roomId, p_status: 'playing' });
    expect(error).toBeNull();

    actAs(guest);
    await expect(joinRoom(roomId)).rejects.toMatchObject({ message: 'That match has already started.' });
    expect(await lobbyEntry(roomId)).toBeUndefined();
  });
});

describe('fetchSeatedRoom', () => {
  it('returns null when the player has no seat', async () => {
    const loner = await createPlayer('Loner');
    actAs(loner);
    expect(await fetchSeatedRoom(loner.id)).toBeNull();
  });

  it('ignores rooms that are no longer waiting', async () => {
    const player = await createPlayer('Starter');
    actAs(player);
    const roomId = await createRoom('Mine', 2);
    expect((await fetchSeatedRoom(player.id))?.id).toBe(roomId);

    await player.client.rpc('set_room_status', { p_room_id: roomId, p_status: 'playing' });
    expect(await fetchSeatedRoom(player.id)).toBeNull();
  });
});

describe('leaveRoom', () => {
  // Fresh players, so seats from earlier tests don't show up in fetchSeatedRoom.
  it('removes only the leaving guest', async () => {
    const [roomHost, leaver] = await Promise.all([createPlayer('Host'), createPlayer('Leaver')]);
    actAs(roomHost);
    const roomId = await createRoom('Leaving', 4);
    actAs(leaver);
    const seat = await joinRoom(roomId);
    const room = await fetchRoom(roomId, seat);

    await leaveRoom(room, leaver.id);
    expect(await fetchSeatedRoom(leaver.id)).toBeNull();
    expect(await fetchSeatedRoom(roomHost.id)).toMatchObject({ id: roomId, seat: 0 });
    expect((await lobbyEntry(roomId))?.playerCount).toBe(1);
  });

  it('closes the room when the host leaves', async () => {
    actAs(host);
    const roomId = await createRoom('Closing', 4);
    actAs(guest);
    await joinRoom(roomId);

    actAs(host);
    await leaveRoom(await fetchRoom(roomId, 0), host.id);

    expect(await lobbyEntry(roomId)).toBeUndefined();
    const { count } = await admin.from('room_players').select('*', { count: 'exact', head: true }).eq('room_id', roomId);
    expect(count).toBe(0);
  });
});
