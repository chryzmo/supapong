// The host's side of a match: runs the physics at a fixed 60 Hz, applies
// everyone's inputs (and drives any bots), and broadcasts snapshots and events.
//
// Why host-authoritative?  One browser decides what happened, so players
// can't disagree about a goal, and the backend stays plain Supabase with no
// game server.  The cost is that the host is a single point of failure (if it
// leaves, the match ends) and could cheat; both are fine for a prototype.
//
// Saves the guest saw.  A guest draws the ball ~100 ms in the past but their
// own paddle in the present, so a save on their screen can be a miss here.
// When that happens the guest claims the save (see saves.ts), and the host
// rewinds: it keeps the last CLAIM_WINDOW_TICKS of ticks, replays from the
// claimed one with the guest's paddle where they had it, and if that's a
// hit, the replay becomes the match.  The physics is pure and cheap, so a
// rewind is just a few dozen steps.  To make that possible, a goal against a
// guest is only made official (scored, flashed, counted toward the end) once
// the window has passed with no claim.
import type { Gate, RoomEvent, StateMessage } from '../types';
import { botInput } from './bot';
import { interpolate } from './interpolate';
import { workerTicker, type Ticker } from './loop';
import {
  DEFAULT_CONFIG,
  DT,
  TICK_RATE,
  angleDiff,
  createGame,
  gateHalfWidth,
  movePaddle,
  paddleWidth,
  setGateActive,
  step,
  type Dir,
  type GameState,
  type PhysicsConfig,
  type PhysicsEvent,
  wrapAngle,
} from './physics';
import { encodeState } from './snapshot';

/** Send a snapshot every this many ticks: 60 / 3 = 20 Hz. */
export const SNAPSHOT_EVERY = 3;
export const COUNTDOWN_SECONDS = 3;
/** If the host falls further behind than this, it skips ahead instead of catching up. */
const MAX_CATCH_UP_TICKS = 15;
/**
 * How long a goal against a guest waits for a save claim, and how far back a
 * claim can reach: 250 ms, for the guest's 100 ms draw delay plus a round trip.
 */
export const CLAIM_WINDOW_TICKS = 15;
/** A claimed paddle may be at most this many seconds of travel from where the host had it. */
const CLAIM_SLACK_SECONDS = 0.4;
/**
 * How far the host will move a guest's paddle to where the guest says it is,
 * beyond what their inputs moved it: at most this many seconds of paddle
 * travel at once, coming back at ADOPT_REFILL seconds per second.  An honest
 * guest is only ever a network delay ahead of the host's copy, so they need
 * little.  A cheating one could otherwise teleport.
 */
export const ADOPT_BURST_SECONDS = 0.25;
const ADOPT_REFILL = 0.5;

/** One tick, kept so the host can replay from it. */
interface TickRecord {
  /** The state the tick started from, paddles included (they don't depend on the ball). */
  before: GameState;
  inputs: Dir[];
  events: PhysicsEvent[];
}

/** A goal not yet official.  `tick` is the state's tick after the goal. */
interface PendingGoal {
  tick: number;
  gate: number;
  scorer: number;
}

/** Where the host sends things.  A RoomSession in the app; a fake in tests. */
export interface HostOutput {
  sendState(message: StateMessage): void;
  send(event: RoomEvent): Promise<void>;
}

export interface HostOptions {
  config?: PhysicsConfig;
  seed?: number;
  ticker?: Ticker;
  now?: () => number;
  /** How well bot gates play, 0 to 1 (see botInput). */
  botSkill?: number;
  /** @param scorer The gate that got the point, or -1. */
  onGoal?(gate: number, scorer: number): void;
  onEnd?(scores: number[]): void;
  /** Start from this state instead of a fresh game.  For tests. */
  state?: GameState;
}

export class HostGame {
  private state: GameState;
  private prev: GameState;
  private readonly inputs: Dir[];
  private readonly config: PhysicsConfig;
  private readonly now: () => number;
  private nextTickAt = 0;
  private lastTickAt = 0;
  private stopTicker: (() => void) | undefined;
  private over = false;
  /** Ticks run, which keep counting once the clock has run out. */
  private ticksRun = 0;
  private history: TickRecord[] = [];
  private pending: PendingGoal[] = [];
  /** The official score: everything but pending goals.  This is what everyone sees. */
  private readonly scores: number[];
  private goals = 0;
  /** Per gate: how much paddle travel (in seconds) the host may still adopt from that guest, as of `tick`. */
  private readonly adoption: { budget: number; tick: number }[];

