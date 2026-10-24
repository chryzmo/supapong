// Shaping and formatting for the leaderboard screen.  Pure; unit tested in
// history.test.ts.
import type { Database } from '../database.types';
import type { LeaderboardEntry, MatchSummary } from '../types';

export type LeaderboardRow = Database['public']['Views']['leaderboard']['Row'];
export type MatchPlayerRow = Database['public']['Views']['match_players']['Row'];

/** For a player whose name is gone (results recorded before names were kept). */
export const UNKNOWN_PLAYER = 'Unknown player';

// View columns are all nullable in the generated types, though these never
// are in practice.  Rows without a player id are dropped.

export function toLeaderboardEntry(row: LeaderboardRow): LeaderboardEntry | null {
  if (!row.player_id) return null;
  return {
    rank: row.rank ?? 0,
    playerId: row.player_id,
    displayName: row.display_name ?? UNKNOWN_PLAYER,
    matches: row.matches ?? 0,
    wins: row.wins ?? 0,
    points: row.points ?? 0,
  };
}

/**
 * Groups match_players rows (one per player per match) into matches, in the
 * order of `ids`.  Players are sorted by place, then name.
 */
export function groupMatches(ids: string[], rows: MatchPlayerRow[]): MatchSummary[] {
  const byId = new Map<string, MatchSummary>();
  for (const row of rows) {
    if (!row.player_id) continue;
    let match = byId.get(row.result_id);
    if (!match) {
      match = { id: row.result_id, finishedAt: new Date(row.finished_at), roomName: row.room_name, players: [], ranked: row.ranked };
      byId.set(row.result_id, match);
    }
    match.players.push({
      playerId: row.player_id,
      displayName: row.display_name ?? UNKNOWN_PLAYER,
      score: row.score ?? 0,
      place: row.place ?? 0,
      won: row.won ?? false,
    });
  }
  for (const match of byId.values()) {
    match.players.sort((a, b) => a.place - b.place || a.displayName.localeCompare(b.displayName));
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** "1st", "2nd", "3rd", "4th", … "11th", "12th", "13th", "21st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", then a date. */
export function timeAgo(then: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return relative.format(-days, 'day');
  return then.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
