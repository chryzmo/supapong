// Computer-controlled paddles, for the sandbox and for bots in a match (run by
// the host).  Pure, like physics.ts.
import {
  DT,
  angleDiff,
  exitTime,
  gateCenter,
  gateHalfWidth,
  paddleBounce,
  paddleHalfWidth,
  paddleWidth,
  type Dir,
  type GameState,
  type PhysicsConfig,
  type Pickup,
} from './physics';

/** The skill levels a host can pick for the bots in a match. */
export const BOT_LEVELS = [
  { label: 'Easy', skill: 0.3 },
  { label: 'Normal', skill: 0.6 },
  { label: 'Hard', skill: 0.9 },
] as const;

/** How far off its paddle's center a bot meets the ball, as a share of the half-width. */
const AIM_OFFSET = 0.3;
/** From this skill up (Hard), a bot aims its returns through a token when it can. */
const AIMS_FOR_TOKENS = 0.75;
/** Where on its paddle a bot will consider meeting the ball to reach a token: -0.8 to 0.8 of the half-width. */
const TOKEN_AIMS = Array.from({ length: 17 }, (_, i) => -0.8 + i * 0.1);

/**
 * Picks a direction for `gate`'s paddle.
 *
 * The bot aims where the ball will cross the paddle radius, but only once the
 * ball is heading its way and has come within reach.  Lower skill means it
 * reacts later (the ball must be closer), so it misses fast or angled shots.
 * Above 0.5 it also reads a ball still heading inward, the path it will take
 * after passing the middle, starting earlier with skill: from 0.9 (Hard) it
 * moves the moment the ball leaves another paddle.  A fast ball crosses the
 * board quicker than a paddle crosses its gate, so that head start is most of
 * what makes Hard hard.
 * It meets the ball off its paddle's center, so the return gets some english:
 * a centered hit sends a ball through the middle straight back to the gate
 * opposite, and two bots facing each other would trade it there for ages.
 * It picks the side that adds to the way the ball is already drifting, so
 * the angle grows with each return instead of one bot undoing the last.
 *
 * With several balls in play, it goes for the one it would meet soonest.
 * From AIMS_FOR_TOKENS up, if a token is out and some spot on its paddle
 * would send the ball through it, the bot meets the ball there instead, and
 * lines up more precisely to do it.
 *
 * @param skill 0 (sleepy) to 1 (reads every ball from the moment it's hit).
 */
export function botInput(state: GameState, gate: number, config: PhysicsConfig, skill = 0.7): Dir {
  const g = state.gates[gate];
  if (!g?.active) return 0;
  const n = state.gates.length;
  const hitR = config.paddleRadius - config.ballRadius;
  const half = paddleHalfWidth(n, config, paddleWidth(g, config));
  // Outward balls are read once this far out; inward ones once this close in.
  const reactRadius = (1 - skill) * hitR;
  const readAheadRadius = Math.max(0, Math.min(1, (skill - 0.5) / 0.4)) * hitR;

  let target = gateCenter(gate, n);
  let soonest = Infinity;
  let precise = false;
  for (const { x, y, vx, vy, rally } of state.respawnTicks === 0 ? state.balls : []) {
    const outward = x * vx + y * vy > 0;
    const r = Math.hypot(x, y);
    if (!(outward ? r >= reactRadius : r <= readAheadRadius)) continue;
    const t = exitTime(x, y, vx, vy, hitR);
    if (!Number.isFinite(t) || t >= soonest) continue;
    const crossing = Math.atan2(y + vy * t, x + vx * t);
    // Only chase balls headed for this gate's side of the board.
    if (Math.abs(angleDiff(crossing, gateCenter(gate, n))) >= Math.PI / n) continue;
    // Counterclockwise drift at the crossing; hitting the ball with the
    // paddle's counterclockwise end (paddle clockwise of it) adds to it.
    const drift = vy * Math.cos(crossing) - vx * Math.sin(crossing);
    const side = drift > 0 || (drift === 0 && rally % 2 === 0) ? 1 : -1;
    const throughToken = skill >= AIMS_FOR_TOKENS ? aimThroughAny(x + vx * t, y + vy * t, vx, vy, state.pickups ?? [], config) : null;
    const offset = throughToken ?? side * AIM_OFFSET;
    precise = throughToken !== null;
    // Meeting the ball `offset` of the half-width from the paddle's center
    // puts the paddle there, the other way.
    target = crossing - offset * half;
    soonest = t;
  }

  const diff = angleDiff(target, g.paddle);
  // Lining up for a token, stop as close as the paddle's step per tick
  // allows without overshooting back and forth.
  const step = config.paddleSpeed * 2 * gateHalfWidth(n, config) * DT;
  const deadzone = precise ? step * 0.6 : half * 0.25;
  if (Math.abs(diff) < deadzone) return 0;
  return diff > 0 ? 1 : -1;
}

/** aimThrough for the first of `tokens` the return can go through, or null if none. */
function aimThroughAny(px: number, py: number, vx: number, vy: number, tokens: readonly Pickup[], config: PhysicsConfig): number | null {
  for (const token of tokens) {
    const offset = aimThrough(px, py, vx, vy, token, config);
    if (offset !== null) return offset;
  }
  return null;
}

/**
 * Where on the paddle (as for paddleBounce's offset) to meet a ball arriving
 * at (px, py) with velocity (vx, vy) so it heads through `token`, or null if
 * nowhere does.  Of the spots that do, the middle one: the most room for
 * the paddle being a little off.
 */
function aimThrough(px: number, py: number, vx: number, vy: number, token: Pickup, config: PhysicsConfig): number | null {
  const radius = config.pickupRadius + config.ballRadius;
  const through = TOKEN_AIMS.filter((offset) => {
    const [bx, by] = paddleBounce(px, py, vx, vy, offset, config);
    // How close the return's line comes to the token, ahead of the paddle.
    const along = ((token.x - px) * bx + (token.y - py) * by) / (bx * bx + by * by);
    return along > 0 && Math.hypot(px + bx * along - token.x, py + by * along - token.y) <= radius;
  });
  if (through.length === 0) return null;
  return (through[0]! + through.at(-1)!) / 2;
}
