import { describe, expect, it } from 'vitest';
import { parseStateMessage } from '../types';
import { botInput } from './bot';
import { interpolate } from './interpolate';
import { DEFAULT_CONFIG, DT, createGame, step, type Dir, type GameState } from './physics';
import { INTERP_DELAY_MS, MAX_EXTRAPOLATE_TICKS, SnapshotBuffer, decodeState, encodeState } from './snapshot';

const TICK_MS = DT * 1000;

function playing(ticks: number): GameState[] {
  const states: GameState[] = [];
  let state: GameState = { ...createGame(3, 5, DEFAULT_CONFIG), respawnTicks: 0, balls: [{ x: 0, y: 0, vx: 0.6, vy: 0.2, lastTouch: -1, rally: 0 }] };
  for (let i = 0; i < ticks; i++) {
    state = step(state, [1, 0, -1], DEFAULT_CONFIG).state;
    states.push(state);
  }
  return states;
}

describe('encodeState / decodeState', () => {
  it('round-trips through JSON and the parser, to 4 decimal places', () => {
    const last = playing(10).at(-1)!;
    const state = { ...last, balls: last.balls.map((b) => ({ ...b, lastTouch: 2, rally: 4 })) };
    const wire = parseStateMessage(JSON.parse(JSON.stringify(encodeState(state))));
    expect(wire).not.toBeNull();
    const back = decodeState(wire!);
    expect(back.tick).toBe(state.tick);
    expect(back.scores).toEqual(state.scores);
    expect(back.balls[0]!.lastTouch).toBe(2);
    expect(back.balls[0]!.rally).toBe(4);
    expect(back.balls[0]!.x).toBeCloseTo(state.balls[0]!.x, 4);
    expect(back.gates.map((g) => g.paddle)).toEqual(state.gates.map((g) => expect.closeTo(g.paddle, 4) as number));
    expect(back.gates.map((g) => g.active)).toEqual([true, true, true]);
  });

  it('carries power-ups: the token, the timer, and each gate\'s effects', () => {
    const state: GameState = {
      ...playing(10).at(-1)!,
      pickup: { kind: 'multiball', x: 0.31234567, y: -0.4, ticksLeft: 200 },
      pickupTimer: 77,
      gates: playing(10).at(-1)!.gates.map((g, i) => (i === 1 ? { ...g, wideTicks: 90, shieldTicks: 5 } : g)),
    };
    const back = decodeState(parseStateMessage(JSON.parse(JSON.stringify(encodeState(state))))!);
    expect(back.pickup).toEqual({ kind: 'multiball', x: 0.3123, y: -0.4, ticksLeft: 200 });
    expect(back.pickupTimer).toBe(77);
    expect(back.gates.map((g) => [g.wideTicks, g.shieldTicks])).toEqual([[undefined, undefined], [90, 5], [undefined, undefined]]);
  });

  it('leaves the power-up fields out of a classic match', () => {
    expect(Object.keys(encodeState(playing(10).at(-1)!)).sort()).toEqual(['active', 'balls', 'goals', 'paddles', 'respawn', 'scores', 'seed', 'tick']);
  });

  it('stays small with power-ups at their busiest', () => {
    const ball = { x: -0.123456, y: 0.654321, vx: -1.234567, vy: 2.345678, lastTouch: 7, rally: 12 };
    const json = JSON.stringify(
      encodeState({
        ...playing(10).at(-1)!,
        gates: Array(8).fill({ active: true, paddle: -2.123456789, wideTicks: 480, shieldTicks: 900 }),
        scores: Array(8).fill(10),
        goals: 25,
        balls: [ball, ball, ball],
        pickup: { kind: 'multiball', x: -0.612345, y: 0.512345, ticksLeft: 600 },
        pickupTimer: 720,
        seed: 4294967295,
      }),
    );
    expect(json.length).toBeLessThan(500);
  });

  it('stays small', () => {
    const json = JSON.stringify(encodeState({ ...playing(10).at(-1)!, gates: Array(8).fill({ active: true, paddle: -2.123456789 }), scores: Array(8).fill(10), goals: 25, balls: [{ x: -0.123456, y: 0.654321, vx: -1.234567, vy: 2.345678, lastTouch: 7, rally: 12 }], seed: 4294967295 }));
    expect(json.length).toBeLessThan(300);
  });
});

