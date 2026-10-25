// Arena Pong physics.  Pure and deterministic: no DOM, no network, no
// Math.random, no clocks.  The same state, inputs and config always produce
// the same next state, which is what lets the host simulate and everyone
// else just render its snapshots.
//
// The board is a unit circle.  Angles are radians, counterclockwise from +x,
// in a y-up world.  Gate i of N is centered at 2πi/N.  A paddle is an arc at
// paddleRadius that slides within its own gate.

export type Dir = -1 | 0 | 1;

export interface PhysicsConfig {
  /** Share of each gate's sector that is open.  The rest of the rim is wall. */
  gateFraction: number;
  paddleRadius: number;
  /** Paddle width as a share of its gate's width. */
  paddleFraction: number;
  /** Paddle speed in gate widths per second. */
  paddleSpeed: number;
  ballRadius: number;
  /** Ball speed at launch, in board radii per second. */
  launchSpeed: number;
  /** Speed multiplier applied on each paddle hit. */
  speedUpPerHit: number;
  maxSpeed: number;
  /** Tangential kick from hitting the paddle's edge, as a share of ball speed. */
  english: number;
  /**
   * After a paddle hit, at least this share of the ball's velocity points back
   * toward the center.  Stops the ball from skimming along the rim forever.
   */
  minRadialShare: number;
  /**
   * Largest random turn (radians, either way) added to a wall bounce.  A
   * plain reflection keeps a ball that passes through the center on that
   * same diameter forever, so idle paddles at their gate centers would keep
   * saving it.  A little jitter knocks it off that line.
   */
  wallJitter: number;
  /**
   * How far a paddle may slide past the end of its gate, as a share of its
   * half-width.  A ball crossing the paddle line just outside the gate can
   * still drift into it before reaching the rim; this lets the paddle cover
   * that corner.
   */
  paddleOverhang: number;
  /** Seconds the ball waits at the center before (re)launching. */
  respawnDelay: number;
  /** Seconds the match lasts.  Infinity for no time limit. */
  matchDuration: number;
  /** The match ends once this many goals have been scored in total.  Infinity for no goal limit. */
  goalLimit: number;
  /**
   * Pickups and their effects (plans/power-ups.md).  Off by default: online
   * matches can't carry the state in their snapshots yet, so only the
   * sandbox turns it on.
   */
  powerUps: boolean;
  /**
   * With powerUps: every token is a multiball, and one that can't split
   * (the most balls are in play) stays on the board instead of turning into
   * a wide paddle.
   */
  multiballOnly: boolean;
  /** A token appears on a ball's every this-many-th consecutive hit. */
  pickupVolley: number;
  /** Otherwise one appears after this many seconds (rolled between the two) with room on the board. */
  pickupMinSeconds: number;
  pickupMaxSeconds: number;
  /** Seconds an uncollected token stays. */
  pickupLifetime: number;
  pickupRadius: number;
  /** Most tokens on the board at once. */
  pickupMax: number;
  /** Wide paddle: how much wider, and for how many seconds. */
  wideFactor: number;
  wideDuration: number;
  /** Seconds a shield lasts if no ball comes for it. */
  shieldDuration: number;
  /** Most balls in play at once; multiball won't split past this. */
  maxBalls: number;
}

export const DEFAULT_CONFIG: Readonly<PhysicsConfig> = {
  gateFraction: 0.72,
  paddleRadius: 0.92,
  paddleFraction: 0.22,
  paddleSpeed: 1.05,
  ballRadius: 0.022,
  launchSpeed: 0.85,
  speedUpPerHit: 1.08,
  maxSpeed: 3,
  english: 0.6,
  minRadialShare: 0.4,
  wallJitter: 0.09,
  paddleOverhang: 0.3,
  respawnDelay: 1.2,
  matchDuration: 120,
  goalLimit: 10,
  powerUps: false,
  multiballOnly: false,
  pickupVolley: 6,
  pickupMinSeconds: 8,
  pickupMaxSeconds: 12,
  pickupLifetime: 20,
  pickupRadius: 0.06,
  pickupMax: 6,
  wideFactor: 1.6,
  wideDuration: 8,
  shieldDuration: 15,
  maxBalls: 9,
};

