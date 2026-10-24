// Shared app types, plus parsers for messages that arrive over Realtime.
import type { Dir } from './game/physics';

export const DISPLAY_NAME_MAX = 24;
export const ROOM_NAME_MAX = 32;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
/**
 * The version of the match messages this code speaks.  2: snapshots carry
 * `balls`.  3: power-ups.  4: match lengths and "no limit".  The host's
 * `start` says the oldest version that can play that match (matchProtocol),
 * so a guest on older code knows to reload, and only when it has to.
 */
export const PROTOCOL_VERSION = 4;

/** The oldest PROTOCOL_VERSION that can play a match. */
export function matchProtocol(match: MatchSettings): number {
  if (match.goalLimit === null || match.matchSeconds !== DEFAULT_MATCH_SECONDS) return 4;
  return match.powerUps ? 3 : 2;
}
/** How many kinds of token there are (PICKUP_KINDS in physics.ts). */
const PICKUP_KIND_COUNT = 3;
/** Most balls a snapshot may carry. */
export const MAX_BALLS = 8;
/** Goals in total that end a match.  The database accepts 1 to 50; the lobby offers these. */
export const GOAL_LIMIT_CHOICES = [5, 10, 15, 20, 25] as const;
export const DEFAULT_GOAL_LIMIT = 10;
const GOAL_LIMIT_MAX = 50;
/** How long a match lasts, in seconds.  The database accepts only these. */
export const MATCH_LENGTH_CHOICES = [120, 300, 600] as const;
export const DEFAULT_MATCH_SECONDS = 120;

/**
 * The host's choices for a match.  What ends it: a total number of goals, a
 * length in seconds, or both, whichever comes first (null is "no limit", and
 * at most one can be).  And whether it has power-ups.
 */
export interface MatchSettings {
  goalLimit: number | null;
  matchSeconds: number | null;
  powerUps: boolean;
}

/** "10 goals or 2 minutes", "10 goals", "5 minutes". */
export function describeMatchEnd({ goalLimit, matchSeconds }: Pick<MatchSettings, 'goalLimit' | 'matchSeconds'>): string {
  const parts = [
    ...(goalLimit !== null ? [`${goalLimit} goals`] : []),
    ...(matchSeconds !== null ? [`${matchSeconds / 60} minutes`] : []),
  ];
  return parts.join(' or ');
}

export interface Player {
  id: string;
  displayName: string;
}

/** A row in the lobby list. */
export interface LobbyRoom extends MatchSettings {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
}

/** A room the current player is seated in, with its match settings as they were when it was fetched. */
export interface SeatedRoom extends MatchSettings {
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
  /** Counts toward the leaderboard: most players confirmed the result. */
  ranked: boolean;
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
  /** A computer paddle, run by the host.  Bots hold no seat in the database and aren't saved in results. */
  bot?: true;
}

/** What the host tells everyone when the match starts. */
export interface MatchStart extends MatchSettings {
  gates: Gate[];
  /** The oldest PROTOCOL_VERSION that can play this match (matchProtocol).  1 when a host on older code leaves it out. */
  protocol: number;
  /** Host only, never sent: how well the bots play, 0 to 1 (see botInput). */
  botSkill?: number;
}

/** Broadcast `event` messages, sent by the host. */
export type RoomEvent =
  | ({ type: 'start' } & MatchStart)
  | { type: 'closed' }
  | { type: 'removed'; playerId: string }
  /** `scorer`: the gate that got the point, left out if nobody did. */
  | { type: 'goal'; gate: number; scorer?: number }
  | { type: 'end'; scores: number[] }
  /** The host changed the match settings, in the waiting room. */
  | ({ type: 'settings' } & MatchSettings);

/**
 * Broadcast `input` (player -> host): sent when the direction changes, and a
 * few times a second while moving.  `paddle` is where the player has their
 * paddle on screen; the host adopts it, so its copy doesn't overshoot when a
 * key is released (see ClientGame).
 */