describe('SnapshotBuffer', () => {
  const states = playing(60);
  // Snapshots every 3rd tick, arriving 40 ms after the host made them.
  const snapshots = states.filter((s) => s.tick % 3 === 0);
  const arrival = (s: GameState) => 10_000 + s.tick * TICK_MS + 40;

  it('returns nothing before the first snapshot', () => {
    expect(new SnapshotBuffer().sample(0)).toBeUndefined();
  });

  it('draws INTERP_DELAY_MS behind the newest arrival, blending neighbours', () => {
    const buffer = new SnapshotBuffer();
    for (const s of snapshots.slice(0, 10)) buffer.push(s, arrival(s));
    // At the moment tick 21 would arrive, we should be drawing 100 ms (6 ticks) earlier: tick 15.
    const now = 10_000 + 21 * TICK_MS + 40;
    const drawn = buffer.sample(now)!;
    const expected = states.find((s) => s.tick === 21 - INTERP_DELAY_MS / TICK_MS)!;
    expect(drawn.balls[0]!.x).toBeCloseTo(expected.balls[0]!.x, 6);
    // Halfway between snapshots 15 and 18 (tick 16.5): x is between theirs.
    const between = buffer.sample(now + 1.5 * TICK_MS)!;
    const a = states.find((s) => s.tick === 16)!;
    const b = states.find((s) => s.tick === 17)!;
    expect(between.balls[0]!.x).toBeGreaterThan(a.balls[0]!.x);
    expect(between.balls[0]!.x).toBeLessThan(b.balls[0]!.x);
  });

  it('replays the physics between snapshots, so bounces land where the host had them', () => {
    // A fast ball, long enough for several paddle and wall bounces.
    const fast = { ...DEFAULT_CONFIG, launchSpeed: 3 };
    const host: GameState[] = [];
    let state: GameState = { ...createGame(3, 9, fast), respawnTicks: 0, balls: [{ x: 0, y: 0, vx: 2.2, vy: 1.1, lastTouch: -1, rally: 0 }] };
    for (let i = 0; i < 600; i++) {
      state = step(state, [1, -1, 1].map((d) => (Math.floor(i / 40) % 2 ? d : -d)) as Dir[], fast).state;
      host.push(state);
    }
    const buffer = new SnapshotBuffer(fast);
    const wire = (s: GameState) => decodeState(parseStateMessage(JSON.parse(JSON.stringify(encodeState(s))))!);
    // Feed snapshots as they'd arrive, and check each host tick as it's drawn.
    const snapshots = host.filter((s) => s.tick % 3 === 0);
    let next = 0;
    let worst = 0;
    for (const s of host.filter((s) => s.tick > 3 && s.tick < 590 && s.tick % 3 !== 0 && s.respawnTicks === 0)) {
      const drawAt = arrival(s) + INTERP_DELAY_MS;
      while (next < snapshots.length && arrival(snapshots[next]!) <= drawAt) buffer.push(wire(snapshots[next]!), arrival(snapshots[next++]!));
      const drawn = buffer.sample(drawAt)!;
      worst = Math.max(worst, Math.hypot(drawn.balls[0]!.x - s.balls[0]!.x, drawn.balls[0]!.y - s.balls[0]!.y));
    }
    // Within rounding of the host (measured: 0.0001).  A straight line
    // between snapshots is off by 0.1 here, cutting the corner at each bounce.
    expect(worst).toBeLessThan(0.001);
  });

  it('replays power-ups the way the host played them: tokens, wide paddles, shields and multiball', () => {
    // Tokens often, and long shields, so a short game has every effect in it.
    const config = { ...DEFAULT_CONFIG, powerUps: true, pickupMinSeconds: 2, pickupMaxSeconds: 3, pickupVolley: 3, shieldDuration: 30, goalLimit: 1000 };
    const host: GameState[] = [];
    const seen = new Set<string>();
    let state = createGame(4, 5, config);
    for (let i = 0; i < 60 * 90; i++) {
      const result = step(state, state.gates.map((_, g) => botInput(state, g, config, 0.9)), config);
      state = result.state;
      result.events.forEach((e) => seen.add(e.type === 'pickup' ? `pickup:${e.kind}` : e.type));
      host.push(state);
    }
    // The game had every effect in it, or the test proves little.
    expect([...seen]).toEqual(expect.arrayContaining(['spawn', 'pickup:wide', 'pickup:shield', 'pickup:multiball', 'shield']));

    const buffer = new SnapshotBuffer(config);
    const wire = (s: GameState) => decodeState(parseStateMessage(JSON.parse(JSON.stringify(encodeState(s))))!);
    const snapshots = host.filter((s) => s.tick % 3 === 0);
    let next = 0;
    let worst = 0;
    let off = 0;
    let drawnBalls = 0;
    for (const s of host.filter((s) => s.tick > 3 && s.tick < host.length - 10)) {
      const drawAt = arrival(s) + INTERP_DELAY_MS;
      while (next < snapshots.length && arrival(snapshots[next]!) <= drawAt) buffer.push(wire(snapshots[next]!), arrival(snapshots[next++]!));
      // What the host had at the moment drawn: its own two ticks either side,
      // blended the same way.  (The drawing clock settles over the first few
      // ticks, so the moment isn't always exactly s.)
      const at = buffer.renderTick(drawAt)!;
      const drawn = buffer.sample(drawAt)!;
      const tick = Math.floor(at);
      const truth = interpolate(host[tick - 1]!, host[tick]!, at - tick);
      expect(drawn.balls.length).toBe(truth.balls.length);
      drawn.balls.forEach((b, i) => {
        const d = Math.hypot(b.x - truth.balls[i]!.x, b.y - truth.balls[i]!.y);
        worst = Math.max(worst, d);
        drawnBalls++;
        if (d > 0.01) off++;
      });
      expect(drawn.pickup?.kind).toBe(truth.pickup?.kind);
      expect(drawn.gates.map((g) => [g.wideTicks ?? 0, g.shieldTicks ?? 0])).toEqual(truth.gates.map((g) => [g.wideTicks ?? 0, g.shieldTicks ?? 0]));
    }
    // The replay blends paddles between snapshots, so a ball that only just
    // caught a paddle's edge on the host can slip past it in the replay, for
    // a frame or two until the next snapshot.  Hard bots aiming for tokens
    // hit near the edge a lot.  Measured: one drawn ball in about 7,000 off by
    // more than 0.01 (by 0.039).  Otherwise within 0.004, the same as without
    // power-ups.
    expect(off / drawnBalls).toBeLessThan(0.001);
    expect(worst).toBeLessThan(0.05);
  });

  it('runs the physics on when the next snapshot is late, for at most MAX_EXTRAPOLATE_TICKS', () => {
    const buffer = new SnapshotBuffer();
    for (const s of snapshots.slice(0, 5)) buffer.push(s, arrival(s));
    const last = snapshots[4]!;
    // Five ticks past the newest snapshot, the ball is where the host had it.
    const drawn = buffer.sample(arrival(last) + INTERP_DELAY_MS + 5 * TICK_MS)!;
    const host = states.find((s) => s.tick === last.tick + 5)!;
    expect(Math.hypot(drawn.balls[0]!.x - host.balls[0]!.x, drawn.balls[0]!.y - host.balls[0]!.y)).toBeLessThan(1e-9);
    // And no further than the limit, however late.
    expect(buffer.sample(1e9)!.tick).toBe(last.tick + MAX_EXTRAPOLATE_TICKS);
  });

  it('holds the last snapshot when it has no seed to run on with', () => {
    const buffer = new SnapshotBuffer();
    for (const s of snapshots.slice(0, 5)) buffer.push(s, arrival(s), false);
    expect(buffer.sample(1e9)).toBe(snapshots[4]);
  });

  it('draws smoothly through jittery arrivals', () => {
    // A long rally, with each snapshot 0 to 80 ms late.
    const host = playing(900);
    let seed = 7;
    const jitter = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 80;
    const sent = host.filter((s) => s.tick % 3 === 0).map((s) => ({ s, at: 10_000 + s.tick * TICK_MS + 40 + jitter() }));
    sent.sort((a, b) => a.at - b.at);
    const buffer = new SnapshotBuffer();
    let next = 0;
    let previous: number | undefined;
    let worstStep = 0;
    let worstBall = 0;
    for (let now = 10_000 + 2000; now < 10_000 + 14_000; now += 16) {
      while (next < sent.length && sent[next]!.at <= now) buffer.push(sent[next]!.s, sent[next++]!.at);
      const tick = buffer.renderTick(now)!;
      const drawn = buffer.sample(now)!;
      if (previous !== undefined) worstStep = Math.max(worstStep, Math.abs((tick - previous) * TICK_MS - 16));
      previous = tick;
      const truth = host[Math.round(tick) - 1]!;
      if (Math.abs(tick - Math.round(tick)) < 0.01) worstBall = Math.max(worstBall, Math.hypot(drawn.balls[0]!.x - truth.balls[0]!.x, drawn.balls[0]!.y - truth.balls[0]!.y));
    }
    // The drawing clock never jumps or stalls: each 16 ms frame moves it 16 ms, give or take 5%.
    expect(worstStep).toBeLessThanOrEqual(16 * 0.05 + 1e-9);
    // And the ball is where the host had it.
    expect(worstBall).toBeLessThan(1e-3);
  });

  it('ignores late and duplicate snapshots', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshots[3]!, arrival(snapshots[3]!));
    buffer.push(snapshots[2]!, arrival(snapshots[2]!));
    buffer.push(snapshots[3]!, arrival(snapshots[3]!));
    expect(buffer.latest()).toBe(snapshots[3]);
  });

  it('settles on the least-delayed arrival when delivery jitters', () => {
    const steady = new SnapshotBuffer();
    const jittery = new SnapshotBuffer();
    snapshots.forEach((s, i) => {
      steady.push(s, arrival(s));
      jittery.push(s, arrival(s) + (i % 2) * 30);
    });
    const now = arrival(snapshots.at(-1)!) + 30;
    // Within half a tick of ball travel.  Following the late arrivals would put it ~2 ticks behind.
    const halfTick = (0.6 * DT) / 2;
    expect(Math.abs(jittery.sample(now)!.balls[0]!.x - steady.sample(now)!.balls[0]!.x)).toBeLessThan(halfTick);
  });
});
