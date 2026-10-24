import { describe, expect, it } from 'vitest';
import { parseStateMessage } from '../types';
import { DEFAULT_CONFIG, DT, createGame, step, type Dir, type GameState } from './physics';
import { INTERP_DELAY_MS, MAX_EXTRAPOLATE_TICKS, SnapshotBuffer, decodeState, encodeState } from './snapshot';

const TICK_MS = DT * 1000;

function playing(ticks: number): GameState[] {
  const states: GameState[] = [];
  let state: GameState = { ...createGame(3, 5, DEFAULT_CONFIG), respawnTicks: 0, ball: { x: 0, y: 0, vx: 0.6, vy: 0.2 } };
  for (let i = 0; i < ticks; i++) {
    state = step(state, [1, 0, -1], DEFAULT_CONFIG).state;
    states.push(state);
  }
  return states;
}

describe('encodeState / decodeState', () => {
  it('round-trips through JSON and the parser, to 4 decimal places', () => {
    const state = { ...playing(10).at(-1)!, lastTouch: 2 };
    const wire = parseStateMessage(JSON.parse(JSON.stringify(encodeState(state))));
    expect(wire).not.toBeNull();
    const back = decodeState(wire!);
    expect(back.tick).toBe(state.tick);
    expect(back.scores).toEqual(state.scores);
    expect(back.lastTouch).toBe(2);
    expect(back.ball.x).toBeCloseTo(state.ball.x, 4);
    expect(back.gates.map((g) => g.paddle)).toEqual(state.gates.map((g) => expect.closeTo(g.paddle, 4) as number));
    expect(back.gates.map((g) => g.active)).toEqual([true, true, true]);
  });

  it('stays small', () => {
    const json = JSON.stringify(encodeState({ ...playing(10).at(-1)!, gates: Array(8).fill({ active: true, paddle: -2.123456789 }), scores: Array(8).fill(10), goals: 25, lastTouch: 7, seed: 4294967295 }));
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
    expect(drawn.ball.x).toBeCloseTo(expected.ball.x, 6);
    // Halfway between snapshots 15 and 18 (tick 16.5): x is between theirs.
    const between = buffer.sample(now + 1.5 * TICK_MS)!;
    const a = states.find((s) => s.tick === 16)!;
    const b = states.find((s) => s.tick === 17)!;
    expect(between.ball.x).toBeGreaterThan(a.ball.x);
    expect(between.ball.x).toBeLessThan(b.ball.x);
  });

  it('replays the physics between snapshots, so bounces land where the host had them', () => {
    // A fast ball, long enough for several paddle and wall bounces.
    const fast = { ...DEFAULT_CONFIG, launchSpeed: 3 };
    const host: GameState[] = [];
    let state: GameState = { ...createGame(3, 9, fast), respawnTicks: 0, ball: { x: 0, y: 0, vx: 2.2, vy: 1.1 } };
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
      worst = Math.max(worst, Math.hypot(drawn.ball.x - s.ball.x, drawn.ball.y - s.ball.y));
    }
    // Within rounding of the host (measured: 0.0001).  A straight line
    // between snapshots is off by 0.1 here, cutting the corner at each bounce.
    expect(worst).toBeLessThan(0.001);
  });

  it('runs the physics on when the next snapshot is late, for at most MAX_EXTRAPOLATE_TICKS', () => {
    const buffer = new SnapshotBuffer();
    for (const s of snapshots.slice(0, 5)) buffer.push(s, arrival(s));
    const last = snapshots[4]!;
    // Five ticks past the newest snapshot, the ball is where the host had it.
    const drawn = buffer.sample(arrival(last) + INTERP_DELAY_MS + 5 * TICK_MS)!;
    const host = states.find((s) => s.tick === last.tick + 5)!;
    expect(Math.hypot(drawn.ball.x - host.ball.x, drawn.ball.y - host.ball.y)).toBeLessThan(1e-9);
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
      if (Math.abs(tick - Math.round(tick)) < 0.01) worstBall = Math.max(worstBall, Math.hypot(drawn.ball.x - truth.ball.x, drawn.ball.y - truth.ball.y));
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
    expect(Math.abs(jittery.sample(now)!.ball.x - steady.sample(now)!.ball.x)).toBeLessThan(halfTick);
  });
});
