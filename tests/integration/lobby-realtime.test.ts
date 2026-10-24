// subscribeLobby: Postgres Changes reach the lobby, debounced into one refetch.
import { afterEach, expect, it, vi } from 'vitest';
import { createRoom, joinRoom, leaveRoom, subscribeLobby } from '../../src/lobby/api';
import { actAs, createPlayer, delay, waitFor } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

let unsubscribe: (() => void) | undefined;
afterEach(() => unsubscribe?.());

it('calls onChange once when live, then once per lobby change', async () => {
  const [watcher, host, guest] = await Promise.all([createPlayer('Watcher'), createPlayer('Host'), createPlayer('Guest')]);
  // Each player gets a separate client, so the watcher's channel is
  // unaffected by actAs() calls made later for the others.
  actAs(watcher);
  let calls = 0;
  unsubscribe = subscribeLobby(() => calls++);

  // The first call comes from the "Subscribed to PostgreSQL" system message.
  await waitFor(() => calls === 1, 'the subscription to go live');

  // Creating a room fires two inserts (room + host seat), debounced into one call.
  actAs(host);
  const roomId = await createRoom('Live', 4);
  await waitFor(() => calls === 2, 'room insert');
  await delay(400);
  expect(calls).toBe(2);

  actAs(guest);
  const seat = await joinRoom(roomId);
  await waitFor(() => calls === 3, 'seat insert');

  await leaveRoom({ id: roomId, name: 'Live', hostId: host.id, maxPlayers: 4, goalLimit: 10, matchSeconds: 120, powerUps: true, seat }, guest.id);
  await waitFor(() => calls === 4, 'seat delete');

  actAs(host);
  await leaveRoom({ id: roomId, name: 'Live', hostId: host.id, maxPlayers: 4, goalLimit: 10, matchSeconds: 120, powerUps: true, seat: 0 }, host.id);
  await waitFor(() => calls === 5, 'room delete');
});

it('stops calling onChange after unsubscribing', async () => {
  const [watcher, host] = await Promise.all([createPlayer('Watcher'), createPlayer('Host')]);
  actAs(watcher);
  let calls = 0;
  const stop = subscribeLobby(() => calls++);
  await waitFor(() => calls === 1, 'the subscription to go live');
  stop();

  actAs(host);
  await createRoom('Unheard', 2);
  await delay(1000);
  expect(calls).toBe(1);
});
