// Turning game states into `state` messages and back, and buffering them on
// the client for smooth drawing.  Pure apart from the timestamps passed in.
import type { StateMessage } from '../types';
import { interpolate } from './interpolate';
import { DEFAULT_CONFIG, DT, PICKUP_KINDS, step, type Dir, type GameState, type PhysicsConfig } from './physics';

const TICK_MS = DT * 1000;

/** How far behind the host clients draw.  Two snapshots at 20 Hz, so there's usually one on each side. */
export const INTERP_DELAY_MS = 100;
/**
 * When a snapshot is late, how far past the newest one the physics may run
 * on (150 ms), instead of freezing the picture until it arrives.
 */
export const MAX_EXTRAPOLATE_TICKS = 9;
/** The drawing clock runs at most this much fast or slow while catching up with its estimate of host time. */
const CLOCK_SLEW = 0.05;
/** An estimate this far off (say, after the tab was hidden) is jumped to rather than eased toward. */
const CLOCK_SNAP_MS = 250;

/** Rounds to 4 decimal places: about 1/10000 of the board, invisible on screen, and much shorter JSON. */
const round = (v: number): number => Math.round(v * 1e4) / 1e4;

export function encodeState(state: GameState): StateMessage {
  return {
    tick: state.tick,
    balls: state.balls.map((b) => [round(b.x), round(b.y), round(b.vx), round(b.vy), b.lastTouch, b.rally]),
    paddles: state.gates.map((g) => round(g.paddle)),
    active: state.gates.map((g) => g.active),
    scores: [...state.scores],
    goals: state.goals,
    seed: state.seed,
    respawn: state.respawnTicks,
    ...encodePowerUps(state),
  };
}

/** The power-up fields of a snapshot, leaving out any with nothing to say. */
function encodePowerUps(state: GameState): Partial<StateMessage> {
  const { pickups, pickupTimer } = state;
  const wide = state.gates.map((g) => g.wideTicks ?? 0);
  const shield = state.gates.map((g) => g.shieldTicks ?? 0);
  return {
    ...(pickups?.length ? { pickups: pickups.map((p) => [PICKUP_KINDS.indexOf(p.kind), round(p.x), round(p.y), p.ticksLeft]) } : {}),
    ...(pickupTimer !== undefined ? { timer: pickupTimer } : {}),
    ...(wide.some((t) => t > 0) ? { wide } : {}),
    ...(shield.some((t) => t > 0) ? { shield } : {}),
  };
}

/**
 * The client-side view of a snapshot.  The seed lets the client replay the
 * physics between snapshots (see SnapshotBuffer); a host on the previous
 * version doesn't send one.
 */
export function decodeState(message: StateMessage): GameState {
  return {
    tick: message.tick,
    balls: message.balls.map(([x, y, vx, vy, lastTouch, rally]) => ({ x, y, vx, vy, lastTouch, rally })),
    gates: message.paddles.map((paddle, i) => {
      const wideTicks = message.wide?.[i] ?? 0;
      const shieldTicks = message.shield?.[i] ?? 0;
      return {
        paddle,
        active: message.active[i] ?? false,
        ...(wideTicks > 0 ? { wideTicks } : {}),
        ...(shieldTicks > 0 ? { shieldTicks } : {}),
      };
    }),
    scores: [...message.scores],
    goals: message.goals,
    respawnTicks: message.respawn,
    seed: message.seed ?? 0,
    ...(message.pickups
      ? { pickups: message.pickups.map(([kind, x, y, ticksLeft]) => ({ kind: PICKUP_KINDS[kind] ?? 'wide', x, y, ticksLeft })) }
      : {}),
    ...(message.timer !== undefined ? { pickupTimer: message.timer } : {}),
  };
}

/**
 * `state` with the paddles from `gates`, but its own power-up effects.  The
 * replay takes paddles from the snapshots (it has no inputs), while the
 * physics works out the effects: a shield that breaks between two snapshots
 * has to stay up until the ball reaches it.
 */
function withPaddles(state: GameState, gates: GameState['gates']): GameState {
  return {
    ...state,
    gates: state.gates.map((g, i) => {
      const from = gates[i];
      return from ? { ...g, paddle: from.paddle, active: from.active } : g;
    }),
  };
}

/**
 * Recent snapshots, sampled at "now minus INTERP_DELAY_MS" in host time.
 *
 * Host time is estimated from arrivals: each snapshot says which tick it is,
 * so arrival time minus tick time gives the offset between the two clocks
 * plus network delay.  We keep the smallest offset seen (the least-delayed
 * arrival), and let it drift up slowly in case the delay really grows.  The
 * drawing clock eases toward that estimate (CLOCK_SLEW) rather than jumping,
 * which would skip the picture forward each time a quicker arrival lowers it.
 *
 * If the next snapshot is late, the physics runs on from the newest one for
 * up to MAX_EXTRAPOLATE_TICKS, with paddles held where they were, instead of
 * freezing and then jumping when it arrives.
 *
 * Between two snapshots the ball is replayed with the real physics rather
 * than drawn along a straight line.  Snapshots are 3 ticks apart, and a fast
 * ball covers several ball widths in that time, so a straight line cut the
 * corner at every bounce and the ball never visibly reached the paddle or rim.
 */
export class SnapshotBuffer {
  private snapshots: GameState[] = [];
  /** Where the arrivals say the clock offset is. */
  private targetOffsetMs: number | undefined;
  /** The offset we draw with, easing toward the target. */
  private offsetMs: number | undefined;
  private clockAt: number | undefined;
  /** False once a snapshot arrives without a seed: those get the straight-line blend. */
  private replayable = true;

