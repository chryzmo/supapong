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

/** The ball heading for the token at (0.3, 0), and slow ones around the left half to fill the board up to maxBalls. */
function fullOfBalls(): BallState[] {
  return [
    radial(0, 2),
    ...Array.from({ length: config.maxBalls - 1 }, (_, i) => {
      const angle = Math.PI / 2 + (Math.PI * (i + 0.5)) / (config.maxBalls - 1);
      return ball(0.5 * Math.cos(angle), 0.5 * Math.sin(angle), 0, 0.01);
    }),
  ];
}

/** As many tokens as the board holds, around the left half, clear of a ball heading right from the center. */
function fullBoard(): Pickup[] {
  return Array.from({ length: config.pickupMax }, (_, i) => {
    const angle = Math.PI / 2 + (Math.PI * (i + 0.5)) / config.pickupMax;
    return token('wide', 0.5 * Math.cos(angle), 0.5 * Math.sin(angle));
  });
}

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
    expect(state.pickups).toBeUndefined();
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
    const [pickup] = state.pickups!;
    expect(events).toContainEqual({ type: 'spawn', kind: pickup!.kind });
    expect(Math.hypot(pickup!.x, pickup!.y)).toBeGreaterThanOrEqual(0.25);
    expect(Math.hypot(pickup!.x, pickup!.y)).toBeLessThanOrEqual(0.65);
    expect(pickup!.ticksLeft).toBe(seconds(20));
    expect(state.pickupTimer).toBeGreaterThanOrEqual(seconds(config.pickupMinSeconds));
    expect(state.pickupTimer).toBeLessThanOrEqual(seconds(config.pickupMaxSeconds));
  });

  it('runs the timer only while a ball is in play and the board has room', () => {
    const full = fullBoard();
    const busy = run(inPlay([ball(0, 0, 0.01, 0)], { pickupTimer: 5, pickups: full }), 3).state;
    expect(busy.pickupTimer).toBe(5);
    const room = run(inPlay([ball(0, 0, 0.01, 0)], { pickupTimer: 5, pickups: full.slice(1) }), 3).state;
    expect(room.pickupTimer).toBe(2);
    const waiting = run({ ...inPlay([ball(0, 0, 0, 0)], { pickupTimer: 5 }), respawnTicks: 30 }, 3).state;
    expect(waiting.pickupTimer).toBe(5);
    expect(run(inPlay([ball(0, 0, 0.01, 0)], { pickupTimer: 5 }), 3).state.pickupTimer).toBe(2);
  });

  it("puts one out on a ball's volley, unless the board is full", () => {
    // The ball's 5th hit so far; it's about to make the 6th, off gate 0.
    const volley = run(inPlay([radial(0, 1, 5)]), 300, (e) => e.type === 'hit');
    expect(volley.events.some((e) => e.type === 'spawn')).toBe(true);
    expect(volley.state.pickups).toHaveLength(1);

    const out = token('shield', -0.5, 0.1);
    const another = run(inPlay([radial(0, 1, 5)], { pickups: [out] }), 300, (e) => e.type === 'hit');
    expect(another.events.some((e) => e.type === 'spawn')).toBe(true);
    expect(another.state.pickups).toHaveLength(2);
    expect(another.state.pickups![0]).toMatchObject({ kind: 'shield', x: -0.5, y: 0.1 });

    const busy = run(inPlay([radial(0, 1, 5)], { pickups: fullBoard() }), 300, (e) => e.type === 'hit');
    expect(busy.events.some((e) => e.type === 'spawn')).toBe(false);
    expect(busy.state.pickups).toHaveLength(config.pickupMax);
  });

  it('keeps tokens clear of each other', () => {
    for (let seed = 0; seed < 200; seed++) {
      let state = run({ ...inPlay([ball(0, 0, 0.001, 0)]), seed, pickupTimer: 1 }, 1).state;
      state = run({ ...state, pickupTimer: 1 }, 1).state;
      state = run({ ...state, pickupTimer: 1 }, 1).state;
      const [a, b, c] = state.pickups!;
      for (const [p, q] of [[a!, b!], [a!, c!], [b!, c!]] as const) {
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(2 * config.pickupRadius);
      }
    }
  });

  it('fades a token nobody collects', () => {
    const { state } = run(inPlay([ball(0, 0, 0.01, 0)], { pickups: [{ ...token('wide', -0.5, 0), ticksLeft: 2 }, token('shield', 0.5, 0)] }), 2);
    expect(state.pickups).toEqual([{ ...token('shield', 0.5, 0), ticksLeft: seconds(10) - 2 }]);
    expect(run(state, seconds(10)).state.pickups).toBeUndefined();
  });
});

