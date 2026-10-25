import { supabase } from '../supabase';
import { DEFAULT_GOAL_LIMIT, gameTypeFlags, type GameType, type LobbyRoom, type SeatedRoom } from '../types';

export async function fetchLobbyRooms(): Promise<LobbyRoom[]> {
  const { data, error } = await supabase
    .from('lobby_rooms')
    .select('id, name, host_id, host_name, player_count, max_players, goal_limit, power_ups, match_seconds, multiball_only')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    hostId: r.host_id,
    hostName: r.host_name,
    playerCount: r.player_count ?? 0,
    maxPlayers: r.max_players,
    goalLimit: r.goal_limit,
    matchSeconds: r.match_seconds,
    powerUps: r.power_ups,
    multiballOnly: r.multiball_only,
  }));
}

/** Creates a room and seats the caller as host, in one transaction (see create_room). */
export async function createRoom(name: string, maxPlayers: number, goalLimit = DEFAULT_GOAL_LIMIT, gameType: GameType = 'power-ups'): Promise<string> {
  const { powerUps, multiballOnly } = gameTypeFlags(gameType);
  const { data, error } = await supabase.rpc('create_room', {
    p_name: name,
    p_max_players: maxPlayers,
    p_goal_limit: goalLimit,
    p_power_ups: powerUps,
    p_multiball_only: multiballOnly,
  });
  if (error) throw error;
  return data;
}

/** Takes the lowest free seat in a room and returns it (see join_room). */
export async function joinRoom(roomId: string): Promise<number> {
  const { data, error } = await supabase.rpc('join_room', { p_room_id: roomId });
  if (error) throw error;
  return data;
}

/**
 * Leaves a room.  The host closes the room instead, which removes every seat
 * through `on delete cascade`.
 */
export async function leaveRoom(room: SeatedRoom, userId: string): Promise<void> {
  const { error } =
    room.hostId === userId
      ? await supabase.from('rooms').delete().eq('id', room.id)
      : await supabase.from('room_players').delete().eq('room_id', room.id).eq('player_id', userId);
  if (error) throw error;
}

/** Finds the waiting room the player is seated in, so a reload returns them to it. */
export async function fetchSeatedRoom(userId: string): Promise<SeatedRoom | null> {
  const { data, error } = await supabase
    .from('room_players')
    .select('seat, rooms!inner(id, name, host_id, max_players, goal_limit, match_seconds, power_ups, multiball_only, status)')
    .eq('player_id', userId)
    .eq('rooms.status', 'waiting')
    .order('joined_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.rooms.id,
    name: data.rooms.name,
    hostId: data.rooms.host_id,
    maxPlayers: data.rooms.max_players,
    goalLimit: data.rooms.goal_limit,
    matchSeconds: data.rooms.match_seconds,
    powerUps: data.rooms.power_ups,
    multiballOnly: data.rooms.multiball_only,
    seat: data.seat,
  };
}

export async function fetchRoom(roomId: string, seat: number): Promise<SeatedRoom> {
  const { data, error } = await supabase
    .from('rooms')
    .select('id, name, host_id, max_players, goal_limit, match_seconds, power_ups, multiball_only')
    .eq('id', roomId)
    .single();
  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    hostId: data.host_id,
    maxPlayers: data.max_players,
    goalLimit: data.goal_limit,
    matchSeconds: data.match_seconds,
    powerUps: data.power_ups,
    multiballOnly: data.multiball_only,
    seat,
  };
}

/**
 * Calls onChange whenever a room or seat changes.  The lobby simply refetches,
 * so the payload is ignored.  Changes are debounced because creating a room
 * fires two events (the room and the host's seat).
 */
export function subscribeLobby(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };

  // `wait: true` holds SUBSCRIBED until Postgres Changes are actually flowing.
  // Without it, SUBSCRIBED can arrive first (especially just after the stack
  // starts) and changes in that gap are missed.  The channel is private so
  // the project can refuse public channels; any signed-in player may join.
  const channel = supabase
    .channel('lobby', { config: { private: true, postgres_changes_options: { wait: true } } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, fire)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players' }, fire)
    // Refetch once live, to catch anything that changed since the first fetch.
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') fire();
    });

  return () => {
    clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
