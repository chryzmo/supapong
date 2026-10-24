// HostGame and ClientGame with a fake clock, manual ticking and a fake network.
import { describe, expect, it } from 'vitest';
import type { Gate, RoomEvent, StateMessage } from '../types';
import { ClientGame } from './client';
import { COUNTDOWN_SECONDS, HostGame, SNAPSHOT_EVERY } from './host';
import { DEFAULT_CONFIG, DT, TICK_RATE, gateCenter, paddleTravel, type PhysicsConfig } from './physics';

const TICK_MS = DT * 1000;
const gates: Gate[] = [
  { seat: 0, playerId: 'host', displayName: 'Host' },
  { seat: 2, playerId: 'b', displayName: 'B' },
  { seat: 5, playerId: 'c', displayName: 'C' },
];

function hostHarness(config: PhysicsConfig = DEFAULT_CONFIG, lineup: Gate[] = gates) {
  let now = 1000;
  const states: StateMessage[] = [];
  const events: RoomEvent[] = [];
  const ended: number[][] = [];
  const host = new HostGame(
    { sendState: (m) => states.push(m), send: async (e) => void events.push(e) },
    lineup,
    0,
    { config, seed: 3, now: () => now, ticker: () => () => {}, onEnd: (s) => ended.push(s), botSkill: 0.9 },
  );
  host.start();
  /** Moves the clock forward and runs the ticks that came due. */
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += TICK_MS) {
      now += Math.min(TICK_MS, ms - t);
      host.advance();
    }
  };
  return { host, states, events, ended, advance, jump: (ms: number) => ((now += ms), host.advance()) };
}

describe('HostGame', () => {
  const withBot: Gate[] = [gates[0]!, { ...gates[1]!, bot: true }, gates[2]!];

  it('drives bot paddles itself, and ignores network input for them', () => {
    const { host, states, advance } = hostHarness({ ...DEFAULT_CONFIG, matchDuration: 1e9, goalLimit: 99 }, withBot);
    host.applyInput(2, 1); // Seat 2 is the bot's gate.
    advance(COUNTDOWN_SECONDS * 1000 - 100);
    // Nothing to chase during the countdown, so the bot waits at its gate's center.
    expect(states.at(-1)!.paddles[1]).toBeCloseTo(gateCenter(1, 3), 5);

    let furthest = 0;
    for (let i = 0; i < 20 * TICK_RATE; i++) {
      advance(TICK_MS);
      furthest = Math.max(furthest, Math.abs(host.view().gates[1]!.paddle - gateCenter(1, 3)));
    }
    expect(furthest).toBeGreaterThan(0.05);
  });

  it('sends a snapshot at start and then every SNAPSHOT_EVERY ticks', () => {
    const { states, advance } = hostHarness();
    expect(states).toHaveLength(1);
    advance(1000);
    expect(states.length - 1).toBe(TICK_RATE / SNAPSHOT_EVERY);
    expect(states.every((s) => s.tick % SNAPSHOT_EVERY === 0)).toBe(true);
  });

  it('counts down before the first launch', () => {
    const { states, advance } = hostHarness();
    expect(states[0]!.respawn).toBe(COUNTDOWN_SECONDS * TICK_RATE);
    advance(COUNTDOWN_SECONDS * 1000 - 100);
    expect(states.at(-1)!.ball.slice(2)).toEqual([0, 0]);
    advance(200);
    expect(Math.hypot(states.at(-1)!.ball[2], states.at(-1)!.ball[3])).toBeGreaterThan(0);
  });

  it('applies inputs by seat, and only to that seat\'s gate', () => {
    const { host, states, advance } = hostHarness();
    host.applyInput(5, 1); // Seat 5 is gate 2.
    host.applyInput(7, 1); // Nobody's seat: ignored.
    host.applyInput(0, 1); // The host's own seat can't be driven over the network.
    advance(500);
    const paddles = states.at(-1)!.paddles;
    expect(paddles[0]).toBeCloseTo(gateCenter(0, 3), 3);
    expect(paddles[1]).toBeCloseTo(gateCenter(1, 3), 3);
    expect(paddles[2]).toBeCloseTo(gateCenter(2, 3) + paddleTravel(3, DEFAULT_CONFIG), 3);
  });

  it("moves the host's own paddle from local input", () => {
    const { host, states, advance } = hostHarness();
    host.setOwnInput(-1);
    advance(500);
    expect(states.at(-1)!.paddles[0]).toBeCloseTo(-paddleTravel(3, DEFAULT_CONFIG), 3);
  });

  it('turns a departed player\'s gate into wall', () => {
    const { host, states, advance } = hostHarness();
    host.removePlayer('c');
    advance(100);
    expect(states.at(-1)!.active).toEqual([true, true, false]);
  });

  it('skips ahead after a long stall instead of replaying it', () => {
    const { states, jump } = hostHarness();
    jump(10_000);
    expect(states.at(-1)!.tick).toBeLessThanOrEqual(15);
  });

  it('announces goals and the end, then stops', () => {
    // Tiny paddles and a short match, so goals happen and the clock runs out quickly.
    const { states, events, ended, host, advance } = hostHarness({ ...DEFAULT_CONFIG, paddleFraction: 0.01, matchDuration: 20, goalLimit: 99 });
    advance(21_000);
    const goals = events.filter((e) => e.type === 'goal');
    expect(goals.length).toBeGreaterThan(0);
    const end = events.find((e) => e.type === 'end');
    expect(end).toEqual({ type: 'end', scores: states.at(-1)!.scores });
    expect(ended).toEqual([states.at(-1)!.scores]);
    expect(host.isOver()).toBe(true);
    const sent = states.length;
    advance(1000);
    expect(states.length).toBe(sent);
  });
});