export interface InputMessage {
  seat: number;
  dir: Dir;
  paddle?: number;
  /**
   * A save the player saw on their screen and the host may have missed (see
   * saves.ts).  `ball` is its index in the snapshot; a guest on protocol 1
   * leaves it out, meaning 0.
   */
  save?: { tick: number; paddle: number; ball?: number };
}

/**
 * Broadcast `state` (host -> all, ~20 Hz).  Arrays are per gate, in gate
 * order.  Numbers are rounded before sending to keep the payload small.
 */
/**
 * One ball: x, y, vx, vy, then the gate that touched it last (and would
 * score; it tints the ball), or -1, and its rally (hits since launch).
 */
export type BallTuple = [number, number, number, number, number, number];

export interface StateMessage {
  tick: number;
  /** Never empty: while waiting to launch, one ball resting at the center. */
  balls: BallTuple[];
  paddles: number[];
  active: boolean[];
  scores: number[];
  /** Goals scored so far; the match ends at the room's goal limit. */
  goals: number;
  /** The host's PRNG state, so clients can replay the physics between snapshots. */
  seed?: number;
  /** Ticks until the ball launches; 0 while it's in play. */
  respawn: number;
  // Power-ups.  Left out when there's nothing to say, so a classic match's
  // snapshots stay as they were.
  /** The token on the board: kind (an index into PICKUP_KINDS), x, y, ticks left. */
  pickup?: [number, number, number, number];
  /** Ticks of play with an empty board until the timer puts a token out. */
  timer?: number;
  /** Per gate: ticks left of a wide paddle, and of a shield. */
  wide?: number[];
  shield?: number[];
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

/** A goal limit (1 to 50) and length in seconds (up to an hour), either of them null but not both, and the power-ups flag. */
function parseSettings(goalLimit: unknown, matchSeconds: unknown, powerUps: unknown): MatchSettings | null {
  if (goalLimit !== null && !(isCount(goalLimit) && goalLimit >= 1 && goalLimit <= GOAL_LIMIT_MAX)) return null;
  if (matchSeconds !== null && !(isCount(matchSeconds) && matchSeconds >= 1 && matchSeconds <= 3600)) return null;
  if (goalLimit === null && matchSeconds === null) return null;
  if (typeof powerUps !== 'boolean') return null;
  return { goalLimit, matchSeconds, powerUps };
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
        const entry = parseRosterEntry(item);
        if (!entry) return null;
        gates.push(isRecord(item) && item.bot === true ? { ...entry, bot: true } : entry);
      }
      if (new Set(gates.map((g) => g.seat)).size !== gates.length) return null;
      if (new Set(gates.map((g) => g.playerId)).size !== gates.length) return null;
      // A host on older code sends no limits (and played to 10 goals or 2
      // minutes); null is "no limit".
      // and no power-ups.
      const settings = parseSettings(
        value.goalLimit === undefined ? DEFAULT_GOAL_LIMIT : value.goalLimit,
        value.matchSeconds === undefined ? DEFAULT_MATCH_SECONDS : value.matchSeconds,
        value.powerUps ?? false,
      );
      if (!settings) return null;
      const protocol = value.protocol ?? 1;
      if (!isCount(protocol) || protocol < 1) return null;
      return { type: 'start', gates, ...settings, protocol };
    }
    case 'settings': {
      const settings = parseSettings(value.goalLimit, value.matchSeconds, value.powerUps);
      return settings && { type: 'settings', ...settings };
    }
    case 'closed':
      return { type: 'closed' };
    case 'removed':
      return isId(value.playerId) ? { type: 'removed', playerId: value.playerId } : null;
    case 'goal':
    {
      if (!isSeat(value.gate)) return null;
      if (value.scorer === undefined) return { type: 'goal', gate: value.gate };
      if (!isSeat(value.scorer) || value.scorer === value.gate) return null;
      return { type: 'goal', gate: value.gate, scorer: value.scorer };
    }
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
  const { seat, dir, paddle } = value;
  if (!isSeat(seat) || (dir !== -1 && dir !== 0 && dir !== 1)) return null;
  if (paddle !== undefined && !isFiniteNumber(paddle)) return null;
  const input: InputMessage = paddle === undefined ? { seat, dir } : { seat, dir, paddle };
  if (value.save === undefined) return input;
  if (!isRecord(value.save)) return null;
  const { tick, paddle: savedAt, ball } = value.save;
  if (!isFiniteNumber(tick) || tick < 0 || !isFiniteNumber(savedAt)) return null;
  if (ball !== undefined && !(isCount(ball) && ball < MAX_BALLS)) return null;
  return { ...input, save: { tick, paddle: savedAt, ...(ball !== undefined ? { ball } : {}) } };
}

