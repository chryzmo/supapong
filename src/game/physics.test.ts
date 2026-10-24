import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  TICK_RATE,
  angleDiff,
  ballSpeed,
  createGame,
  exitTime,
  gateAt,
  gateCenter,
  gateHalfWidth,
  isOver,
  launchAngle,
  nextRandom,
  paddleHalfWidth,
  paddleTravel,
  setGateActive,
  step,
  wrapAngle,
  type Dir,
  type GameState,
  type PhysicsConfig,
  type PhysicsEvent,
} from './physics';

const config: PhysicsConfig = { ...DEFAULT_CONFIG };

/** A game with the ball already in play at (x, y) moving at (vx, vy). */
function inPlay(gateCount: number, x: number, y: number, vx: number, vy: number): GameState {
  return { ...createGame(gateCount, 1, config), respawnTicks: 0, ball: { x, y, vx, vy } };
}

/** Runs ticks until `until` returns true or `max` ticks pass, collecting events. */
function run(state: GameState, inputs: Dir[], max: number, until?: (e: PhysicsEvent) => boolean) {
  const events: PhysicsEvent[] = [];
  for (let i = 0; i < max; i++) {
    const result = step(state, inputs, config);
    state = result.state;
    events.push(...result.events);
    if (until && result.events.some(until)) break;
  }
  return { state, events };
}

/** A ball heading straight out from the center at `angle`. */
function radialShot(gateCount: number, angle: number, speed = config.launchSpeed): GameState {
  return inPlay(gateCount, 0, 0, Math.cos(angle) * speed, Math.sin(angle) * speed);
}

describe('angles', () => {
  it('wraps to (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });

  it('takes the short way round', () => {
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(0.2);
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(-0.2);
  });
});

describe('geometry', () => {
  it('spaces gates evenly, starting at angle 0', () => {
    expect(gateCenter(0, 4)).toBeCloseTo(0);
    expect(gateCenter(1, 4)).toBeCloseTo(Math.PI / 2);
    expect(gateCenter(2, 4)).toBeCloseTo(Math.PI);
    expect(gateCenter(3, 4)).toBeCloseTo(-Math.PI / 2);
  });

  it('makes each gate the configured share of its sector', () => {
    for (const n of [2, 3, 8]) {
      expect(2 * gateHalfWidth(n, config)).toBeCloseTo(config.gateFraction * (2 * Math.PI / n));
      expect(paddleHalfWidth(n, config)).toBeCloseTo(gateHalfWidth(n, config) * config.paddleFraction);
      expect(paddleTravel(n, config) + paddleHalfWidth(n, config)).toBeCloseTo(gateHalfWidth(n, config));
    }
  });

  it('finds which gate an angle falls in, skipping walls and inactive gates', () => {
    const { gates } = createGame(4, 1, config);
    const half = gateHalfWidth(4, config);
    expect(gateAt(0, gates, config)).toBe(0);
    expect(gateAt(Math.PI / 2 + half * 0.99, gates, config)).toBe(1);
    expect(gateAt(Math.PI / 4, gates, config)).toBe(-1);
    expect(gateAt(Math.PI, setGateActive(createGame(4, 1, config), 2, false).gates, config)).toBe(-1);
  });

  it('finds when a moving point leaves a circle', () => {
    expect(exitTime(0, 0, 1, 0, 0.5)).toBeCloseTo(0.5);
    expect(exitTime(0.4, 0, -1, 0, 0.5)).toBeCloseTo(0.9);
    expect(exitTime(0, 0, 0, 0, 0.5)).toBe(Infinity);
    expect(exitTime(0.6, 0, 1, 0, 0.5)).toBe(Infinity);
  });
});

describe('randomness', () => {
  it('is deterministic and in [0, 1)', () => {
    let seed = 42;
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const [value, next] = nextRandom(seed);
      values.push(value);
      seed = next;
    }
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(nextRandom(42)).toEqual(nextRandom(42));
    expect(new Set(values).size).toBe(1000);
  });
});

