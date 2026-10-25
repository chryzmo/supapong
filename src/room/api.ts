// Database calls used by a room session.  They take the client explicitly
// because a session keeps using the client it was opened with.
import type { AppClient } from '../supabase';
import type { MatchSettings } from '../types';

export async function fetchSeatIds(client: AppClient, roomId: string): Promise<string[]> {
  const { data, error } = await client.from('room_players').select('player_id').eq('room_id', roomId);
  if (error) throw error;
  return data.map((row) => row.player_id);
}

export async function hasSeat(client: AppClient, roomId: string, playerId: string): Promise<boolean> {
  const { count, error } = await client
    .from('room_players')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('player_id', playerId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Host only (RLS): removes a player's seat, e.g. after their Presence is gone. */
export async function removePlayer(client: AppClient, roomId: string, playerId: string): Promise<void> {
  const { error } = await client.from('room_players').delete().eq('room_id', roomId).eq('player_id', playerId);
  if (error) throw error;
}

/** Host only (checked in set_room_status). */
export async function setRoomStatus(client: AppClient, roomId: string, status: 'playing' | 'finished'): Promise<void> {
  const { error } = await client.rpc('set_room_status', { p_room_id: roomId, p_status: status });
  if (error) throw error;
}

/** Host only, before the match (checked in set_match_settings): what ends it (null is "no limit"), and the power-up flags. */
export async function setMatchSettings(client: AppClient, roomId: string, settings: MatchSettings): Promise<void> {
  const { error } = await client.rpc('set_match_settings', {
    p_room_id: roomId,
    // Generated RPC types don't know a null is allowed here.
    p_goal_limit: settings.goalLimit as number,
    p_match_seconds: settings.matchSeconds as number,
    p_power_ups: settings.powerUps,
    p_multiball_only: settings.multiballOnly,
  });
  if (error) throw error;
}

/** Host only (RLS): deletes the room, which removes every seat through `on delete cascade`. */
export async function deleteRoom(client: AppClient, roomId: string): Promise<void> {
  const { error } = await client.from('rooms').delete().eq('id', roomId);
  if (error) throw error;
}

/**
 * Guests only (checked in confirm_result): reports the scores this player was
 * shown.  The result only counts toward the leaderboard once most players agree.
 */
export async function confirmResult(client: AppClient, roomId: string, scores: Record<string, number>): Promise<void> {
  const { error } = await client.rpc('confirm_result', { p_room_id: roomId, p_scores: scores });
  if (error) throw error;
}

/** Host only (checked in finish_match): records the result and finishes the room, in one transaction. */
export async function finishMatch(client: AppClient, roomId: string, scores: Record<string, number>): Promise<void> {
  const { error } = await client.rpc('finish_match', { p_room_id: roomId, p_scores: scores });
  if (error) throw error;
}