export function parseStateMessage(value: unknown): StateMessage | null {
  if (!isRecord(value)) return null;
  const { tick, paddles, active, scores, respawn, seed } = value;
  // A host still on the previous version sends no goals or seed.
  const goals = value.goals ?? 0;
  if (seed !== undefined && !(isCount(seed) && seed <= 0xffffffff)) return null;
  if (!isCount(tick) || !isCount(goals) || !isCount(respawn)) return null;
  if (!isNumberArray(paddles) || paddles.length < MIN_PLAYERS || paddles.length > MAX_PLAYERS) return null;
  const n = paddles.length;
  if (!Array.isArray(active) || active.length !== n || !active.every((a) => typeof a === 'boolean')) return null;
  if (!Array.isArray(scores) || scores.length !== n || !scores.every(isCount)) return null;
  const balls = parseBalls(value, n);
  if (!balls) return null;
  const { pickup, timer, wide, shield } = value;
  if (pickup !== undefined) {
    if (!isNumberArray(pickup, 4)) return null;
    const [kind, , , ticksLeft] = pickup;
    if (!(isCount(kind) && kind < PICKUP_KIND_COUNT) || !isCount(ticksLeft)) return null;
  }
  if (timer !== undefined && !isCount(timer)) return null;
  for (const effect of [wide, shield]) {
    if (effect !== undefined && !(Array.isArray(effect) && effect.length === n && effect.every(isCount))) return null;
  }
  return {
    tick,
    balls,
    paddles,
    active: active.filter((a): a is boolean => typeof a === 'boolean'),
    scores: scores.filter(isCount),
    goals,
    ...(seed !== undefined ? { seed } : {}),
    respawn,
    ...(isNumberArray(pickup, 4) ? { pickup: [pickup[0]!, pickup[1]!, pickup[2]!, pickup[3]!] } : {}),
    ...(isCount(timer) ? { timer } : {}),
    ...(Array.isArray(wide) ? { wide: wide.filter(isCount) } : {}),
    ...(Array.isArray(shield) ? { shield: shield.filter(isCount) } : {}),
  };
}

/**
 * `balls`, or a host on protocol 1's single `ball` with its `touch` and
 * `rally` alongside.
 */
function parseBalls(value: Record<string, unknown>, gateCount: number): BallTuple[] | null {
  const raw: unknown[] | null = Array.isArray(value.balls)
    ? value.balls
    : isNumberArray(value.ball, 4)
      ? [[...value.ball, value.touch ?? -1, value.rally]]
      : null;
  if (!raw || raw.length === 0 || raw.length > MAX_BALLS) return null;
  const balls: BallTuple[] = [];
  for (const ball of raw) {
    if (!isNumberArray(ball, 6)) return null;
    const [x, y, vx, vy, touch, rally] = ball;
    if (x === undefined || y === undefined || vx === undefined || vy === undefined || touch === undefined || rally === undefined) return null;
    if (touch !== -1 && !(isCount(touch) && touch < gateCount)) return null;
    if (!isCount(rally)) return null;
    balls.push([x, y, vx, vy, touch, rally]);
  }
  return balls;
}