  constructor(
    private readonly output: HostOutput,
    readonly gates: Gate[],
    readonly myGate: number,
    private readonly options: HostOptions = {},
  ) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.now = options.now ?? (() => performance.now());
    const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!;
    this.state = options.state ?? { ...createGame(gates.length, seed, this.config), respawnTicks: COUNTDOWN_SECONDS * TICK_RATE };
    this.prev = this.state;
    this.inputs = gates.map(() => 0);
    this.adoption = gates.map(() => ({ budget: ADOPT_BURST_SECONDS, tick: 0 }));
    this.scores = [...this.state.scores];
    this.goals = this.state.goals;
    // Pending goals are timed in state ticks, so count from the same place.
    this.ticksRun = this.state.tick;
  }

  start(): void {
    this.nextTickAt = this.now();
    this.lastTickAt = this.nextTickAt;
    this.output.sendState(encodeState(this.official(this.state)));
    this.stopTicker = (this.options.ticker ?? workerTicker)(() => this.advance());
  }

  stop(): void {
    this.stopTicker?.();
    this.stopTicker = undefined;
  }

  isOver(): boolean {
    return this.over;
  }

  setOwnInput(dir: Dir): void {
    if (this.myGate >= 0) this.inputs[this.myGate] = dir;
  }

  /**
   * A player's input, by seat.  If it says where their paddle is, take their
   * word for it (kept inside their gate): the player's screen is the truth
   * for their own paddle, and the host's copy would otherwise run on past
   * where they stopped by however long the message took.  But only so far:
   * no more than an honest network delay's worth of travel (see
   * ADOPT_BURST_SECONDS), so a modified client can't teleport its paddle.
   */
  applyInput(seat: number, dir: Dir, paddle?: number): void {
    const gate = this.gates.findIndex((g) => g.seat === seat);
    if (gate === -1 || gate === this.myGate || this.gates[gate]!.bot) return;
    this.inputs[gate] = dir;
    if (paddle === undefined || !this.state.gates[gate]?.active) return;
    const n = this.gates.length;
    const allowance = this.adoption[gate]!;
    allowance.budget = Math.min(ADOPT_BURST_SECONDS, allowance.budget + (this.ticksRun - allowance.tick) * DT * ADOPT_REFILL);
    allowance.tick = this.ticksRun;
    const speed = this.config.paddleSpeed * 2 * gateHalfWidth(n, this.config);
    const current = this.state.gates[gate]!.paddle;
    const width = paddleWidth(this.state.gates[gate]!, this.config);
    const wanted = angleDiff(movePaddle(paddle, gate, n, 0, 0, this.config, width), current);
    const most = allowance.budget * speed;
    const moved = Math.max(-most, Math.min(most, wanted));
    allowance.budget -= Math.abs(moved) / speed;
    const placed = wrapAngle(current + moved);
    this.state = { ...this.state, gates: this.state.gates.map((g, i) => (i === gate ? { ...g, paddle: placed } : g)) };
  }

  /**
   * A guest says that on their screen, their paddle (at `paddle`) met the
   * ball at host tick `tick`.  If it's recent, plausible, and a hit when
   * replayed, rewind and make it so.  Returns whether the save stood.
   */
  claimSave(seat: number, tick: number, paddle: number, ball = 0): boolean {
    const gate = this.gates.findIndex((g) => g.seat === seat);
    if (this.over || gate === -1 || !this.claimable(gate)) return false;
    const index = this.history.findIndex((r) => r.before.tick === Math.floor(tick));
    if (index === -1) return false; // Too old, or not played yet.
    const replayed = this.history.slice(index);
    // Already a save here: nothing to do.
    if (this.history.slice(Math.max(0, index - 1), index + 2).some((r) => hitBy(r.events, gate, ball))) return false;
    // A goal since then is already official (it wasn't against a guest), so it can't be undone.
    if (replayed.some((r) => r.events.some((e) => e.type === 'goal' && !this.claimable(e.gate)))) return false;

    const n = this.gates.length;
    const slack = this.config.paddleSpeed * 2 * gateHalfWidth(n, this.config) * CLAIM_SLACK_SECONDS;
    if (Math.abs(angleDiff(paddle, replayed[0]!.before.gates[gate]!.paddle)) > slack) return false;
    const placed = movePaddle(paddle, gate, n, 0, 0, this.config, paddleWidth(replayed[0]!.before.gates[gate]!, this.config));

    // Replay with the guest's paddle where they had it for the claimed tick
    // and the next (the crossing can fall either side of a tick boundary).
    // Every other paddle moves as recorded: paddles don't depend on the ball.
    const rebuilt: TickRecord[] = [];
    let state = replayed[0]!.before;
    for (const [i, record] of replayed.entries()) {
      const claimed = i < 2;
      const gates = claimed
        ? record.before.gates.map((g, j) => (j === gate ? { ...g, paddle: placed } : g))
        : record.before.gates;
      const inputs = claimed ? record.inputs.map((d, j) => (j === gate ? 0 : d)) : record.inputs;
      const before = { ...state, gates };
      const result = step(before, inputs, this.config);
      rebuilt.push({ before, inputs, events: result.events });
      state = result.state;
    }
    if (!rebuilt.slice(0, 2).some((r) => hitBy(r.events, gate, ball))) return false;

    // The replay is the match now.  Goals in the old version are dropped
    // (they were all still pending), and any in the new one are judged anew.
    const from = replayed[0]!.before.tick;
    this.pending = this.pending.filter((goal) => goal.tick <= from);
    this.history = [...this.history.slice(0, index), ...rebuilt];
    this.prev = rebuilt.at(-1)!.before;
    this.state = state;
    for (const record of rebuilt) this.handleGoals(record.before.tick + 1, record.events);
    return true;
  }

  /** A player left for good: their gate becomes wall. */
  removePlayer(playerId: string): void {
    const gate = this.gates.findIndex((g) => g.playerId === playerId);
    if (gate === -1 || !this.state.gates[gate]?.active) return;
    this.state = setGateActive(this.state, gate, false);
    this.inputs[gate] = 0;
  }

  /** The state to draw now, blended between the last two ticks, with the official score. */
  view(): GameState {
    return this.official(interpolate(this.prev, this.state, (this.now() - this.lastTickAt) / (DT * 1000)));
  }

  /** Runs every tick that has come due.  Exposed for tests. */
  advance(): void {
    if (this.over) return;
    const now = this.now();
    let ticks = 0;
    while (this.nextTickAt <= now && !this.over) {
      if (++ticks > MAX_CATCH_UP_TICKS) {
        this.nextTickAt = now; // Too far behind (e.g. the machine slept): skip ahead.
        break;
      }
      this.tick();
      this.lastTickAt = this.nextTickAt;
      this.nextTickAt += DT * 1000;
    }
  }

  private tick(): void {
    this.ticksRun++;
    // Once the clock runs out, the ball stops, but pending goals still get
    // their window before the match ends.
    if (!this.timeUp()) {
      // Bots decide each tick from the state they see, like a player would.
      this.gates.forEach((gate, i) => {
        if (gate.bot) this.inputs[i] = botInput(this.state, i, this.config, this.options.botSkill);
      });
      const before = this.state;
      const inputs = [...this.inputs];
      const { state, events } = step(before, inputs, this.config);
      this.history.push({ before, inputs, events });
      if (this.history.length > CLAIM_WINDOW_TICKS + 2) this.history.shift();
      this.prev = before;
      this.state = state;
      this.handleGoals(state.tick, events);
    }

    // Goals against guests become official once nobody has claimed a save.
    const due = this.pending.filter((goal) => this.ticksRun - goal.tick >= CLAIM_WINDOW_TICKS);
    this.pending = this.pending.filter((goal) => !due.includes(goal));
    due.forEach((goal) => this.commit(goal));

    if (this.goals >= this.config.goalLimit || (this.timeUp() && this.pending.length === 0)) {
      this.over = true;
      this.stop();
      this.output.sendState(encodeState(this.official(this.state)));
      void this.output.send({ type: 'end', scores: [...this.scores] }).catch(() => {});
      this.options.onEnd?.([...this.scores]);
      return;
    }
    if (this.ticksRun % SNAPSHOT_EVERY === 0) this.output.sendState(encodeState(this.official(this.state)));
  }

  /** A goal against a guest waits for a possible save claim; any other is official at once. */
  private handleGoals(tick: number, events: PhysicsEvent[]): void {
    for (const event of events) {
      if (event.type !== 'goal') continue;
      const goal = { tick, gate: event.gate, scorer: event.scorer };
      if (this.claimable(event.gate)) this.pending.push(goal);
      else this.commit(goal);
    }
  }

  private commit({ gate, scorer }: PendingGoal): void {
    if (scorer >= 0) this.scores[scorer] = (this.scores[scorer] ?? 0) + 1;
    this.goals++;
    this.options.onGoal?.(gate, scorer);
    const message: RoomEvent = scorer >= 0 ? { type: 'goal', gate, scorer } : { type: 'goal', gate };
    void this.output.send(message).catch(() => {});
  }

  /** Only a guest can claim a save: not the host (who sees the truth) and not a bot. */
  private claimable(gate: number): boolean {
    return gate !== this.myGate && !this.gates[gate]?.bot && this.state.gates[gate]?.active === true;
  }

  private timeUp(): boolean {
    return this.state.tick >= this.config.matchDuration * TICK_RATE;
  }

  /** `state` with the official score in place of the physics' own count. */
  private official(state: GameState): GameState {
    return { ...state, scores: [...this.scores], goals: this.goals };
  }
}

function hitBy(events: PhysicsEvent[], gate: number, ball: number): boolean {
  return events.some((e) => e.type === 'hit' && e.gate === gate && e.ball === ball);
}
