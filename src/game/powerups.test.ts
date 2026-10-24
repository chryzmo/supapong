import { describe, expect, it } from 'vitest';
import { botInput } from './bot';
import {
  DEFAULT_CONFIG,
  TICK_RATE,
  createGame,
  isOver,
  paddleBounce,
  paddleReach,
  setGateActive,
  step,
  type BallState,
  type Dir,
  type GameState,
  type PhysicsConfig,
  type PhysicsEvent,
  type Pickup,
} from './physics';

const config: PhysicsConfig = { ...DEFAULT_CONFIG, powerUps: true };
const seconds = (s: number) => Math.round(s * TICK_RATE);

function ball(x: number, y: number, vx: number, vy: number, lastTouch = -1, rally = 0): BallState {
  return { x, y, vx, vy, lastTouch, rally };
}

/** Four gates, balls in play, and a timer that won't go off unless a test says so. */
function inPlay(balls: BallState[], extra: Partial<GameState> = {}): GameState {
  return { ...createGame(4, 1, config), respawnTicks: 0, balls, pickupTimer: seconds(60), ...extra };
}

/** A ball heading straight out from the center at `angle`. */
const radial = (angle: number, lastTouch = -1, rally = 0) =>
  ball(0, 0, Math.cos(angle) * config.launchSpeed, Math.sin(angle) * config.launchSpeed, lastTouch, rally);

const token = (kind: Pickup['kind'], x: number, y: number): Pickup => ({ kind, x, y, ticksLeft: seconds(10) });

function run(state: GameState, ticks: number, until?: (e: PhysicsEvent) => boolean, c: PhysicsConfig = config) {
  const events: PhysicsEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const result = step(state, [], c);
    state = result.state;
    events.push(...result.events);
    if (until && result.events.some(until)) break;
  }
  return { state, events };
}

const withGate = (state: GameState, gate: number, changes: Partial<GameState['gates'][number]>): GameState => ({
  ...state,
  gates: state.gates.map((g, i) => (i === gate ? { ...g, ...changes } : g)),
});

describe('power-ups', () => {
  it('stay off unless the config turns them on', () => {
    let state = createGame(4, 7, DEFAULT_CONFIG);
    for (let t = 0; t < seconds(60); t++) {
      const result = step(state, state.gates.map((_, i) => botInput(state, i, DEFAULT_CONFIG, 0.9)), DEFAULT_CONFIG);
      state = result.state;
      expect(result.events.some((e) => e.type === 'spawn')).toBe(false);
    }
    expect(state.pickup).toBeUndefined();
  });

  it('play out the same way from the same seed', () => {
    const play = () => {
      let state = createGame(4, 11, config);
      let spawns = 0;
      for (let t = 0; t < seconds(60); t++) {
        const inputs: Dir[] = state.gates.map((_, i) => botInput(state, i, config, 0.9));
        const result = step(state, inputs, config);
        state = result.state;
        spawns += result.events.filter((e) => e.type === 'spawn').length;
      }
      return { state, spawns };
    };
    const a = play();
    expect(a.spawns).toBeGreaterThan(2);
    expect(play()).toEqual(a);
  });
});

