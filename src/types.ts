// Shared app types, plus parsers for messages that arrive over Realtime.

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
  | { type: 'removed'; playerId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeat(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value < MAX_PLAYERS;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= DISPLAY_NAME_MAX;
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
    default:
      return null;
  }
}