/** How likely each kind of token is. */
const PICKUP_ODDS: [PickupKind, number][] = [
  ['wide', 0.4],
  ['shield', 0.35],
  ['multiball', 0.25],
];
/** Tokens appear between these radii: off the launch point, clear of the paddles. */
const PICKUP_MIN_RADIUS = 0.25;
const PICKUP_MAX_RADIUS = 0.65;
/** A new token tries this many spots for one clear of the others, and takes the last if none is. */
const PICKUP_PLACE_TRIES = 4;
/** How far apart two tokens' centers should be, in token radii, so they don't overlap. */
const PICKUP_SPACING = 3;

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** A ball in play, with what it remembers since its launch. */
export interface BallState extends Ball {
  /** The gate whose paddle touched this ball last since it launched, or -1. */
  lastTouch: number;
  /** Consecutive paddle hits on this ball since its launch. */
  rally: number;
}

export interface GateState {
  /** False once the gate's player leaves: the gate becomes wall and has no paddle. */
  active: boolean;
  /** Paddle center angle. */
  paddle: number;
  /** Ticks left of a wide paddle.  Absent or 0: normal width. */
  wideTicks?: number;
  /** Ticks left of a shield over the gate.  Absent or 0: none. */
  shieldTicks?: number;
}

/** In this order, so a snapshot can send a kind as its index. */
export const PICKUP_KINDS = ['wide', 'shield', 'multiball'] as const;
export type PickupKind = (typeof PICKUP_KINDS)[number];

/** A token on the board, waiting for a ball someone has touched to pass through it. */
export interface Pickup {
  kind: PickupKind;
  x: number;
  y: number;
  ticksLeft: number;
}

export interface GameState {
  tick: number;
  /**
   * The balls in play, never empty.  While waiting to launch it's one ball
   * resting at the center.
   */
  balls: BallState[];
  gates: GateState[];
  /** Points per gate. */
  scores: number[];
  /** Goals scored so far, including goals that earned nobody a point. */
  goals: number;
  /** Ticks until the ball launches.  While > 0 the ball sits at the center. */
  respawnTicks: number;
  /** PRNG state. */
  seed: number;
  /** With power-ups on: the tokens on the board, at most pickupMax.  Absent when there are none. */
  pickups?: Pickup[];
  /** With power-ups on: ticks of play with room on the board until a token appears. */
  pickupTimer?: number;
}

export type PhysicsEvent =
  | { type: 'launch' }
  /** `ball` is the index of the ball in the state before the step. */
  | { type: 'hit'; gate: number; ball: number }
  | { type: 'wall' }
  /** A shield turned a ball away from `gate`, and broke. */
  | { type: 'shield'; gate: number; ball: number }
  /** A token appeared. */
  | { type: 'spawn'; kind: PickupKind }
  /** `ball` went through a token; `gate` (its last toucher) got it, or -1 if they've left. */
  | { type: 'pickup'; kind: PickupKind; gate: number; ball: number }
  /** `scorer` is the gate that got the point, or -1 if nobody did. */
  | { type: 'goal'; gate: number; scorer: number; ball: number };

export interface StepResult {
  state: GameState;
  events: PhysicsEvent[];
}

// Geometry ---------------------------------------------------------------------

/** Wraps an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r <= -Math.PI) r += twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/** Signed shortest angle from b to a. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(a - b);
}

export function gateCenter(gate: number, gateCount: number): number {
  return wrapAngle((2 * Math.PI * gate) / gateCount);
}

export function gateHalfWidth(gateCount: number, config: PhysicsConfig): number {
  return (config.gateFraction * Math.PI) / gateCount;
}

/** @param width The paddle's width multiplier: paddleWidth() of its gate.  1 for normal. */
export function paddleHalfWidth(gateCount: number, config: PhysicsConfig, width = 1): number {
  return Math.min(gateHalfWidth(gateCount, config), gateHalfWidth(gateCount, config) * config.paddleFraction * width);
}

/** How far from a paddle's center (as an angle) the ball still counts as hitting it: its edge overlapping the paddle's end. */
export function paddleReach(gateCount: number, config: PhysicsConfig, width = 1): number {
  return paddleHalfWidth(gateCount, config, width) + config.ballRadius / config.paddleRadius;
}

