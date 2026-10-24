// Turning game states into `state` messages and back, and buffering them on
// the client for smooth drawing.  Pure apart from the timestamps passed in.
import type { StateMessage } from '../types';
import { interpolate } from './interpolate';
import { DEFAULT_CONFIG, DT, step, type Dir, type GameState, type PhysicsConfig } from './physics';

const TICK_MS = DT * 1000;

/** How far behind the host clients draw.  Two snapshots at 20 Hz, so there's usually one on each side. */
export const INTERP_DELAY_MS = 100;

/** Rounds to 4 decimal places: about 1/10000 of the board, invisible on screen, and much shorter JSON. */
const round = (v: number): number => Math.round(v * 1e4) / 1e4;

export function encodeState(state: GameState): StateMessage {
  const { x, y, vx, vy } = state.ball;
  return {
    tick: state.tick,
    ball: [round(x), round(y), round(vx), round(vy)],
    paddles: state.gates.map((g) => round(g.paddle)),
    active: state.gates.map((g) => g.active),
    scores: [...state.scores],
    goals: state.goals,
    touch: state.lastTouch,
    seed: state.seed,
    respawn: state.respawnTicks,
    rally: state.rally,
  };
}

/**
 * The client-side view of a snapshot.  The seed lets the client replay the
 * physics between snapshots (see SnapshotBuffer); a host on the previous
 * version doesn't send one.
 */
export function decodeState(message: StateMessage): GameState {
  const [x, y, vx, vy] = message.ball;
  return {
    tick: message.tick,
    ball: { x, y, vx, vy },
    gates: message.paddles.map((paddle, i) => ({ paddle, active: message.active[i] ?? false })),
    scores: [...message.scores],
    goals: message.goals,
    lastTouch: message.touch,
    respawnTicks: message.respawn,
    rally: message.rally,
    seed: message.seed ?? 0,
  };
}

/**
 * Recent snapshots, sampled at "now minus INTERP_DELAY_MS" in host time.
 *
 * Host time is estimated from arrivals: each snapshot says which tick it is,
 * so arrival time minus tick time gives the offset between the two clocks
 * plus network delay.  We keep the smallest offset seen (the least-delayed
 * arrival), and let it drift up slowly in case the delay really grows.
 *
 * Between two snapshots the ball is replayed with the real physics rather
 * than drawn along a straight line.  Snapshots are 3 ticks apart, and a fast
 * ball covers several ball widths in that time, so a straight line cut the
 * corner at every bounce and the ball never visibly reached the paddle or rim.
 */
export class SnapshotBuffer {
  private snapshots: GameState[] = [];
  private offsetMs: number | undefined;
  /** False once a snapshot arrives without a seed: those get the straight-line blend. */
  private replayable = true;

  constructor(private readonly config: PhysicsConfig = DEFAULT_CONFIG) {}

  /** @param replayable False for a snapshot without the host's seed. */
  push(state: GameState, arrivalMs: number, replayable = true): void {
    const last = this.snapshots.at(-1);
    if (last && state.tick <= last.tick) return; // Late or duplicate.
    this.replayable &&= replayable;
    const sample = arrivalMs - state.tick * TICK_MS;
    this.offsetMs =
      this.offsetMs === undefined || sample < this.offsetMs ? sample : this.offsetMs + (sample - this.offsetMs) * 0.05;
    this.snapshots.push(state);
    if (this.snapshots.length > 30) this.snapshots.shift();
  }

  latest(): GameState | undefined {
    return this.snapshots.at(-1);
  }

  /** The state to draw at local time `nowMs`, or undefined before the first snapshot. */
  sample(nowMs: number): GameState | undefined {
    const first = this.snapshots[0];
    const last = this.snapshots.at(-1);
    if (!first || !last || this.offsetMs === undefined) return undefined;

    const renderTick = (nowMs - INTERP_DELAY_MS - this.offsetMs) / TICK_MS;
    if (renderTick <= first.tick) return first;
    // No extrapolation: if snapshots stop, hold the last one.
    if (renderTick >= last.tick) return last;

    for (let i = this.snapshots.length - 1; i > 0; i--) {
      const a = this.snapshots[i - 1]!;
      const b = this.snapshots[i]!;
      if (a.tick <= renderTick) {
        return this.replayable ? this.replay(a, b, renderTick) : interpolate(a, b, (renderTick - a.tick) / (b.tick - a.tick));
      }
    }
    return first;
  }

  /**
   * The state at fractional `renderTick`, between snapshots a and b: step the
   * physics on from a, with paddles blended between the two snapshots, then
   * blend the last two ticks.  The final tick blends into b itself, so a
   * small difference from the host (rounding, a paddle edge) never shows as
   * a jump when b takes over.
   */
  private replay(a: GameState, b: GameState, renderTick: number): GameState {
    const span = b.tick - a.tick;
    const still: Dir[] = a.gates.map(() => 0);
    const advance = (s: GameState): GameState => {
      const gates = interpolate(a, b, (s.tick + 1 - a.tick) / span).gates;
      return step({ ...s, gates }, still, this.config).state;
    };
    let s = a;
    while (s.tick + 1 <= renderTick) s = advance(s);
    const next = s.tick + 1 >= b.tick ? b : advance(s);
    return interpolate(s, next, renderTick - s.tick);
  }
}
