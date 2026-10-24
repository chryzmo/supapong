// The host's side of a match: runs the physics at a fixed 60 Hz, applies
// everyone's inputs (and drives any bots), and broadcasts snapshots and events.
//
// Why host-authoritative?  One browser decides what happened, so players
// can't disagree about a goal, and the backend stays plain Supabase with no
// game server.  The cost is that the host is a single point of failure (if it
// leaves, the match ends) and could cheat; both are fine for a prototype.
import type { Gate, RoomEvent, StateMessage } from '../types';
import { botInput } from './bot';
import { interpolate } from './interpolate';
import { workerTicker, type Ticker } from './loop';
import {
  DEFAULT_CONFIG,
  DT,
  TICK_RATE,
  createGame,
  isOver,
  setGateActive,
  step,
  type Dir,
  type GameState,
  type PhysicsConfig,
} from './physics';
import { encodeState } from './snapshot';

/** Send a snapshot every this many ticks: 60 / 3 = 20 Hz. */
export const SNAPSHOT_EVERY = 3;
export const COUNTDOWN_SECONDS = 3;
/** If the host falls further behind than this, it skips ahead instead of catching up. */
const MAX_CATCH_UP_TICKS = 15;

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

  constructor(
    private readonly output: HostOutput,
    readonly gates: Gate[],
    readonly myGate: number,
    private readonly options: HostOptions = {},
  ) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.now = options.now ?? (() => performance.now());
    const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!;
    this.state = { ...createGame(gates.length, seed, this.config), respawnTicks: COUNTDOWN_SECONDS * TICK_RATE };
    this.prev = this.state;
    this.inputs = gates.map(() => 0);
  }

  start(): void {
    this.nextTickAt = this.now();
    this.lastTickAt = this.nextTickAt;
    this.output.sendState(encodeState(this.state));
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

  /** A player's input, by seat. */
  applyInput(seat: number, dir: Dir): void {
    const gate = this.gates.findIndex((g) => g.seat === seat);
    if (gate !== -1 && gate !== this.myGate && !this.gates[gate]!.bot) this.inputs[gate] = dir;
  }

  /** A player left for good: their gate becomes wall. */
  removePlayer(playerId: string): void {
    const gate = this.gates.findIndex((g) => g.playerId === playerId);
    if (gate === -1 || !this.state.gates[gate]?.active) return;
    this.state = setGateActive(this.state, gate, false);
    this.inputs[gate] = 0;
  }

  /** The state to draw now, blended between the last two ticks. */
  view(): GameState {
    return interpolate(this.prev, this.state, (this.now() - this.lastTickAt) / (DT * 1000));
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
    // Bots decide each tick from the state they see, like a player would.
    this.gates.forEach((gate, i) => {
      if (gate.bot) this.inputs[i] = botInput(this.state, i, this.config, this.options.botSkill);
    });
    const { state, events } = step(this.state, this.inputs, this.config);
    this.prev = this.state;
    this.state = state;

    for (const event of events) {
      if (event.type !== 'goal') continue;
      this.options.onGoal?.(event.gate, event.scorer);
      const message: RoomEvent = event.scorer >= 0 ? { type: 'goal', gate: event.gate, scorer: event.scorer } : { type: 'goal', gate: event.gate };
      void this.output.send(message).catch(() => {});
    }

    if (isOver(state, this.config)) {
      this.over = true;
      this.stop();
      this.output.sendState(encodeState(state));
      void this.output.send({ type: 'end', scores: state.scores }).catch(() => {});
      this.options.onEnd?.(state.scores);
      return;
    }
    if (state.tick % SNAPSHOT_EVERY === 0) this.output.sendState(encodeState(state));
  }
}