describe('ClientGame', () => {
  function clientHarness() {
    let now = 0;
    const sent: number[] = [];
    const client = new ClientGame(gates, 1, (dir) => sent.push(dir), { now: () => now });
    return { client, sent, tick: (ms: number) => ((now += ms), client.view()) };
  }

  it('shows centered paddles before the first snapshot', () => {
    const { client, tick } = clientHarness();
    expect(client.hasState()).toBe(false);
    expect(tick(0).gates.map((g) => g.paddle)).toEqual([0, 1, 2].map((i) => expect.closeTo(gateCenter(i, 3), 9) as number));
  });

  it('sends input only when the direction changes', () => {
    const { client, sent } = clientHarness();
    client.setOwnInput(1);
    client.setOwnInput(1);
    client.setOwnInput(0);
    client.setOwnInput(-1);
    expect(sent).toEqual([1, 0, -1]);
  });

  it('moves its own paddle immediately, without waiting for the host', () => {
    const { client, tick } = clientHarness();
    tick(0);
    client.setOwnInput(1);
    const moved = tick(100).gates[1]!.paddle;
    expect(moved).toBeGreaterThan(gateCenter(1, 3));
  });

  it("eases toward the host's paddle once it stops moving", () => {
    const { client, tick } = clientHarness();
    const hostPaddle = gateCenter(1, 3) + 0.1;
    client.onState({ tick: 3, ball: [0, 0, 0, 0], paddles: [0, hostPaddle, gateCenter(2, 3)], active: [true, true, true], scores: [0, 0, 0], goals: 0, respawn: 10, rally: 0 });
    tick(0);
    for (let i = 0; i < 60; i++) tick(16);
    expect(client.predictedPaddle()).toBeCloseTo(hostPaddle, 3);
  });

  it("doesn't draw a predicted paddle for a gate that's been walled off", () => {
    const { client, tick } = clientHarness();
    client.onState({ tick: 3, ball: [0, 0, 0, 0], paddles: [0, 2.1, -2.1], active: [true, false, true], scores: [0, 0, 0], goals: 0, respawn: 0, rally: 0 });
    client.setOwnInput(1);
    expect(tick(200).gates[1]).toEqual({ paddle: 2.1, active: false });
  });
});
