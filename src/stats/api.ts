import { supabase } from '../supabase';
import type { LeaderboardEntry, MatchSummary } from '../types';
import { groupMatches, toLeaderboardEntry } from './history';

const LEADERBOARD_COLUMNS = 'player_id, display_name, matches, wins, points, rank';

/** The top of the leaderboard (see the leaderboard view). */
export async function fetchLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase
    .from('leaderboard')
    .select(LEADERBOARD_COLUMNS)
    .order('rank')
    .order('display_name')
    .limit(limit);
  if (error) throw error;
  return data.flatMap((row) => toLeaderboardEntry(row) ?? []);
}

/** One player's leaderboard row, or null if they haven't finished a match. */
export async function fetchStanding(playerId: string): Promise<LeaderboardEntry | null> {
  const { data, error } = await supabase
    .from('leaderboard')
    .select(LEADERBOARD_COLUMNS)
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw error;
  return data && toLeaderboardEntry(data);
}

/**
 * The latest finished matches, newest first, optionally only those a player
 * was in.  Two queries: one picks the matches, the other fetches everyone
 * who played in them.
 */
export async function fetchRecentMatches(options: { playerId?: string; limit?: number } = {}): Promise<MatchSummary[]> {
  const limit = options.limit ?? 10;
  const picked = options.playerId
    ? await supabase
        .from('match_players')
        .select('id:result_id')
        .eq('player_id', options.playerId)
        .order('finished_at', { ascending: false })
        .limit(limit)
    : await supabase.from('match_results').select('id').order('finished_at', { ascending: false }).limit(limit);
  if (picked.error) throw picked.error;
  const ids = picked.data.map((row) => row.id);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('match_players')
    .select('result_id, finished_at, room_name, player_id, display_name, score, place, won, player_count')
    .in('result_id', ids);
  if (error) throw error;
  return groupMatches(ids, data);
}
