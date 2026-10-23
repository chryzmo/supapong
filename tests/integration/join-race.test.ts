// join_room under real concurrency: separate HTTP requests, separate transactions.
import { expect, it } from 'vitest';
import { createPlayer } from './helpers';

it('never gives two players the same seat when they join at once', async () => {
  const host = await createPlayer('Host');
  const { data: roomId, error } = await host.client.rpc('create_room', { p_name: 'Race', p_max_players: 8 });
  if (error) throw error;

  const joiners = await Promise.all(Array.from({ length: 12 }, (_, i) => createPlayer(`P${i}`)));
  const results = await Promise.all(joiners.map((p) => p.client.rpc('join_room', { p_room_id: roomId })));

  const seats = results.flatMap((r) => (r.error ? [] : [r.data])).sort((a, b) => a - b);
  const errors = results.flatMap((r) => (r.error ? [r.error.message] : []));

  expect(seats).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(errors).toEqual(Array(5).fill('That room is full.'));
});