describe('launch', () => {
  it('waits at the center for the respawn delay, then launches at launch speed', () => {
    let state = createGame(3, 7, config);
    const delay = Math.round(config.respawnDelay * TICK_RATE);
    for (let i = 0; i < delay - 1; i++) {
      const result = step(state, [], config);
      expect(result.events).toEqual([]);
      state = result.state;
    }
    expect(ballSpeed(state.ball)).toBe(0);
    const result = step(state, [], config);
    expect(result.events).toEqual([{ type: 'launch' }]);
    expect(ballSpeed(result.state.ball)).toBeCloseTo(config.launchSpeed);
  });

  it('aims every launch inside an active gate, never at a wall or an empty gate', () => {
    for (const n of [2, 3, 4, 5, 8]) {
      // Gate 1 is empty (its player left).
      const gates = setGateActive(createGame(n, 1, config), 1, false).gates;
      const limit = gateHalfWidth(n, config) - config.ballRadius;
      let seed = 123;
      for (let i = 0; i < 300; i++) {
        const [angle, next] = launchAngle(gates, seed, config);
        seed = next;
        const gate = gates.findIndex((_, g) => Math.abs(angleDiff(angle, gateCenter(g, n))) <= limit + 1e-12);
        expect(gate).not.toBe(-1);
        expect(gates[gate]!.active).toBe(true);
      }
    }
  });

  it('spreads launches across every active gate and both sides of each', () => {
    const { gates } = createGame(4, 1, config);
    const sides = new Set<string>();
    let seed = 9;
    for (let i = 0; i < 400; i++) {
      const [angle, next] = launchAngle(gates, seed, config);
      seed = next;
      const gate = gates.findIndex((_, g) => Math.abs(angleDiff(angle, gateCenter(g, 4))) <= gateHalfWidth(4, config));
      sides.add(`${gate}${angleDiff(angle, gateCenter(gate, 4)) > 0 ? '+' : '-'}`);
    }
    expect(sides.size).toBe(8);
  });

  it('still launches when no gate is active', () => {
    const { gates } = createGame(3, 1, config);
    const [angle] = launchAngle(gates.map((g) => ({ ...g, active: false })), 5, config);
    expect(Number.isFinite(angle)).toBe(true);
  });

  it('makes every launch reach a paddle in a gate, straight away', () => {
    const hitR = config.paddleRadius - config.ballRadius;
    const expectedTicks = Math.ceil((hitR / config.launchSpeed) * TICK_RATE);
    for (const n of [2, 4, 8]) {
      for (let seed = 0; seed < 100; seed++) {
        let state = { ...createGame(n, seed, config), respawnTicks: 1 };
        // Run until a paddle hits the ball or the ball reaches the paddle radius.
        let ticks = 0;
        let hit = false;
        while (!hit && Math.hypot(state.ball.x, state.ball.y) < hitR && ticks < 600) {
          const result = step(state, [], config);
          state = result.state;
          hit = result.events.some((e) => e.type === 'hit');
          ticks++;
        }
        expect(ticks).toBeLessThanOrEqual(expectedTicks + 2);
        if (!hit) expect(gateAt(Math.atan2(state.ball.y, state.ball.x), state.gates, config)).not.toBe(-1);
      }
    }
  });

  it('launches in a direction that depends only on the seed', () => {
    const launch = (seed: number) => run(createGame(3, seed, config), [], 200, (e) => e.type === 'launch').state.ball;
    expect(launch(1)).toEqual(launch(1));
    expect(launch(1)).not.toEqual(launch(2));
  });
});

describe('paddles', () => {
  it('move counterclockwise for +1 and clockwise for -1', () => {
    const state = createGame(4, 1, config);
    const ccw = step(state, [1], config).state.gates[0]!.paddle;
    const cw = step(state, [-1], config).state.gates[0]!.paddle;
    const perTick = config.paddleSpeed * 2 * gateHalfWidth(4, config) / TICK_RATE;
    expect(ccw).toBeCloseTo(perTick);
    expect(cw).toBeCloseTo(-perTick);
  });

  it('stay inside their own gate', () => {
    for (const dir of [1, -1] as const) {
      const { state } = run(createGame(4, 1, config), [dir, dir, dir, dir], 600);
      state.gates.forEach((gate, i) => {
        const offset = angleDiff(gate.paddle, gateCenter(i, 4));
        expect(Math.abs(offset)).toBeCloseTo(paddleTravel(4, config));
        expect(Math.sign(offset)).toBe(dir);
      });
    }
  });

  it('ignore input for inactive gates', () => {
    const state = setGateActive(createGame(4, 1, config), 1, false);
    expect(step(state, [0, 1], config).state.gates[1]).toEqual(state.gates[1]);
  });
});