describe('spawning', () => {
  it('puts a token out when the timer runs out, and rolls a new timer', () => {
    const { state, events } = run(inPlay([ball(0, 0, 0.01, 0)], { pickupTimer: 1 }), 1);
    expect(events).toContainEqual({ type: 'spawn', kind: state.pickup!.kind });
    expect(Math.hypot(state.pickup!.x, state.pickup!.y)).toBeGreaterThanOrEqual(0.25);
    expect(Math.hypot(state.pickup!.x, state.pickup!.y)).toBeLessThanOrEqual(0.65);
    expect(state.pickupTimer).toBeGreaterThanOrEqual(seconds(config.pickupMinSeconds));
    expect(state.pickupTimer).toBeLessThanOrEqual(seconds(config.pickupMaxSeconds));
  });

  it('runs the timer only while a ball is in play and the board is empty', () => {
    const busy = run(inPlay([ball(0, 0, 0.01, 0)], { pickupTimer: 5, pickup: token('wide', -0.5, 0) }), 3).state;
    expect(busy.pickupTimer).toBe(5);
    const waiting = run({ ...inPlay([ball(0, 0, 0, 0)], { pickupTimer: 5 }), respawnTicks: 30 }, 3).state;
    expect(waiting.pickupTimer).toBe(5);
    expect(run(inPlay([ball(0, 0, 0.01, 0)], { pickupTimer: 5 }), 3).state.pickupTimer).toBe(2);
  });

  it("puts one out on a ball's volley, unless one is already out", () => {
    // The ball's 5th hit so far; it's about to make the 6th, off gate 0.
    const volley = run(inPlay([radial(0, 1, 5)]), 300, (e) => e.type === 'hit');
    expect(volley.events.some((e) => e.type === 'spawn')).toBe(true);
    expect(volley.state.pickup).toBeDefined();

    const out = token('shield', -0.5, 0.1);
    const busy = run(inPlay([radial(0, 1, 5)], { pickup: out }), 300, (e) => e.type === 'hit');
    expect(busy.events.some((e) => e.type === 'spawn')).toBe(false);
    expect(busy.state.pickup).toMatchObject({ kind: 'shield', x: -0.5, y: 0.1 });
  });

  it('fades a token nobody collects', () => {
    const { state } = run(inPlay([ball(0, 0, 0.01, 0)], { pickup: { ...token('wide', -0.5, 0), ticksLeft: 2 } }), 2);
    expect(state.pickup).toBeUndefined();
  });
});

describe('collecting', () => {
  const onTheWay = token('wide', 0.3, 0);

  it("goes to the ball's last toucher", () => {
    const { state, events } = run(inPlay([radial(0, 2)], { pickup: onTheWay }), 60, (e) => e.type === 'pickup');
    expect(events).toContainEqual({ type: 'pickup', kind: 'wide', gate: 2, ball: 0 });
    expect(state.pickup).toBeUndefined();
    expect(state.gates[2]!.wideTicks).toBe(seconds(config.wideDuration));
  });

  it('leaves the token for a ball nobody has touched', () => {
    const { state, events } = run(inPlay([radial(0)], { pickup: onTheWay }), 30);
    expect(events.some((e) => e.type === 'pickup')).toBe(false);
    expect(state.pickup).toMatchObject({ kind: 'wide', x: 0.3, y: 0 });
  });

  it("can't be skipped by a fast ball between ticks", () => {
    const tiny = { ...config, pickupRadius: 0.001 };
    // At speed 3 the ball moves 0.05 a tick: from 0.2 to 0.25, past a token at 0.225.
    const fast = inPlay([ball(0.2, 0, 3, 0, 1)], { pickup: token('shield', 0.225, 0) });
    expect(run(fast, 1, undefined, tiny).events).toContainEqual({ type: 'pickup', kind: 'shield', gate: 1, ball: 0 });
  });

  it("is used up, with no effect, when the last toucher has left", () => {
    const gone = setGateActive(inPlay([radial(0, 2)], { pickup: onTheWay }), 2, false);
    const { state, events } = run(gone, 60, (e) => e.type === 'pickup');
    expect(events).toContainEqual({ type: 'pickup', kind: 'wide', gate: -1, ball: 0 });
    expect(state.pickup).toBeUndefined();
    expect(state.gates[2]!.wideTicks).toBeUndefined();
  });
});

describe('wide paddle', () => {
  // Just past a normal paddle's reach, well within a wide one's.
  const edge = paddleReach(4, config) * 1.15;

  it('saves a ball a normal paddle misses', () => {
    const normal = run(inPlay([radial(edge, 1)]), 300, (e) => e.type === 'goal' || e.type === 'hit');
    expect(normal.events.at(-1)?.type).toBe('goal');
    const wide = run(withGate(inPlay([radial(edge, 1)]), 0, { wideTicks: seconds(8) }), 300, (e) => e.type === 'goal' || e.type === 'hit');
    expect(wide.events.at(-1)).toEqual({ type: 'hit', gate: 0, ball: 0 });
  });

  it('wears off', () => {
    const { state } = run(withGate(inPlay([ball(0, 0, 0.01, 0)]), 0, { wideTicks: 2 }), 2);
    expect(state.gates[0]!.wideTicks).toBeUndefined();
  });
});