/**
 * How far the paddle center can move from the gate center, either way: to
 * the gate's end, then paddleOverhang of its half-width past it.  A wider
 * paddle has less room.
 */
export function paddleTravel(gateCount: number, config: PhysicsConfig, width = 1): number {
  return gateHalfWidth(gateCount, config) - paddleHalfWidth(gateCount, config, width) * (1 - config.paddleOverhang);
}

/** The width multiplier for a gate's paddle right now: wider during a wide paddle. */
export function paddleWidth(gate: GateState, config: PhysicsConfig): number {
  return (gate.wideTicks ?? 0) > 0 ? config.wideFactor : 1;
}

/** The active gate whose opening contains `angle`, or -1. */
export function gateAt(angle: number, gates: GateState[], config: PhysicsConfig): number {
  const half = gateHalfWidth(gates.length, config);
  return gates.findIndex((g, i) => g.active && Math.abs(angleDiff(angle, gateCenter(i, gates.length))) <= half);
}

/** Earliest t > 0 when a point moving from p with velocity v reaches radius r (from inside), or Infinity. */
export function exitTime(x: number, y: number, vx: number, vy: number, r: number): number {
  const a = vx * vx + vy * vy;
  if (a === 0) return Infinity;
  const b = 2 * (x * vx + y * vy);
  const c = x * x + y * y - r * r;
  if (c > 0) return Infinity; // Already outside: not an exit.
  const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return t > 0 ? t : Infinity;
}

// Randomness -------------------------------------------------------------------

