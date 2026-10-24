import { describe, expect, it } from 'vitest';
import { botInput } from './bot';
import { TOUCH_LEFT, TOUCH_RIGHT, dirFromKeys } from './input';
import { interpolate } from './interpolate';
import {
  DEFAULT_CONFIG,
  createGame,
  gateCenter,
  paddleTravel,
  setGateActive,
  step,
  type Dir,
  type GameState,
} from './physics';

const config = DEFAULT_CONFIG;

describe('dirFromKeys', () => {
  it('maps arrows and A/D, and cancels when both are held', () => {
    expect(dirFromKeys(new Set())).toBe(0);
    expect(dirFromKeys(new Set(['ArrowRight']))).toBe(1);
    expect(dirFromKeys(new Set(['KeyA']))).toBe(-1);
    expect(dirFromKeys(new Set(['ArrowLeft', 'KeyD']))).toBe(0);
    expect(dirFromKeys(new Set(['Space']))).toBe(0);
  });

  it('treats the touch buttons like the arrow keys', () => {
    expect(dirFromKeys(new Set([TOUCH_LEFT]))).toBe(-1);
    expect(dirFromKeys(new Set([TOUCH_RIGHT]))).toBe(1);
    expect(dirFromKeys(new Set([TOUCH_LEFT, 'ArrowRight']))).toBe(0);
  });
});

describe('botInput', () => {
  const inPlay = (x: number, y: number, vx: number, vy: number): GameState => ({
    ...createGame(4, 1, config),
    respawnTicks: 0,
    ball: { x, y, vx, vy },
  });

  it('moves toward where the ball will cross its paddle', () => {
    // Ball heading out toward gate 0, a bit counterclockwise of center.
    expect(botInput(inPlay(0.5, 0, 0.5, 0.2), 0, config, 1)).toBe(1);
    expect(botInput(inPlay(0.5, 0, 0.5, -0.2), 0, config, 1)).toBe(-1);
  });

  it('returns to the gate center when the ball is elsewhere', () => {
    const state = inPlay(-0.5, 0, -0.5, 0);
    const off = { ...state, gates: state.gates.map((g, i) => (i === 0 ? { ...g, paddle: paddleTravel(4, config) } : g)) };
    expect(botInput(off, 0, config, 1)).toBe(-1);
    expect(botInput(state, 0, config, 1)).toBe(0);
  });

  it('reacts later at low skill', () => {
    const near = inPlay(0.2, 0, 0.5, 0.2);
    expect(botInput(near, 0, config, 1)).toBe(1);
    expect(botInput(near, 0, config, 0.2)).toBe(0);
  });

  it('reads a ball still heading inward only at high skill', () => {
    // Just off gate 2's paddle, bound across the middle for gate 0, a bit counterclockwise.
    const across = inPlay(-0.85, 0, 1, 0.15);
    expect(botInput(across, 0, config, 0.9)).toBe(1);
    expect(botInput(across, 0, config, 0.6)).toBe(0);
  });

  it('does nothing for an inactive gate', () => {
    expect(botInput(setGateActive(inPlay(0.5, 0, 0.5, 0.2), 0, false), 0, config, 1)).toBe(0);
  });

  it('keeps a rally going when every gate is a skilled bot', () => {
    let state = createGame(3, 11, config);
    let hits = 0;
    let goals = 0;
    for (let t = 0; t < 60 * 60; t++) {
      const inputs: Dir[] = state.gates.map((_, i) => botInput(state, i, config, 1));
      const result = step(state, inputs, config);
      state = result.state;
      hits += result.events.filter((e) => e.type === 'hit').length;
      goals += result.events.filter((e) => e.type === 'goal').length;
    }
    expect(hits).toBeGreaterThan(goals * 3);
  });

  it("doesn't trade the ball straight across with the bot opposite", () => {
    // A ball launched at gate 1 used to go 1, 3, 1, 3... for dozens of hits.
    let state = createGame(4, 1103527590, config);
    let streak = 0;
    let worst = 0;
    let last = -1;
    for (let t = 0; t < 60 * 60; t++) {
      const result = step(state, state.gates.map((_, i) => botInput(state, i, config, 0.6)), config);
      state = result.state;
      for (const e of result.events) {
        if (e.type === 'goal') last = -1;
        if (e.type !== 'hit') continue;
        streak = last >= 0 && (e.gate + 2) % 4 === last ? streak + 1 : 0;
        worst = Math.max(worst, streak);
        last = e.gate;
      }
    }
    expect(worst).toBeLessThan(10);
  });
});

describe('interpolate', () => {
  const a: GameState = { ...createGame(4, 1, config), respawnTicks: 0, ball: { x: 0, y: 0, vx: 1, vy: 0 } };
  const b: GameState = { ...a, tick: 1, ball: { x: 0.1, y: 0.2, vx: 1, vy: 0 } };

  it('blends the ball position', () => {
    const mid = interpolate(a, b, 0.5);
    expect(mid.ball.x).toBeCloseTo(0.05);
    expect(mid.ball.y).toBeCloseTo(0.1);
    expect(mid.tick).toBe(1);
  });

  it('clamps alpha', () => {
    expect(interpolate(a, b, 2).ball).toEqual(b.ball);
    expect(interpolate(a, b, -1).ball.x).toBeCloseTo(0);
  });

  it("doesn't blend the ball across a goal: it stays put until the goal tick", () => {
    const scored: GameState = { ...b, respawnTicks: 30, ball: { x: 0, y: 0, vx: 0, vy: 0 } };
    const before = { ...a, ball: { x: 0.9, y: 0, vx: 1, vy: 0 } };
    expect(interpolate(before, scored, 0.5).ball).toEqual(before.ball);
    expect(interpolate(before, scored, 0.5).respawnTicks).toBe(0);
    expect(interpolate(before, scored, 1).ball).toEqual(scored.ball);
  });

  it('blends paddles the short way across ±π', () => {
    const gate2 = gateCenter(2, 4); // π
    const from = { ...a, gates: a.gates.map((g, i) => (i === 2 ? { ...g, paddle: gate2 - 0.1 } : g)) };
    const to = { ...a, gates: a.gates.map((g, i) => (i === 2 ? { ...g, paddle: -gate2 + 0.1 } : g)) };
    expect(Math.abs(interpolate(from, to, 0.5).gates[2]!.paddle)).toBeCloseTo(Math.PI);
  });
});