describe('shield', () => {
  // Into gate 0, past its paddle.
  const pastPaddle = paddleReach(4, config) * 1.5;

  it('turns one ball away from the gate, then breaks', () => {
    const shielded = withGate(inPlay([radial(pastPaddle, 1)]), 0, { shieldTicks: seconds(15) });
    const { state, events } = run(shielded, 300, (e) => e.type === 'shield');
    expect(events).toContainEqual({ type: 'shield', gate: 0, ball: 0 });
    expect(events.some((e) => e.type === 'goal')).toBe(false);
    expect(state.gates[0]!.shieldTicks).toBeUndefined();
    const b = state.balls[0]!;
    expect(b.x * b.vx + b.y * b.vy).toBeLessThan(0); // Heading back in.

    const next = run({ ...state, balls: [radial(pastPaddle, 1)] }, 300, (e) => e.type === 'goal');
    expect(next.events.at(-1)).toMatchObject({ type: 'goal', gate: 0 });
  });

  it("doesn't score or count toward the limit", () => {
    const shielded = withGate(inPlay([radial(pastPaddle, 1)]), 0, { shieldTicks: seconds(15) });
    const { state } = run(shielded, 300, (e) => e.type === 'shield');
    expect(state.goals).toBe(0);
    expect(state.scores).toEqual([0, 0, 0, 0]);
  });
});

describe('multiball', () => {
  const onTheWay = token('multiball', 0.3, 0);

  it('splits the ball into three, heading 20° apart', () => {
    const { state } = run(inPlay([radial(0, 2)], { pickup: onTheWay }), 60, (e) => e.type === 'pickup');
    expect(state.balls).toHaveLength(3);
    const headings = state.balls.map((b) => Math.atan2(b.vy, b.vx));
    expect(headings[1]! - headings[0]!).toBeCloseTo((20 * Math.PI) / 180);
    expect(headings[2]! - headings[0]!).toBeCloseTo((-20 * Math.PI) / 180);
    expect(state.balls.every((b) => b.lastTouch === 2 && b.x === state.balls[0]!.x)).toBe(true);
  });

  it('gives a wide paddle instead when the board already has the most balls', () => {
    const full = [radial(0, 2), ball(-0.5, 0, 0, 0.01), ball(0, -0.5, 0.01, 0)];
    const { state } = run(inPlay(full, { pickup: onTheWay }), 60, (e) => e.type === 'pickup');
    expect(state.balls).toHaveLength(3);
    expect(state.gates[2]!.wideTicks).toBe(seconds(config.wideDuration));
  });

  it('counts every ball that goes in, and the match ends at the limit with balls still in play', () => {
    const limit = { ...config, goalLimit: 1 };
    const pastPaddle = paddleReach(4, config) * 1.5;
    const { state } = run(inPlay([radial(pastPaddle, 1), ball(0, 0, 0, 0.01)]), 300, (e) => e.type === 'goal', limit);
    expect(state.goals).toBe(1);
    expect(state.balls).toHaveLength(1);
    expect(isOver(state, limit)).toBe(true);
  });
});

describe('bots', () => {
  it('aim their returns through a token at Hard, and not below it', () => {
    // A ball straight at gate 0.  Put a token where the return goes when met
    // well off the paddle's center: a bot meeting it as usual would miss it.
    const hitR = config.paddleRadius - config.ballRadius;
    const shot = radial(0, 1);
    const [bx, by] = paddleBounce(hitR, 0, shot.vx, shot.vy, 0.6, config);
    const along = 0.45 / Math.hypot(bx, by);
    const start = inPlay([shot], { pickup: token('wide', hitR + bx * along, by * along) });
    const play = (skill: number) => {
      let state = start;
      for (let t = 0; t < seconds(3); t++) {
        const inputs: Dir[] = state.gates.map((_, i) => (i === 0 ? botInput(state, 0, config, skill) : 0));
        const result = step(state, inputs, config);
        state = result.state;
        const got = result.events.find((e) => e.type === 'pickup');
        if (got) return got;
      }
      return undefined;
    };
    expect(play(0.9)).toEqual({ type: 'pickup', kind: 'wide', gate: 0, ball: 0 });
    expect(play(0.6)).toBeUndefined();
  });
});