/** mulberry32: returns [value in [0, 1), next seed]. */
export function nextRandom(seed: number): [number, number] {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

// State --------------------------------------------------------------------------

/** A ball at the center, waiting to launch. */
export function restingBall(): BallState {
  return { x: 0, y: 0, vx: 0, vy: 0, lastTouch: -1, rally: 0 };
}

export function createGame(gateCount: number, seed: number, config: PhysicsConfig = DEFAULT_CONFIG): GameState {
  if (config.powerUps) {
    const [pickupTimer, next] = pickupDelay(seed >>> 0, config);
    return { ...createGame(gateCount, next, { ...config, powerUps: false }), pickupTimer };
  }
  return {
    tick: 0,
    balls: [restingBall()],
    gates: Array.from({ length: gateCount }, (_, i) => ({ active: true, paddle: gateCenter(i, gateCount) })),
    scores: Array.from({ length: gateCount }, () => 0),
    goals: 0,
    respawnTicks: Math.round(config.respawnDelay * TICK_RATE),
    seed: seed >>> 0,
  };
}

/** Turns a gate into wall (its player left) or back. */
export function setGateActive(state: GameState, gate: number, active: boolean): GameState {
  return { ...state, gates: state.gates.map((g, i) => (i === gate ? { ...g, active } : g)) };
}

export function isOver(state: GameState, config: PhysicsConfig): boolean {
  return state.tick >= config.matchDuration * TICK_RATE || state.goals >= config.goalLimit;
}

export function ballSpeed(ball: Ball): number {
  return Math.hypot(ball.vx, ball.vy);
}

// Step ---------------------------------------------------------------------------

/**
 * Moves a paddle for `dt` seconds and keeps it within its travel
 * (paddleTravel).  Shared by step() and by clients predicting their own
 * paddle between snapshots.
 */
export function movePaddle(paddle: number, gate: number, gateCount: number, dir: Dir, dt: number, config: PhysicsConfig, width = 1): number {
  const center = gateCenter(gate, gateCount);
  const travel = paddleTravel(gateCount, config, width);
  const speed = config.paddleSpeed * 2 * gateHalfWidth(gateCount, config);
  const offset = angleDiff(paddle, center) + dir * speed * dt;
  return wrapAngle(center + Math.max(-travel, Math.min(travel, offset)));
}

/**
 * Advances the game one tick.
 * @param inputs Paddle direction per gate; +1 is counterclockwise.  Missing entries count as 0.
 */
export function step(state: GameState, inputs: readonly Dir[], config: PhysicsConfig): StepResult {
  const events: PhysicsEvent[] = [];
  const n = state.gates.length;

  let gates = state.gates.map((gate, i) => {
    if (!gate.active) return gate;
    const paddle = movePaddle(gate.paddle, i, n, inputs[i] ?? 0, DT, config, paddleWidth(gate, config));
    return config.powerUps ? tickEffects({ ...gate, paddle }) : { active: true, paddle };
  });

  let next: GameState = { ...state, tick: state.tick + 1, gates };
  if (config.powerUps) next = tickPickups(next);

  // Waiting at the center.
  if (state.respawnTicks > 0) {
    next.respawnTicks = state.respawnTicks - 1;
    if (next.respawnTicks === 0) {
      const [angle, seed] = launchAngle(gates, next.seed, config);
      next.seed = seed;
      next.balls = [{ ...restingBall(), vx: Math.cos(angle) * config.launchSpeed, vy: Math.sin(angle) * config.launchSpeed }];
      events.push({ type: 'launch' });
    }
    return { state: next, events };
  }

  // Balls move one after another, in order, so the PRNG (wall bounces) is
  // used in the same order every time.
  const balls: BallState[] = [];
  /** Multiball's new balls, added after every ball has moved, so they're always last. */
  const split: BallState[] = [];
  let scores = next.scores;
  let goals = next.goals;
  let seed = next.seed;
  let pickups = next.pickups ?? [];
  let pickupTimer = next.pickupTimer;
  for (const [index, ball] of state.balls.entries()) {
    const moved = moveBall(ball, index, gates, seed, config, events);
    seed = moved.seed;
    if (moved.shieldBroken !== undefined) gates = gates.map((g, i) => (i === moved.shieldBroken ? withoutShield(g) : g));
    if (moved.goal) {
      const { scorer } = moved.goal;
      scores = scores.map((s, i) => (i === scorer ? s + 1 : s));
      goals++;
      continue;
    }
    balls.push(moved.ball);
    if (!config.powerUps) continue;

    // Through a token, after someone has touched it: they get it.  A ball
    // collects every token on its path, in board order.
    const owner = moved.ball.lastTouch;
    const met = owner >= 0 ? pickups.filter((p) => pathMeets(moved.path, p, config.pickupRadius + config.ballRadius)) : [];
    const collected: Pickup[] = [];
    for (const pickup of met) {
      const active = gates[owner]?.active === true;
      // Multiball with no room for more balls gives a wide paddle instead,
      // or, with only multiball, waits on the board for room.
      const room = config.maxBalls - balls.length - split.length - (state.balls.length - index - 1);
      if (config.multiballOnly && room <= 0) continue;
      collected.push(pickup);
      const kind: PickupKind = pickup.kind === 'multiball' && room <= 0 ? 'wide' : pickup.kind;
      events.push({ type: 'pickup', kind: pickup.kind, gate: active ? owner : -1, ball: index });
      if (active && kind === 'wide') gates = gates.map((g, i) => (i === owner ? { ...g, wideTicks: Math.round(config.wideDuration * TICK_RATE) } : g));
      if (active && kind === 'shield') gates = gates.map((g, i) => (i === owner ? { ...g, shieldTicks: Math.round(config.shieldDuration * TICK_RATE) } : g));
      if (active && kind === 'multiball') {
        let more: BallState[];
        [more, seed] = splitBall(moved.ball, Math.min(2, room), seed);
        split.push(...more);
      }
    }
    if (collected.length > 0) pickups = pickups.filter((p) => !collected.includes(p));

    // A volley: this ball's every pickupVolley-th hit in a row.
    const hit = moved.ball.rally > ball.rally;
    if (pickups.length < config.pickupMax && hit && moved.ball.rally % config.pickupVolley === 0) {
      let pickup: Pickup;
      [pickup, pickupTimer, seed] = spawnPickup(seed, pickups, config);
      pickups = [...pickups, pickup];
      events.push({ type: 'spawn', kind: pickup.kind });
    }
  }

  if (config.powerUps && pickups.length < config.pickupMax && balls.length > 0) {
    // The timer only runs while there's room on the board.
    pickupTimer = Math.max(0, (pickupTimer ?? 0) - 1);
    if (pickupTimer === 0) {
      let pickup: Pickup;
      [pickup, pickupTimer, seed] = spawnPickup(seed, pickups, config);
      pickups = [...pickups, pickup];
      events.push({ type: 'spawn', kind: pickup.kind });
    }
  }

  balls.push(...split);
  next = { ...next, gates, balls, scores, goals, seed };
  if (config.powerUps) {
    next.pickupTimer = pickupTimer ?? 0;
    if (pickups.length > 0) next.pickups = pickups;
    else delete next.pickups;
  }
  // The last ball gone: wait, then launch a new one.
  if (balls.length === 0) next = { ...next, balls: [restingBall()], respawnTicks: Math.round(config.respawnDelay * TICK_RATE) };
  return { state: next, events };
}

/** One tick off a gate's wide paddle and shield. */
function tickEffects(gate: GateState): GateState {
  const next = { ...gate };
  if (gate.wideTicks) next.wideTicks = gate.wideTicks - 1;
  if (gate.shieldTicks) next.shieldTicks = gate.shieldTicks - 1;
  if (!next.wideTicks) delete next.wideTicks;
  if (!next.shieldTicks) delete next.shieldTicks;
  return next;
}

function withoutShield(gate: GateState): GateState {
  const { shieldTicks: _, ...rest } = gate;
  return rest;
}

/** One tick off each token on the board; each is gone when it runs out. */
function tickPickups(state: GameState): GameState {
  if (!state.pickups) return state;
  const pickups = state.pickups.map((p) => ({ ...p, ticksLeft: p.ticksLeft - 1 })).filter((p) => p.ticksLeft > 0);
  if (pickups.length > 0) return { ...state, pickups };
  const { pickups: _, ...rest } = state;
  return rest;
}

/** Ticks until the timer's next token: between pickupMinSeconds and pickupMaxSeconds.  @returns [ticks, next seed] */
function pickupDelay(seed: number, config: PhysicsConfig): [number, number] {
  const [r, next] = nextRandom(seed);
  const seconds = config.pickupMinSeconds + r * Math.max(0, config.pickupMaxSeconds - config.pickupMinSeconds);
  return [Math.max(1, Math.round(seconds * TICK_RATE)), next];
}

/**
 * A new token, clear of the ones already out if it can be, and a fresh
 * timer.  @returns [token, timer, next seed]
 */
function spawnPickup(seed: number, others: readonly Pickup[], config: PhysicsConfig): [Pickup, number, number] {
  const [kindRoll, s1] = nextRandom(seed);
  let [x, y, s2] = pickupSpot(s1);
  for (let tries = 1; tries < PICKUP_PLACE_TRIES && others.some((p) => Math.hypot(p.x - x, p.y - y) < PICKUP_SPACING * config.pickupRadius); tries++) {
    [x, y, s2] = pickupSpot(s2);
  }
  const [timer, s3] = pickupDelay(s2, config);
  let kind = PICKUP_ODDS.at(-1)![0];
  let total = 0;
  for (const [candidate, odds] of PICKUP_ODDS) {
    total += odds;
    if (kindRoll < total) {
      kind = candidate;
      break;
    }
  }
  // Still rolled, so the seed moves on the same either way.
  if (config.multiballOnly) kind = 'multiball';
  const pickup = { kind, x, y, ticksLeft: Math.round(config.pickupLifetime * TICK_RATE) };
  return [pickup, timer, s3];
}

/** A random spot for a token, between PICKUP_MIN_RADIUS and PICKUP_MAX_RADIUS.  @returns [x, y, next seed] */
function pickupSpot(seed: number): [number, number, number] {
  const [radiusRoll, s1] = nextRandom(seed);
  const [angleRoll, s2] = nextRandom(s1);
  const r = PICKUP_MIN_RADIUS + radiusRoll * (PICKUP_MAX_RADIUS - PICKUP_MIN_RADIUS);
  const angle = angleRoll * 2 * Math.PI;
  return [r * Math.cos(angle), r * Math.sin(angle), s2];
}

/**
 * `count` more balls where `ball` is, at its speed, each heading a random
 * way whatever its heading.  @returns [balls, next seed]
 */
function splitBall(ball: BallState, count: number, seed: number): [BallState[], number] {
  const speed = ballSpeed(ball);
  const balls: BallState[] = [];
  for (let i = 0; i < count; i++) {
    let r: number;
    [r, seed] = nextRandom(seed);
    const angle = r * 2 * Math.PI;
    balls.push({ ...ball, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
  }
  return [balls, seed];
}

/** Whether the path (a polyline) comes within `radius` of the point. */
function pathMeets(path: [number, number][], point: { x: number; y: number }, radius: number): boolean {
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]!;
    const [bx, by] = path[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / length2));
    if (Math.hypot(ax + dx * t - point.x, ay + dy * t - point.y) <= radius) return true;
  }
  return false;
}

