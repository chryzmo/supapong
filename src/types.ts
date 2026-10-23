// Shared app types.  Realtime message payloads will be added here in later
// milestones, along with runtime guards that check them at the boundary.

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
