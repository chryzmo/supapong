// Turning game states into `state` messages and back, and buffering them on
// the client for smooth drawing.  Pure apart from the timestamps passed in.
import type { StateMessage } from '../types';
import { interpolate } from './interpolate';
import { DT, type GameState } from './physics';

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
    respawn: state.respawnTicks,
    rally: state.rally,
  };
}

/** The client-side view of a snapshot.  The PRNG seed stays with the host. */
export function decodeState(message: StateMessage): GameState {
  const [x, y, vx, vy] = message.ball;
  return {
    tick: message.tick,
    ball: { x, y, vx, vy },
    gates: message.paddles.map((paddle, i) => ({ paddle, active: message.active[i] ?? false })),
    scores: [...message.scores],
    goals: message.goals,
    respawnTicks: message.respawn,
    rally: message.rally,
    seed: 0,
  };
}

/**
 * Recent snapshots, sampled at "now minus INTERP_DELAY_MS" in host time.
 *
 * Host time is estimated from arrivals: each snapshot says which tick it is,
 * so arrival time minus tick time gives the offset between the two clocks
 * plus network delay.  We keep the smallest offset seen (the least-delayed
 * arrival), and let it drift up slowly in case the delay really grows.
 */
export class SnapshotBuffer {
  private snapshots: GameState[] = [];
  private offsetMs: number | undefined;

  push(state: GameState, arrivalMs: number): void {
    const last = this.snapshots.at(-1);
    if (last && state.tick <= last.tick) return; // Late or duplicate.
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
      if (a.tick <= renderTick) return interpolate(a, b, (renderTick - a.tick) / (b.tick - a.tick));
    }
    return first;
  }
}