interface Moved {
  ball: BallState;
  seed: number;
  /** Where the ball went this tick: its start, each bounce, and its end. */
  path: [number, number][];
  /** Set when the ball went into a gate; `ball` is then where it went in. */
  goal?: { gate: number; scorer: number };
  /** The gate whose shield the ball broke. */
  shieldBroken?: number;
}

function moveBall(ball: BallState, index: number, gates: GateState[], startSeed: number, config: PhysicsConfig, events: PhysicsEvent[]): Moved {
  let { x, y, vx, vy, rally, lastTouch } = ball;
  let seed = startSeed;
  let shieldBroken: number | undefined;
  const path: [number, number][] = [[x, y]];
  const n = gates.length;
  const hitR = config.paddleRadius - config.ballRadius;
  const rimR = 1 - config.ballRadius;

  let remaining = DT;
  // Several collisions can happen in one tick (e.g. a hit right next to the
  // rim).  Each pass handles the earliest one and carries on from there.
  for (let pass = 0; pass < 4 && remaining > 1e-12; pass++) {
    const tPaddle = exitTime(x, y, vx, vy, hitR);
    const tRim = exitTime(x, y, vx, vy, rimR);

    if (tPaddle <= remaining && tPaddle < tRim) {
      const px = x + vx * tPaddle;
      const py = y + vy * tPaddle;
      const angle = Math.atan2(py, px);
      const gate = gates.findIndex(
        (g) => g.active && Math.abs(angleDiff(angle, g.paddle)) <= paddleReach(n, config, paddleWidth(g, config)),
      );
      if (gate !== -1) {
        const half = paddleHalfWidth(n, config, paddleWidth(gates[gate]!, config));
        const offset = Math.max(-1, Math.min(1, angleDiff(angle, gates[gate]!.paddle) / half));
        [vx, vy] = paddleBounce(px, py, vx, vy, offset, config);
        // Start just inside the paddle so the next pass doesn't see the same crossing.
        const len = Math.hypot(px, py);
        x = px - (px / len) * 1e-9;
        y = py - (py / len) * 1e-9;
        path.push([x, y]);
        remaining -= tPaddle;
        rally++;
        lastTouch = gate;
        events.push({ type: 'hit', gate, ball: index });
        continue;
      }
      // Missed the paddle: keep going toward the rim this pass.
    }

    if (tRim <= remaining) {
      const px = x + vx * tRim;
      const py = y + vy * tRim;
      const angle = Math.atan2(py, px);
      const goal = gateAt(angle, gates, config);
      const shielded = goal !== -1 && goal !== shieldBroken && (gates[goal]!.shieldTicks ?? 0) > 0;
      if (goal !== -1 && !shielded) {
        const scorer = goalScorer(goal, lastTouch, gates);
        events.push({ type: 'goal', gate: goal, scorer, ball: index });
        path.push([px, py]);
        return { ball: { x: px, y: py, vx, vy, rally, lastTouch }, seed, path, goal: { gate: goal, scorer }, ...(shieldBroken !== undefined ? { shieldBroken } : {}) };
      }
      // Wall, or a shield (which then breaks): mirror the velocity about the
      // rim normal, then turn it by a small random angle.
      if (shielded) {
        shieldBroken = goal;
        events.push({ type: 'shield', gate: goal, ball: index });
      }
      const nx = px / Math.hypot(px, py);
      const ny = py / Math.hypot(px, py);
      const dot = vx * nx + vy * ny;
      vx -= 2 * dot * nx;
      vy -= 2 * dot * ny;
      const [r, nextSeed] = nextRandom(seed);
      seed = nextSeed;
      [vx, vy] = jitterBounce(vx, vy, nx, ny, (r * 2 - 1) * config.wallJitter);
      x = px - nx * 1e-9;
      y = py - ny * 1e-9;
      path.push([x, y]);
      remaining -= tRim;
      if (!shielded) events.push({ type: 'wall' });
      continue;
    }

    x += vx * remaining;
    y += vy * remaining;
    remaining = 0;
  }
  path.push([x, y]);

  return { ball: { x, y, vx, vy, rally, lastTouch }, seed, path, ...(shieldBroken !== undefined ? { shieldBroken } : {}) };
}