describe('paddle hits', () => {
  it('send a dead-center hit straight back, a little faster', () => {
    const { state, events } = run(radialShot(4, 0), [], 300, (e) => e.type === 'hit');
    expect(events).toContainEqual({ type: 'hit', gate: 0 });
    expect(state.ball.vx).toBeLessThan(0);
    expect(state.ball.vy).toBeCloseTo(0);
    expect(ballSpeed(state.ball)).toBeCloseTo(config.launchSpeed * config.speedUpPerHit);
    expect(state.rally).toBe(1);
  });

  it('add english toward the side of the paddle that was hit', () => {
    const offset = paddleHalfWidth(4, config) * 0.8;
    const ccwSide = run(radialShot(4, offset), [], 300, (e) => e.type === 'hit').state.ball;
    const cwSide = run(radialShot(4, -offset), [], 300, (e) => e.type === 'hit').state.ball;
    // Tangent at angle ≈ 0 is +y: the counterclockwise side kicks the ball +y.
    expect(ccwSide.vy).toBeGreaterThan(0.1);
    expect(cwSide.vy).toBeLessThan(-0.1);
    expect(ccwSide.vy).toBeCloseTo(-cwSide.vy);
  });

  it('always send the ball back toward the center by at least minRadialShare', () => {
    const offset = paddleHalfWidth(4, config) * 0.99;
    const { state } = run(radialShot(4, offset), [], 300, (e) => e.type === 'hit');
    const { x, y, vx, vy } = state.ball;
    const inward = -(x * vx + y * vy) / (Math.hypot(x, y) * ballSpeed(state.ball));
    expect(inward).toBeGreaterThanOrEqual(config.minRadialShare - 1e-9);
  });

  it('speed up each hit, up to the cap', () => {
    const fast = { ...radialShot(4, 0, config.maxSpeed * 0.99) };
    const { state } = run(fast, [], 300, (e) => e.type === 'hit');
    expect(ballSpeed(state.ball)).toBeCloseTo(config.maxSpeed);
  });

  it('never let a fast ball through the paddle', () => {
    // Shots at max speed across the paddle's whole width, at many sub-tick offsets.
    const half = paddleHalfWidth(8, config);
    for (let k = 0; k < 50; k++) {
      const angle = (k / 49 - 0.5) * 2 * half * 0.95;
      const start = 0.3 + (k % 7) * 0.013;
      const state = inPlay(8, Math.cos(angle) * start, Math.sin(angle) * start, Math.cos(angle) * config.maxSpeed, Math.sin(angle) * config.maxSpeed);
      const { events } = run(state, [], 120, (e) => e.type === 'hit' || e.type === 'goal');
      expect(events.at(-1)).toEqual({ type: 'hit', gate: 0 });
    }
  });
});

describe('the rim', () => {
  // Aim inside gate 0 but outside its paddle.
  const pastPaddle = (paddleHalfWidth(4, config) + gateHalfWidth(4, config)) / 2 + paddleHalfWidth(4, config) / 2;

  it('scores a goal for the last paddle to touch the ball', () => {
    const { state, events } = run({ ...radialShot(4, pastPaddle), lastTouch: 2 }, [], 300, (e) => e.type === 'goal');
    expect(events.at(-1)).toEqual({ type: 'goal', gate: 0, scorer: 2 });
    expect(state.scores).toEqual([0, 0, 1, 0]);
    expect(state.goals).toBe(1);
    expect(state.lastTouch).toBe(-1);
    expect(state.ball).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
    expect(state.respawnTicks).toBe(Math.round(config.respawnDelay * TICK_RATE));
  });

  it.each([
    ['nobody touched it since the launch', -1, []],
    ['it was an own goal', 0, []],
    ['the last toucher has left', 2, [2]],
  ])('gives nobody the point when %s, but still counts the goal', (_label, lastTouch, gone) => {
    let start: GameState = { ...radialShot(4, pastPaddle), lastTouch };
    for (const gate of gone) start = setGateActive(start, gate, false);
    const { state, events } = run(start, [], 300, (e) => e.type === 'goal');
    expect(events.at(-1)).toEqual({ type: 'goal', gate: 0, scorer: -1 });
    expect(state.scores).toEqual([0, 0, 0, 0]);
    expect(state.goals).toBe(1);
  });

  it('remembers the last paddle hit, and forgets it at the next launch', () => {
    // Straight at gate 0's paddle, from the center.
    const hit = run(radialShot(4, 0), [], 300, (e) => e.type === 'hit');
    expect(hit.events.at(-1)).toEqual({ type: 'hit', gate: 0 });
    expect(hit.state.lastTouch).toBe(0);
    const relaunched = run({ ...createGame(4, 1, config), respawnTicks: 1, lastTouch: 3 }, [], 1);
    expect(relaunched.events).toEqual([{ type: 'launch' }]);
    expect(relaunched.state.lastTouch).toBe(-1);
  });

  it('bounces off wall without changing speed', () => {
    const { state, events } = run(radialShot(4, Math.PI / 4), [], 300, (e) => e.type === 'wall');
    expect(events.at(-1)).toEqual({ type: 'wall' });
    const { x, y, vx, vy } = state.ball;
    expect(x * vx + y * vy).toBeLessThan(0); // Heading back in.
    expect(ballSpeed(state.ball)).toBeCloseTo(config.launchSpeed);
  });

  it('keeps a plain reflection on the same diameter when jitter is off', () => {
    const still = { ...config, wallJitter: 0 };
    let state = radialShot(4, Math.PI / 4);
    for (let i = 0; i < 300; i++) {
      const result = step(state, [], still);
      state = result.state;
      if (result.events.some((e) => e.type === 'wall')) break;
    }
    const { x, y, vx, vy } = state.ball;
    expect(x * vy - y * vx).toBeCloseTo(0, 9); // Still heading through the center.
  });

  it('knocks the ball off its diameter by at most wallJitter, keeping speed and heading inward', () => {
    const turns: number[] = [];
    for (let seed = 0; seed < 200; seed++) {
      let state = { ...radialShot(4, Math.PI / 4), seed };
      let before = state.ball;
      for (let i = 0; i < 300; i++) {
        before = state.ball;
        const result = step(state, [], config);
        state = result.state;
        if (result.events.some((e) => e.type === 'wall')) break;
      }
      const { x, y, vx, vy } = state.ball;
      // A plain reflection of a radial ball sends it straight back: -v.
      const turn = Math.abs(angleDiff(Math.atan2(vy, vx), Math.atan2(-before.vy, -before.vx)));
      turns.push(turn);
      expect(turn).toBeLessThanOrEqual(config.wallJitter + 1e-9);
      expect(ballSpeed(state.ball)).toBeCloseTo(config.launchSpeed);
      expect(x * vx + y * vy).toBeLessThan(0);
    }
    // The turns are spread across the range, not all zero.
    expect(Math.max(...turns)).toBeGreaterThan(config.wallJitter * 0.8);
  });

  it('keeps a grazing ball heading inward', () => {
    // Nearly tangent to the rim, at max jitter, across many seeds.
    for (let seed = 0; seed < 200; seed++) {
      const r = 1 - config.ballRadius - 0.001;
      const angle = Math.PI / 4;
      const tangent = angle + Math.PI / 2 - 0.02;
      const start = {
        ...inPlay(4, Math.cos(angle) * r, Math.sin(angle) * r, Math.cos(tangent), Math.sin(tangent)),
        seed,
      };
      const { state } = run(start, [], 30, (e) => e.type === 'wall');
      const { x, y, vx, vy } = state.ball;
      expect(x * vx + y * vy).toBeLessThan(0);
    }
  });

  it('treats an inactive gate as wall', () => {
    const { events } = run(setGateActive(radialShot(4, Math.PI), 2, false), [], 300, (e) => e.type !== 'launch');
    expect(events.at(-1)).toEqual({ type: 'wall' });
  });
});

