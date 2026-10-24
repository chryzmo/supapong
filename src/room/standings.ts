// Final standings from a finished match.  Pure; unit tested in standings.test.ts.
import type { Gate } from '../types';

/** Everything the results screen needs, in gate order. */
export interface MatchResult {
  gates: Gate[];
  scores: number[];
  /** False for players who left before the end. */
  active: boolean[];
}

export interface Standing {
  place: number;
  gate: number;
  playerId: string;
  displayName: string;
  score: number;
  left: boolean;
}

/**
 * Players by score, highest first.  Ties share a place and the next place is
 * skipped (1, 1, 3), the usual "competition" ranking.  Equal scores keep gate
 * order so the list is stable.
 */
export function standings(result: MatchResult): Standing[] {
  const rows = result.gates
    .map((gate, i) => ({
      gate: i,
      playerId: gate.playerId,
      displayName: gate.displayName,
      score: result.scores[i] ?? 0,
      left: result.active[i] === false,
    }))
    .sort((a, b) => b.score - a.score || a.gate - b.gate);

  return rows.map((row) => ({ ...row, place: 1 + rows.filter((other) => other.score > row.score).length }));
}

export function headline(rows: Standing[]): string {
  const winners = rows.filter((row) => row.place === 1).map((row) => row.displayName);
  if (winners.length === 0) return 'No result';
  if (winners.length === 1) return `${winners[0]} wins!`;
  if (winners.length === rows.length) return "It's a tie!";
  return `${listNames(winners)} tie for first`;
}

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The `{ player_id: points }` shape finish_match stores. */
export function scoresByPlayer(result: MatchResult): Record<string, number> {
  return Object.fromEntries(result.gates.map((gate, i) => [gate.playerId, result.scores[i] ?? 0]));
}
