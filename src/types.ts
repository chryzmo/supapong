// Shared app types, plus parsers for messages that arrive over Realtime.
import type { Dir } from './game/physics';

export const DISPLAY_NAME_MAX = 24;
export const ROOM_NAME_MAX = 32;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export interface Player {
  id: string;
  displayName: string;
}

/** A row in the lobby list. */
export interface LobbyRoom {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
}

/** A room the current player is seated in. */
export interface SeatedRoom {
  id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  seat: number;
}

/** A row on the leaderboard.  Ranked by wins, then points; ties share a rank. */
export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  matches: number;
  wins: number;
  points: number;
}

/** A finished match, for the history list. */
export interface MatchSummary {
  id: string;
  finishedAt: Date;
  /** Null for results recorded before room names were kept. */
  roomName: string | null;
  /** Best place first. */
  players: MatchPlayer[];
}

export interface MatchPlayer {
  playerId: string;
  displayName: string;
  score: number;
  place: number;
  /** First place (shared counts) in a match where not everyone tied. */
  won: boolean;
}

type Validated = { ok: true; value: string } | { ok: false; error: string };

function validateName(raw: string, max: number, emptyError: string): Validated {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: emptyError };
  if (value.length > max) return { ok: false, error: `Keep it to ${max} characters or fewer.` };
  return { ok: true, value };
}

/** Trims a display name and returns it, or an error message if it's invalid. */
export function validateDisplayName(raw: string): Validated {
  return validateName(raw, DISPLAY_NAME_MAX, 'Pick a name.');
}

/** Trims a room name and returns it, or an error message if it's invalid. */
export function validateRoomName(raw: string): Validated {
  return validateName(raw, ROOM_NAME_MAX, 'Give the room a name.');
}

// Room channel messages --------------------------------------------------------
// Everything that arrives over Realtime is `unknown` until a parse function
// below accepts it.  Invalid messages are dropped.

/** What each player tracks in Presence on the room channel. */
export interface RosterEntry {
  playerId: string;
  displayName: string;
  seat: number;
}

/** A gate in a match, in gate order.  Gate i is centered at angle 2πi/N. */
export interface Gate {
  seat: number;
  playerId: string;
  displayName: string;
}

/** Broadcast `event` messages, sent by the host. */
export type RoomEvent =
  | { type: 'start'; gates: Gate[] }
  | { type: 'closed' }
  | { type: 'removed'; playerId: string }
  | { type: 'goal'; gate: number }
  | { type: 'end'; scores: number[] };

/** Broadcast `input` (player -> host): sent only when the direction changes. */
export interface InputMessage {
  seat: number;
  dir: Dir;
}

/**
 * Broadcast `state` (host -> all, ~20 Hz).  Arrays are per gate, in gate
 * order.  Numbers are rounded before sending to keep the payload small.
 */
export interface StateMessage {
  tick: number;
  /** x, y, vx, vy */
  ball: [number, number, number, number];
  paddles: number[];
  active: boolean[];
  scores: number[];
  /** Ticks until the ball launches; 0 while it's in play. */
  respawn: number;
  rally: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeat(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value < MAX_PLAYERS;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= DISPLAY_NAME_MAX;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function isNumberArray(value: unknown, length?: number): value is number[] {
  return (
    Array.isArray(value) &&
    (length === undefined || value.length === length) &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseRosterEntry(value: unknown): RosterEntry | null {
  if (!isRecord(value)) return null;
  const { playerId, displayName, seat } = value;
  if (!isId(playerId) || !isName(displayName) || !isSeat(seat)) return null;
  return { playerId, displayName, seat };
}

export function parseRoomEvent(value: unknown): RoomEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'start': {
      if (!Array.isArray(value.gates)) return null;
      const raw: unknown[] = value.gates;
      if (raw.length < MIN_PLAYERS || raw.length > MAX_PLAYERS) return null;
      const gates: Gate[] = [];
      for (const item of raw) {
        const gate = parseRosterEntry(item);
        if (!gate) return null;
        gates.push(gate);
      }
      if (new Set(gates.map((g) => g.seat)).size !== gates.length) return null;
      if (new Set(gates.map((g) => g.playerId)).size !== gates.length) return null;
      return { type: 'start', gates };
    }
    case 'closed':
      return { type: 'closed' };
    case 'removed':
      return isId(value.playerId) ? { type: 'removed', playerId: value.playerId } : null;
    case 'goal':
      return isSeat(value.gate) ? { type: 'goal', gate: value.gate } : null;
    case 'end': {
      const scores: unknown = value.scores;
      if (!Array.isArray(scores) || scores.length < MIN_PLAYERS || scores.length > MAX_PLAYERS) return null;
      return scores.every(isCount) ? { type: 'end', scores: scores.filter(isCount) } : null;
    }
    default:
      return null;
  }
}

export function parseInputMessage(value: unknown): InputMessage | null {
  if (!isRecord(value)) return null;
  const { seat, dir } = value;
  if (!isSeat(seat) || (dir !== -1 && dir !== 0 && dir !== 1)) return null;
  return { seat, dir };
}

export function parseStateMessage(value: unknown): StateMessage | null {
  if (!isRecord(value)) return null;
  const { tick, ball, paddles, active, scores, respawn, rally } = value;
  if (!isCount(tick) || !isCount(respawn) || !isCount(rally)) return null;
  if (!isNumberArray(ball, 4)) return null;
  if (!isNumberArray(paddles) || paddles.length < MIN_PLAYERS || paddles.length > MAX_PLAYERS) return null;
  const n = paddles.length;
  if (!Array.isArray(active) || active.length !== n || !active.every((a) => typeof a === 'boolean')) return null;
  if (!Array.isArray(scores) || scores.length !== n || !scores.every(isCount)) return null;
  const [x, y, vx, vy] = ball;
  if (x === undefined || y === undefined || vx === undefined || vy === undefined) return null;
  return {
    tick,
    ball: [x, y, vx, vy],
    paddles,
    active: active.filter((a): a is boolean => typeof a === 'boolean'),
    scores: scores.filter(isCount),
    respawn,
    rally,
  };
}