  constructor(private readonly config: PhysicsConfig = DEFAULT_CONFIG) {}

  /** @param replayable False for a snapshot without the host's seed. */
  push(state: GameState, arrivalMs: number, replayable = true): void {
    const last = this.snapshots.at(-1);
    if (last && state.tick <= last.tick) return; // Late or duplicate.
    this.replayable &&= replayable;
    const sample = arrivalMs - state.tick * TICK_MS;
    const target = this.targetOffsetMs;
    this.targetOffsetMs = target === undefined || sample < target ? sample : target + (sample - target) * 0.05;
    this.snapshots.push(state);
    if (this.snapshots.length > 30) this.snapshots.shift();
  }

  latest(): GameState | undefined {
    return this.snapshots.at(-1);
  }

  /**
   * The host tick sample(nowMs) shows, fractional, kept between the oldest
   * buffered snapshot and as far past the newest as we'll run on.  Undefined
   * before the first snapshot.
   */
  renderTick(nowMs: number): number | undefined {
    const first = this.snapshots[0];
    const last = this.snapshots.at(-1);
    const offset = this.offsetAt(nowMs);
    if (!first || !last || offset === undefined) return undefined;
    const tick = (nowMs - INTERP_DELAY_MS - offset) / TICK_MS;
    return Math.max(first.tick, Math.min(last.tick + (this.replayable ? MAX_EXTRAPOLATE_TICKS : 0), tick));
  }

  /** The drawing clock's offset at `nowMs`, eased toward the arrivals' estimate since the last call. */
  private offsetAt(nowMs: number): number | undefined {
    const target = this.targetOffsetMs;
    if (target === undefined) return undefined;
    if (this.offsetMs === undefined || this.clockAt === undefined) {
      this.offsetMs = target;
    } else if (nowMs > this.clockAt) {
      const gap = target - this.offsetMs;
      const most = CLOCK_SLEW * (nowMs - this.clockAt);
      this.offsetMs = Math.abs(gap) > CLOCK_SNAP_MS ? target : this.offsetMs + Math.max(-most, Math.min(most, gap));
    }
    this.clockAt = Math.max(this.clockAt ?? nowMs, nowMs);
    return this.offsetMs;
  }

  /** The state to draw at local time `nowMs`, or undefined before the first snapshot. */
  sample(nowMs: number): GameState | undefined {
    const first = this.snapshots[0];
    const last = this.snapshots.at(-1);
    const renderTick = this.renderTick(nowMs);
    if (!first || !last || renderTick === undefined) return undefined;

    if (renderTick <= first.tick) return first;
    if (renderTick >= last.tick) return this.replayable ? this.runOn(last, renderTick) : last;

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
   * Like sample(), but as if `gate`'s paddle were at `paddle` for the tick
   * `tick` falls in and the next: what the host will show if it accepts
   * that save claim (HostGame.claimSave does the same replay).  Steps the
   * physics on from the last snapshot before the claim, with every other
   * paddle as the snapshots have it, since paddles don't depend on the ball.
   */
  sampleWithSave(nowMs: number, gate: number, tick: number, paddle: number): GameState | undefined {
    const renderTick = this.renderTick(nowMs);
    const from = Math.floor(tick);
    let base: GameState | undefined;
    for (const snapshot of this.snapshots) if (snapshot.tick <= from) base = snapshot;
    if (renderTick === undefined || renderTick < tick || !base) return this.sample(nowMs);
    const still: Dir[] = base.gates.map(() => 0);
    const advance = (s: GameState): GameState => {
      // The claimed tick and the next, as on the host.
      const claimed = s.tick === from || s.tick === from + 1;
      const gates = this.paddlesAt(s.tick + 1).map((g, i) => (claimed && i === gate ? { ...g, paddle } : g));
      return step(withPaddles(s, gates), still, this.config).state;
    };
    let s = base;
    while (s.tick + 1 <= renderTick) s = advance(s);
    return interpolate(s, advance(s), renderTick - s.tick);
  }

  /** The newest snapshot run on to `renderTick` (a late snapshot), paddles held. */
  private runOn(last: GameState, renderTick: number): GameState {
    const still: Dir[] = last.gates.map(() => 0);
    const advance = (s: GameState): GameState => step(withPaddles(s, last.gates), still, this.config).state;
    let s = last;
    while (s.tick + 1 <= renderTick) s = advance(s);
    return renderTick === s.tick ? s : interpolate(s, advance(s), renderTick - s.tick);
  }

  /** The paddles as the snapshots have them at `tick`, blended, or held past the ends. */
  private paddlesAt(tick: number): GameState['gates'] {
    const after = this.snapshots.findIndex((s) => s.tick >= tick);
    if (after === -1) return this.snapshots.at(-1)!.gates;
    const b = this.snapshots[after]!;
    const a = this.snapshots[after - 1];
    if (!a || b.tick === tick) return b.gates;
    return interpolate(a, b, (tick - a.tick) / (b.tick - a.tick)).gates;
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
      return step(withPaddles(s, gates), still, this.config).state;
    };
    let s = a;
    while (s.tick + 1 <= renderTick) s = advance(s);
    const next = s.tick + 1 >= b.tick ? b : advance(s);
    return interpolate(s, next, renderTick - s.tick);
  }
}