describe('match end', () => {
  it('ends at the time limit or the goal limit', () => {
    const state = createGame(3, 1, config);
    expect(isOver(state, config)).toBe(false);
    expect(isOver({ ...state, tick: config.matchDuration * TICK_RATE }, config)).toBe(true);
    expect(isOver({ ...state, goals: config.goalLimit }, config)).toBe(true);
  });

  it('counts goals in total, not one player reaching the limit', () => {
    const limit = { ...config, goalLimit: 10 };
    const twoPlayers = createGame(2, 1, limit);
    expect(isOver({ ...twoPlayers, scores: [9, 1], goals: 10 }, limit)).toBe(true);
    expect(isOver({ ...twoPlayers, scores: [8, 1], goals: 9 }, limit)).toBe(false);
    // With 4 players a goal is worth 3 points in total, so points alone
    // would end it far too early.
    const fourPlayers = createGame(4, 1, limit);
    expect(isOver({ ...fourPlayers, scores: [3, 3, 3, 3], goals: 4 }, limit)).toBe(false);
  });
});

describe('invariants', () => {
  it('keeps the ball on the board and is fully deterministic', () => {
    // A long game with pseudo-random inputs, played twice.
    const play = () => {
      let state = createGame(5, 99, { ...config, matchDuration: 1e9, goalLimit: 1e9 });
      let inputSeed = 5;
      let maxR = 0;
      for (let t = 0; t < 20_000; t++) {
        const inputs: Dir[] = state.gates.map(() => {
          const [r, next] = nextRandom(inputSeed);
          inputSeed = next;
          return r < 0.33 ? -1 : r < 0.66 ? 0 : 1;
        });
        state = step(state, inputs, config).state;
        maxR = Math.max(maxR, Math.hypot(state.ball.x, state.ball.y));
        expect(ballSpeed(state.ball)).toBeLessThanOrEqual(config.maxSpeed + 1e-9);
      }
      return { state, maxR };
    };
    const a = play();
    const b = play();
    expect(a.maxR).toBeLessThanOrEqual(1 - config.ballRadius + 1e-6);
    expect(a.state).toEqual(b.state);
    expect(a.state.scores.reduce((x, y) => x + y)).toBeGreaterThan(0);
  });
});
