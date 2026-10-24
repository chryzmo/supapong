import { describe, expect, it } from 'vitest';
import { parseStateMessage } from '../types';
import { DEFAULT_CONFIG, DT, createGame, step, type GameState } from './physics';
import { INTERP_DELAY_MS, SnapshotBuffer, decodeState, encodeState } from './snapshot';

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
    const state = playing(10).at(-1)!;
    const wire = parseStateMessage(JSON.parse(JSON.stringify(encodeState(state))));
    expect(wire).not.toBeNull();
    const back = decodeState(wire!);
    expect(back.tick).toBe(state.tick);
    expect(back.scores).toEqual(state.scores);
    expect(back.ball.x).toBeCloseTo(state.ball.x, 4);
    expect(back.gates.map((g) => g.paddle)).toEqual(state.gates.map((g) => expect.closeTo(g.paddle, 4) as number));
    expect(back.gates.map((g) => g.active)).toEqual([true, true, true]);
  });

  it('stays small', () => {
    const json = JSON.stringify(encodeState({ ...playing(10).at(-1)!, gates: Array(8).fill({ active: true, paddle: -2.123456789 }), scores: Array(8).fill(10) }));
    expect(json.length).toBeLessThan(260);
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

  it('holds the last snapshot instead of extrapolating', () => {
    const buffer = new SnapshotBuffer();
    for (const s of snapshots.slice(0, 5)) buffer.push(s, arrival(s));
    expect(buffer.sample(1e9)).toBe(snapshots[4]);
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
