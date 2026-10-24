// HostGame and ClientGame with a fake clock, manual ticking and a fake network.
import { describe, expect, it } from 'vitest';
import type { Gate, RoomEvent, StateMessage } from '../types';
import { ClientGame, RESEND_MS } from './client';
import { ADOPT_BURST_SECONDS, CLAIM_WINDOW_TICKS, COUNTDOWN_SECONDS, HostGame, SNAPSHOT_EVERY } from './host';
import { DEFAULT_CONFIG, DT, TICK_RATE, createGame, gateCenter, gateHalfWidth, paddleReach, paddleTravel, type GameState, type PhysicsConfig } from './physics';
import { INTERP_DELAY_MS } from './snapshot';

const TICK_MS = DT * 1000;
const gates: Gate[] = [
  { seat: 0, playerId: 'host', displayName: 'Host' },
  { seat: 2, playerId: 'b', displayName: 'B' },
  { seat: 5, playerId: 'c', displayName: 'C' },
];

function hostHarness(config: PhysicsConfig = DEFAULT_CONFIG, lineup: Gate[] = gates, state?: GameState) {
  let now = 1000;
  const states: StateMessage[] = [];
  const events: RoomEvent[] = [];
  const ended: number[][] = [];
  const host = new HostGame(
    { sendState: (m) => states.push(m), send: async (e) => void events.push(e) },
    lineup,
    0,
    { config, seed: 3, now: () => now, ticker: () => () => {}, onEnd: (s) => ended.push(s), botSkill: 0.9, ...(state ? { state } : {}) },
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
    expect(states.at(-1)!.balls[0]!.slice(2, 4)).toEqual([0, 0]);
    advance(200);
    expect(Math.hypot(states.at(-1)!.balls[0]![2], states.at(-1)!.balls[0]![3])).toBeGreaterThan(0);
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

  it("puts a guest's paddle where the guest says it is, inside their gate", () => {
    const { host, states, advance } = hostHarness();
    host.applyInput(5, 0, gateCenter(2, 3) + 0.1); // Seat 5 is gate 2.
    advance(50);
    expect(states.at(-1)!.paddles[2]).toBeCloseTo(gateCenter(2, 3) + 0.1, 3);
    advance(1000);
    host.applyInput(5, 0, gateCenter(2, 3) + 0.45);
    advance(1000);
    host.applyInput(5, 0, gateCenter(2, 3) + 3); // Way outside the gate: kept at its edge.
    advance(50);
    expect(states.at(-1)!.paddles[2]).toBeCloseTo(gateCenter(2, 3) + paddleTravel(3, DEFAULT_CONFIG), 3);
  });

  describe("adopting a guest's paddle", () => {
    const speed = DEFAULT_CONFIG.paddleSpeed * 2 * gateHalfWidth(3, DEFAULT_CONFIG);
    const burst = ADOPT_BURST_SECONDS * speed;
    const offset = (paddles: number[]) => paddles[2]! - gateCenter(2, 3);

    it('moves it at most a network delay of travel at once', () => {
      const { host, states, advance } = hostHarness();
      host.applyInput(5, 0, gateCenter(2, 3) + paddleTravel(3, DEFAULT_CONFIG)); // Center to edge in one go.
      advance(SNAPSHOT_EVERY * TICK_MS);
      expect(offset(states.at(-1)!.paddles)).toBeCloseTo(burst, 3);
    });

    it("doesn't let a stream of inputs add up to a teleport", () => {
      const { host, states, advance } = hostHarness();
      const edge = gateCenter(2, 3) - paddleTravel(3, DEFAULT_CONFIG);
      // A modified client claiming the edge every tick for 12 ticks.
      for (let i = 0; i < 12; i++) {
        host.applyInput(5, 0, edge);
        advance(TICK_MS);
      }
      // The burst, plus what came back over the 11 ticks between the first input and the last.
      expect(-offset(states.at(-1)!.paddles)).toBeCloseTo(burst + 0.5 * speed * 11 * DT, 3);
      expect(-offset(states.at(-1)!.paddles)).toBeLessThan(paddleTravel(3, DEFAULT_CONFIG));
    });

    it('keeps up with an honest guest a network delay ahead', () => {
      const { host, states, advance } = hostHarness();
      // The guest holds right for 300 ms, and the host hears it 100 ms late:
      // the guest is already 0.1 s of travel along when the first input lands.
      host.applyInput(5, 1, gateCenter(2, 3) + speed * 0.1);
      advance(100);
      host.applyInput(5, 1, gateCenter(2, 3) + speed * 0.2);
      advance(100);
      host.applyInput(5, 0, gateCenter(2, 3) + speed * 0.3); // Released.
      advance(SNAPSHOT_EVERY * TICK_MS);
      expect(offset(states.at(-1)!.paddles)).toBeCloseTo(speed * 0.3, 3);
    });
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
  it('plays on past the usual 2 minutes with no time limit', () => {
    // Tiny paddles, so goals keep coming, and a goal limit it won't reach.
    const { host, events, advance } = hostHarness({ ...DEFAULT_CONFIG, paddleFraction: 0.01, matchDuration: Infinity, goalLimit: 1000 });
    advance(DEFAULT_CONFIG.matchDuration * 1000 + 5_000);
    expect(events.filter((e) => e.type === 'goal').length).toBeGreaterThan(0);
    expect(host.isOver()).toBe(false);
  });

  it('ends on time with no goal limit, however many goals', () => {
    const { host, events, advance } = hostHarness({ ...DEFAULT_CONFIG, matchDuration: 20, goalLimit: Infinity });
    advance(19_000);
    expect(host.isOver()).toBe(false);
    advance(2_000);
    expect(host.isOver()).toBe(true);
    expect(events.some((e) => e.type === 'end')).toBe(true);
  });
});

describe('HostGame saves', () => {
  const config = { ...DEFAULT_CONFIG, matchDuration: 1e9, goalLimit: 99 };
  const speed = 0.85;
  const hitR = config.paddleRadius - config.ballRadius;
  /** Host tick at which the shot reaches the paddle line. */
  const crossing = hitR / speed / DT;

  /**
   * The ball heading straight for the middle of `gate`, whose paddle is at
   * the gate's edge, so it misses.  Gate 2 touched it last, so it scores.
   */
  function shotAt(gate: number): GameState {
    const angle = gateCenter(gate, 3);
    const game = createGame(3, 3, config);
    return {
      ...game,
      respawnTicks: 0,
      balls: [{ x: 0, y: 0, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, lastTouch: gate === 2 ? 0 : 2, rally: 0 }],
      gates: game.gates.map((g, i) => (i === gate ? { ...g, paddle: angle + paddleTravel(3, config) } : g)),
    };
  }
  const goals = (events: RoomEvent[]) => events.filter((e) => e.type === 'goal');
  /** Runs ticks until the goal in the physics, which is before it's official. */
  const toGoal = (advance: (ms: number) => void) => advance(Math.ceil((1 - config.ballRadius) / speed / DT + 1) * TICK_MS);

  it("holds a goal against a guest for the claim window, then makes it official", () => {
    const { events, states, advance } = hostHarness(config, gates, shotAt(1));
    toGoal(advance);
    expect(goals(events)).toEqual([]);
    expect(states.at(-1)!.scores).toEqual([0, 0, 0]);
    advance(CLAIM_WINDOW_TICKS * TICK_MS);
    expect(goals(events)).toEqual([{ type: 'goal', gate: 1, scorer: 2 }]);
    advance(SNAPSHOT_EVERY * TICK_MS);
    expect(states.at(-1)!.scores).toEqual([0, 0, 1]);
    expect(states.at(-1)!.goals).toBe(1);
  });

  it("makes a goal against the host's own gate official at once", () => {
    const { events, advance } = hostHarness(config, gates, shotAt(0));
    toGoal(advance);
    expect(goals(events)).toEqual([{ type: 'goal', gate: 0, scorer: 2 }]);
  });

  it("turns a goal into a save when the guest's paddle covered the ball on their screen", () => {
    const { host, events, states, advance } = hostHarness(config, gates, shotAt(1));
    toGoal(advance);
    expect(host.claimSave(2, crossing, gateCenter(1, 3))).toBe(true); // Seat 2 is gate 1.
    advance((CLAIM_WINDOW_TICKS + 30) * TICK_MS);
    expect(goals(events)).toEqual([]);
    const ball = host.view().balls[0]!;
    expect(ball.x * ball.vx + ball.y * ball.vy).toBeLessThan(0); // Heading back in.
    expect(states.at(-1)!.balls[0]![4]).toBe(1); // Last touched by gate 1.
    expect(states.at(-1)!.goals).toBe(0);
  });

  it.each([
    ["a paddle that doesn't cover the ball", 2, gateCenter(1, 3) + 0.3],
    ['a paddle too far from where the host had it', 2, gateCenter(1, 3) - paddleTravel(3, config)],
    ["the host's own seat", 0, gateCenter(1, 3)],
    ['a seat nobody holds', 7, gateCenter(1, 3)],
  ])('refuses a claim from %s', (_label, seat, paddle) => {
    const { host, events, advance } = hostHarness(config, gates, shotAt(1));
    toGoal(advance);
    expect(host.claimSave(seat, crossing, paddle)).toBe(false);
    advance(CLAIM_WINDOW_TICKS * TICK_MS);
    expect(goals(events)).toHaveLength(1);
  });

  it("judges a claim with the guest's wide paddle, when they have one", () => {
    // A paddle center just past where a normal paddle could reach the ball.
    const offAxis = gateCenter(1, 3) + paddleReach(3, config) * 1.2;
    const wide = (state: GameState): GameState => ({ ...state, gates: state.gates.map((g, i) => (i === 1 ? { ...g, wideTicks: 600 } : g)) });
    const powered = { ...config, powerUps: true };
    const normal = hostHarness(powered, gates, shotAt(1));
    toGoal(normal.advance);
    expect(normal.host.claimSave(2, crossing, offAxis)).toBe(false);
    const widened = hostHarness(powered, gates, wide(shotAt(1)));
    toGoal(widened.advance);
    expect(widened.host.claimSave(2, crossing, offAxis)).toBe(true);
  });

  it('refuses a claim naming a ball that never reached the paddle', () => {
    const { host, advance } = hostHarness(config, gates, shotAt(1));
    toGoal(advance);
    expect(host.claimSave(2, crossing, gateCenter(1, 3), 1)).toBe(false);
    expect(host.claimSave(2, crossing, gateCenter(1, 3), 0)).toBe(true);
  });

  it('refuses a claim that arrives after the window', () => {
    const { host, events, advance } = hostHarness(config, gates, shotAt(1));
    toGoal(advance);
    advance((CLAIM_WINDOW_TICKS + 5) * TICK_MS);
    expect(host.claimSave(2, crossing, gateCenter(1, 3))).toBe(false);
    expect(goals(events)).toHaveLength(1);
  });

  it('refuses a claim for a bot', () => {
    const withBot: Gate[] = [gates[0]!, { ...gates[1]!, bot: true }, gates[2]!];
    const { host, advance } = hostHarness(config, withBot, shotAt(1));
    toGoal(advance);
    expect(host.claimSave(2, crossing, gateCenter(1, 3))).toBe(false);
  });

  it('ignores a claim where the host already had the save', () => {
    const saved = shotAt(1);
    const centered = { ...saved, gates: saved.gates.map((g, i) => (i === 1 ? { ...g, paddle: gateCenter(1, 3) } : g)) };
    const { host, advance } = hostHarness(config, gates, centered);
    advance((crossing + 3) * TICK_MS);
    expect(host.claimSave(2, crossing, gateCenter(1, 3))).toBe(false);
  });

  it("end to end: a guest's late save stands, and their screen never shows the goal", () => {
    const LATENCY_MS = 40;
    let now = 1000;
    const queue: { at: number; deliver: () => void }[] = [];
    const later = (deliver: () => void) => queue.push({ at: now + LATENCY_MS, deliver });
    const events: RoomEvent[] = [];
    let client: ClientGame;
    const host = new HostGame(
      { sendState: (m) => later(() => client.onState(m)), send: async (e) => void events.push(e) },
      gates,
      0,
      { config, now: () => now, ticker: () => () => {}, state: shotAt(1) },
    );
    client = new ClientGame(
      gates,
      1,
      (dir, paddle, save) =>
        later(() => {
          host.applyInput(2, dir, paddle);
          if (save) claims.push(host.claimSave(2, save.tick, save.paddle));
        }),
      { config, now: () => now },
    );
    const claims: boolean[] = [];
    host.start();

    // The guest's paddle starts at the gate's edge (as the host has it).  They
    // move to the middle just in time to meet the ball as they see it: 100 ms
    // of drawing delay plus 40 ms of network after the host had it there.
    const center = gateCenter(1, 3);
    const travelTime = (paddleTravel(3, config) / (config.paddleSpeed * 2 * gateHalfWidth(3, config))) * 1000;
    const seenAt = 1000 + crossing * TICK_MS + INTERP_DELAY_MS + LATENCY_MS;
    const pressAt = seenAt - travelTime;
    let pressed = false;
    let released = false;
    const drawn: GameState[] = [];
    for (let t = 0; t < 2500; t += 4) {
      now = 1000 + t;
      host.advance();
      for (const message of queue.filter((m) => m.at <= now)) message.deliver();
      queue.splice(0, queue.length, ...queue.filter((m) => m.at > now));
      if (!pressed && now >= pressAt) (pressed = true), client.setOwnInput(-1);
      if (!released && pressed && client.predictedPaddle() <= center + 1e-3) (released = true), client.setOwnInput(0);
      // Frames from host snapshots, not the placeholder before the first arrives.
      if (t % 16 === 0 && client.hasState()) drawn.push(client.view());
    }

    // On the host, the paddle was still on its way when the ball got there...
    // ...but the guest's claim stood, so there was never a goal.
    expect(claims).toEqual([true]);
    expect(events.filter((e) => e.type === 'goal')).toEqual([]);
    // The guest's screen never showed the ball going in, and showed it
    // coming back off their paddle.
    expect(drawn.every((s) => s.respawnTicks === 0)).toBe(true);
    expect(drawn.some((s) => s.balls[0]!.lastTouch === 1 && s.balls[0]!.x * s.balls[0]!.vx + s.balls[0]!.y * s.balls[0]!.vy < 0)).toBe(true);
  });

  it('waits out a pending goal before ending on the clock', () => {
    const short = { ...config, matchDuration: 70 / TICK_RATE };
    const { events, ended, advance } = hostHarness(short, gates, shotAt(1));
    toGoal(advance);
    advance(TICK_MS);
    expect(ended).toEqual([]);
    advance(CLAIM_WINDOW_TICKS * TICK_MS);
    expect(ended).toEqual([[0, 0, 1]]);
    expect(goals(events)).toHaveLength(1);
  });
});

describe('ClientGame', () => {
  function clientHarness() {
    let now = 0;
    const sent: number[] = [];
    const positions: number[] = [];
    const client = new ClientGame(gates, 1, (dir, paddle) => (sent.push(dir), positions.push(paddle)), { now: () => now });
    return { client, sent, positions, tick: (ms: number) => ((now += ms), client.view()) };
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

  it('reports where its paddle was when the key changed', () => {
    const { client, positions, tick } = clientHarness();
    tick(0);
    client.setOwnInput(1);
    tick(100);
    tick(50);
    client.setOwnInput(0);
    // The release reports the paddle 150 ms on, not where the last frame left it.
    expect(positions.at(-1)).toBeCloseTo(client.predictedPaddle(), 9);
    expect(positions.at(-1)!).toBeGreaterThan(gateCenter(1, 3));
  });

  it('resends its position every RESEND_MS while moving, and nothing while still', () => {
    const { client, sent, tick } = clientHarness();
    tick(0);
    client.setOwnInput(1);
    for (let t = 0; t < 1000; t += 10) tick(10);
    expect(sent).toHaveLength(1 + 1000 / RESEND_MS);
    client.setOwnInput(0);
    for (let t = 0; t < 1000; t += 10) tick(10);
    expect(sent).toHaveLength(2 + 1000 / RESEND_MS);
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
    client.onState({ tick: 3, balls: [[0, 0, 0, 0, -1, 0]], paddles: [0, hostPaddle, gateCenter(2, 3)], active: [true, true, true], scores: [0, 0, 0], goals: 0, respawn: 10 });
    tick(0);
    for (let i = 0; i < 60; i++) tick(16);
    expect(client.predictedPaddle()).toBeCloseTo(hostPaddle, 3);
  });

  it("doesn't chase the host's stale copy of its paddle right after a key release", () => {
    const { client, tick } = clientHarness();
    tick(0);
    client.setOwnInput(1);
    tick(100);
    client.setOwnInput(0);
    const stopped = client.predictedPaddle();
    // A snapshot from before the host heard about the release: our paddle still going.
    client.onState({ tick: 3, balls: [[0, 0, 0, 0, -1, 0]], paddles: [0, stopped + 0.1, gateCenter(2, 3)], active: [true, true, true], scores: [0, 0, 0], goals: 0, respawn: 10 });
    for (let i = 0; i < 20; i++) tick(16);
    expect(client.predictedPaddle()).toBeCloseTo(stopped, 9);
  });

  it("doesn't draw a predicted paddle for a gate that's been walled off", () => {
    const { client, tick } = clientHarness();
    client.onState({ tick: 3, balls: [[0, 0, 0, 0, -1, 0]], paddles: [0, 2.1, -2.1], active: [true, false, true], scores: [0, 0, 0], goals: 0, respawn: 0 });
    client.setOwnInput(1);
    expect(tick(200).gates[1]).toEqual({ paddle: 2.1, active: false });
  });
});
