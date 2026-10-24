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
  /** Seconds the ball waits at the center before (re)launching. */
  respawnDelay: number;
  matchDuration: number;
  scoreCap: number;
}

export const DEFAULT_CONFIG: Readonly<PhysicsConfig> = {
  gateFraction: 0.6,
  paddleRadius: 0.92,
  paddleFraction: 0.3,
  paddleSpeed: 1.4,
  ballRadius: 0.022,
  launchSpeed: 0.55,
  speedUpPerHit: 1.05,
  maxSpeed: 1.5,
  english: 0.6,
  minRadialShare: 0.4,
  wallJitter: 0.09,
  respawnDelay: 1.2,
  matchDuration: 120,
  scoreCap: 10,
};

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GateState {
  /** False once the gate's player leaves: the gate becomes wall and has no paddle. */
  active: boolean;
  /** Paddle center angle. */
  paddle: number;
}

export interface GameState {
  tick: number;
  ball: Ball;
  gates: GateState[];
  /** Points per gate. */
  scores: number[];
  /** Ticks until the ball launches.  While > 0 the ball sits at the center. */
  respawnTicks: number;
  /** Consecutive paddle hits since the last launch. */
  rally: number;
  /** PRNG state. */
  seed: number;
}

export type PhysicsEvent =
  | { type: 'launch' }
  | { type: 'hit'; gate: number }
  | { type: 'wall' }
  | { type: 'goal'; gate: number };

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

export function paddleHalfWidth(gateCount: number, config: PhysicsConfig): number {
  return gateHalfWidth(gateCount, config) * config.paddleFraction;
}

/** How far the paddle center can move from the gate center, either way. */
export function paddleTravel(gateCount: number, config: PhysicsConfig): number {
  return gateHalfWidth(gateCount, config) - paddleHalfWidth(gateCount, config);
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

export function createGame(gateCount: number, seed: number, config: PhysicsConfig = DEFAULT_CONFIG): GameState {
  return {
    tick: 0,
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    gates: Array.from({ length: gateCount }, (_, i) => ({ active: true, paddle: gateCenter(i, gateCount) })),
    scores: Array.from({ length: gateCount }, () => 0),
    respawnTicks: Math.round(config.respawnDelay * TICK_RATE),
    rally: 0,
    seed: seed >>> 0,
  };
}

/** Turns a gate into wall (its player left) or back. */
export function setGateActive(state: GameState, gate: number, active: boolean): GameState {
  return { ...state, gates: state.gates.map((g, i) => (i === gate ? { ...g, active } : g)) };
}

export function isOver(state: GameState, config: PhysicsConfig): boolean {
  return state.tick >= config.matchDuration * TICK_RATE || state.scores.some((s) => s >= config.scoreCap);
}

export function ballSpeed(ball: Ball): number {
  return Math.hypot(ball.vx, ball.vy);
}

// Step ---------------------------------------------------------------------------

/**
 * Moves a paddle for `dt` seconds and keeps it inside its gate.  Shared by
 * step() and by clients predicting their own paddle between snapshots.
 */
export function movePaddle(paddle: number, gate: number, gateCount: number, dir: Dir, dt: number, config: PhysicsConfig): number {
  const center = gateCenter(gate, gateCount);
  const travel = paddleTravel(gateCount, config);
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

  const gates = state.gates.map((gate, i) =>
    gate.active ? { active: true, paddle: movePaddle(gate.paddle, i, n, inputs[i] ?? 0, DT, config) } : gate,
  );

  let next: GameState = { ...state, tick: state.tick + 1, gates };

  // Waiting at the center.
  if (state.respawnTicks > 0) {
    next.respawnTicks = state.respawnTicks - 1;
    if (next.respawnTicks === 0) {
      const [r, seed] = nextRandom(state.seed);
      const angle = r * 2 * Math.PI;
      next.seed = seed;
      next.rally = 0;
      next.ball = { x: 0, y: 0, vx: Math.cos(angle) * config.launchSpeed, vy: Math.sin(angle) * config.launchSpeed };
      events.push({ type: 'launch' });
    }
    return { state: next, events };
  }

  next = moveBall(next, config, events);
  return { state: next, events };
}

function moveBall(state: GameState, config: PhysicsConfig, events: PhysicsEvent[]): GameState {
  let { x, y, vx, vy } = state.ball;
  let rally = state.rally;
  let seed = state.seed;
  const n = state.gates.length;
  const hitR = config.paddleRadius - config.ballRadius;
  const rimR = 1 - config.ballRadius;
  const paddleHalf = paddleHalfWidth(n, config);
  // Count a hit if the ball's edge overlaps the paddle's end.
  const paddleReach = paddleHalf + config.ballRadius / config.paddleRadius;

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
      const gate = state.gates.findIndex(
        (g) => g.active && Math.abs(angleDiff(angle, g.paddle)) <= paddleReach,
      );
      if (gate !== -1) {
        const offset = Math.max(-1, Math.min(1, angleDiff(angle, state.gates[gate]!.paddle) / paddleHalf));
        [vx, vy] = paddleBounce(px, py, vx, vy, offset, config);
        // Start just inside the paddle so the next pass doesn't see the same crossing.
        const len = Math.hypot(px, py);
        x = px - (px / len) * 1e-9;
        y = py - (py / len) * 1e-9;
        remaining -= tPaddle;
        rally++;
        events.push({ type: 'hit', gate });
        continue;
      }
      // Missed the paddle: keep going toward the rim this pass.
    }

    if (tRim <= remaining) {
      const px = x + vx * tRim;
      const py = y + vy * tRim;
      const angle = Math.atan2(py, px);
      const goal = gateAt(angle, state.gates, config);
      if (goal !== -1) {
        events.push({ type: 'goal', gate: goal });
        return {
          ...state,
          ball: { x: 0, y: 0, vx: 0, vy: 0 },
          scores: state.scores.map((s, i) => (i !== goal && state.gates[i]!.active ? s + 1 : s)),
          respawnTicks: Math.round(config.respawnDelay * TICK_RATE),
          rally: 0,
          seed,
        };
      }
      // Wall: mirror the velocity about the rim normal, then turn it by a
      // small random angle.
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
      remaining -= tRim;
      events.push({ type: 'wall' });
      continue;
    }

    x += vx * remaining;
    y += vy * remaining;
    remaining = 0;
  }

  return { ...state, ball: { x, y, vx, vy }, rally, seed };
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
function paddleBounce(px: number, py: number, vx: number, vy: number, offset: number, config: PhysicsConfig): [number, number] {
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