describe('collecting', () => {
  const onTheWay = token('wide', 0.3, 0);

  it("goes to the ball's last toucher", () => {
    const { state, events } = run(inPlay([radial(0, 2)], { pickups: [onTheWay] }), 60, (e) => e.type === 'pickup');
    expect(events).toContainEqual({ type: 'pickup', kind: 'wide', gate: 2, ball: 0 });
    expect(state.pickups).toBeUndefined();
    expect(state.gates[2]!.wideTicks).toBe(seconds(config.wideDuration));
  });

  it('leaves the token for a ball nobody has touched', () => {
    const { state, events } = run(inPlay([radial(0)], { pickups: [onTheWay] }), 30);
    expect(events.some((e) => e.type === 'pickup')).toBe(false);
    expect(state.pickups).toMatchObject([{ kind: 'wide', x: 0.3, y: 0 }]);
  });

  it('leaves the tokens the ball misses, and takes every one it passes through', () => {
    const elsewhere = token('shield', -0.5, 0);
    const further = token('multiball', 0.5, 0);
    const { state, events } = run(inPlay([radial(0, 2)], { pickups: [onTheWay, elsewhere, further] }), 40);
    expect(events.filter((e) => e.type === 'pickup')).toEqual([
      { type: 'pickup', kind: 'wide', gate: 2, ball: 0 },
      { type: 'pickup', kind: 'multiball', gate: 2, ball: 0 },
    ]);
    expect(state.pickups).toEqual([{ ...elsewhere, ticksLeft: elsewhere.ticksLeft - 40 }]);
  });

  it("can't be skipped by a fast ball between ticks", () => {
    const tiny = { ...config, pickupRadius: 0.001 };
    // At speed 3 the ball moves 0.05 a tick: from 0.2 to 0.25, past a token at 0.225.
    const fast = inPlay([ball(0.2, 0, 3, 0, 1)], { pickups: [token('shield', 0.225, 0)] });
    expect(run(fast, 1, undefined, tiny).events).toContainEqual({ type: 'pickup', kind: 'shield', gate: 1, ball: 0 });
  });

  it("is used up, with no effect, when the last toucher has left", () => {
    const gone = setGateActive(inPlay([radial(0, 2)], { pickups: [onTheWay] }), 2, false);
    const { state, events } = run(gone, 60, (e) => e.type === 'pickup');
    expect(events).toContainEqual({ type: 'pickup', kind: 'wide', gate: -1, ball: 0 });
    expect(state.pickups).toBeUndefined();
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

  it('splits the ball into three where it is: the old one keeps going, the new ones go at its speed', () => {
    const { state } = run(inPlay([radial(0, 2)], { pickups: [onTheWay] }), 60, (e) => e.type === 'pickup');
    expect(state.balls).toHaveLength(3);
    const [old, ...added] = state.balls;
    expect(Math.atan2(old!.vy, old!.vx)).toBeCloseTo(0);
    for (const b of added) {
      expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(Math.hypot(old!.vx, old!.vy));
      expect(b).toMatchObject({ x: old!.x, y: old!.y, lastTouch: 2 });
    }
  });

  it('sends the new balls a random way, whatever the old one was doing, the same from the same seed', () => {
    const split = (seed: number) =>
      run({ ...inPlay([radial(0, 2)], { pickups: [onTheWay] }), seed }, 60, (e) => e.type === 'pickup').state.balls.slice(1);
    expect(split(3)).toEqual(split(3));
    const headings = Array.from({ length: 100 }, (_, seed) => split(seed).map((b) => Math.atan2(b.vy, b.vx))).flat();
    // The old ball heads along +x.  New ones go every way, back toward -x too.
    expect(headings.some((h) => Math.abs(h) > (3 * Math.PI) / 4)).toBe(true);
    expect(headings.some((h) => h > Math.PI / 4 && h < (3 * Math.PI) / 4)).toBe(true);
    expect(headings.some((h) => h < -Math.PI / 4 && h > (-3 * Math.PI) / 4)).toBe(true);
  });

  it('gives a wide paddle instead when the board already has the most balls', () => {
    const full = fullOfBalls();
    const { state } = run(inPlay(full, { pickups: [onTheWay] }), 60, (e) => e.type === 'pickup');
    expect(state.balls).toHaveLength(config.maxBalls);
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

describe('only multiball', () => {
  const multi: PhysicsConfig = { ...config, multiballOnly: true };

  it('puts out nothing but multiball tokens', () => {
    let state = inPlay([ball(0, 0, 0.001, 0)]);
    const kinds = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      state = run({ ...state, seed, pickupTimer: 1 }, 1, undefined, multi).state;
      for (const p of state.pickups ?? []) kinds.add(p.kind);
      state = { ...state, pickups: [] };
    }
    expect([...kinds]).toEqual(['multiball']);
  });

  it('leaves a token on the board while the most balls are in play, instead of a wide paddle', () => {
    const full = fullOfBalls();
    const onTheWay = token('multiball', 0.3, 0);
    const { state, events } = run(inPlay(full, { pickups: [onTheWay] }), 30, undefined, multi);
    expect(events.some((e) => e.type === 'pickup')).toBe(false);
    expect(state.pickups).toMatchObject([{ kind: 'multiball', x: 0.3, y: 0 }]);
    expect(state.gates[2]!.wideTicks).toBeUndefined();
  });

  it('splits as usual when there is room', () => {
    const { state } = run(inPlay([radial(0, 2)], { pickups: [token('multiball', 0.3, 0)] }), 60, (e) => e.type === 'pickup', multi);
    expect(state.balls).toHaveLength(3);
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
    const start = inPlay([shot], { pickups: [token('wide', hitR + bx * along, by * along)] });
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