/**
 * Who gets the point for a goal against `gate`: the last paddle to touch the
 * ball.  Nobody (-1) if no paddle touched it since the launch, if it was the
 * conceding player's own touch, or if that player has since left.  The goal
 * still counts toward the goal limit either way.
 *
 * Why not a point for everyone else?  Then a score only measured how often
 * you conceded, so scores bunched up.  Last touch rewards aiming, too.
 */
export function goalScorer(gate: number, lastTouch: number, gates: GateState[]): number {
  if (lastTouch < 0 || lastTouch === gate || !gates[lastTouch]?.active) return -1;
  return lastTouch;
}

/**
 * Picks a launch direction: a random point inside a random active gate.
 *
 * Launching in any direction meant a ball sent into a wall travelled along a
 * diameter, and with an even number of gates every wall faces another wall,
 * so it could bounce out of everyone's reach for a long time.  Aiming at a
 * gate means every launch reaches a paddle first.  The aim stays a ball's
 * width inside the gate's edges so it can't clip the wall.
 *
 * @returns [angle, next seed]
 */
export function launchAngle(gates: GateState[], seed: number, config: PhysicsConfig): [number, number] {
  const active = gates.flatMap((g, i) => (g.active ? [i] : []));
  const [r1, seed1] = nextRandom(seed);
  if (active.length === 0) return [r1 * 2 * Math.PI, seed1];

  const gate = active[Math.min(active.length - 1, Math.floor(r1 * active.length))]!;
  const [r2, seed2] = nextRandom(seed1);
  const spread = Math.max(0, gateHalfWidth(gates.length, config) - config.ballRadius);
  return [wrapAngle(gateCenter(gate, gates.length) + (r2 * 2 - 1) * spread), seed2];
}

/**
 * Turns a reflected velocity by `angle`, keeping its speed.  If that would
 * leave a grazing ball heading along or out through the rim, the plain
 * reflection is kept instead.
 */
function jitterBounce(vx: number, vy: number, nx: number, ny: number, angle: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const jx = vx * cos - vy * sin;
  const jy = vx * sin + vy * cos;
  const speed = Math.hypot(vx, vy);
  // Require a clearly inward heading: at least ~3° off the rim's tangent.
  return jx * nx + jy * ny < -0.05 * speed ? [jx, jy] : [vx, vy];
}

/**
 * Bounces off a paddle at contact point (px, py).
 * @param offset Where the ball hit, from -1 (clockwise end) to +1 (counterclockwise end).
 */
export function paddleBounce(px: number, py: number, vx: number, vy: number, offset: number, config: PhysicsConfig): [number, number] {
  const len = Math.hypot(px, py);
  const nx = px / len; // Outward normal.
  const ny = py / len;
  const tx = -ny; // Counterclockwise tangent.
  const ty = nx;

  const speed = Math.hypot(vx, vy);
  // Reflect the radial part, keep the tangential part, add english.
  let radial = -Math.abs(vx * nx + vy * ny);
  let tangential = vx * tx + vy * ty + config.english * offset * speed;

  // Normalize, keeping at least minRadialShare pointing inward.
  const mag = Math.hypot(radial, tangential);
  radial /= mag;
  tangential /= mag;
  if (-radial < config.minRadialShare) {
    radial = -config.minRadialShare;
    tangential = Math.sign(tangential || 1) * Math.sqrt(1 - radial * radial);
  }

  const newSpeed = Math.min(speed * config.speedUpPerHit, config.maxSpeed);
  return [(nx * radial + tx * tangential) * newSpeed, (ny * radial + ty * tangential) * newSpeed];
}
