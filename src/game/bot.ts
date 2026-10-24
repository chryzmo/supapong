// Computer-controlled paddles, for the sandbox and for bots in a match (run by
// the host).  Pure, like physics.ts.
import {
  angleDiff,
  exitTime,
  gateCenter,
  paddleHalfWidth,
  type Dir,
  type GameState,
  type PhysicsConfig,
} from './physics';

/** The skill levels a host can pick for the bots in a match. */
export const BOT_LEVELS = [
  { label: 'Easy', skill: 0.3 },
  { label: 'Normal', skill: 0.6 },
  { label: 'Hard', skill: 0.9 },
] as const;

/** How far off its paddle's center a bot meets the ball, as a share of the half-width. */
const AIM_OFFSET = 0.3;

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
 *
 * @param skill 0 (sleepy) to 1 (reads every ball from the moment it's hit).
 */
export function botInput(state: GameState, gate: number, config: PhysicsConfig, skill = 0.7): Dir {
  const g = state.gates[gate];
  if (!g?.active) return 0;
  const n = state.gates.length;
  const hitR = config.paddleRadius - config.ballRadius;
  // Outward balls are read once this far out; inward ones once this close in.
  const reactRadius = (1 - skill) * hitR;
  const readAheadRadius = Math.max(0, Math.min(1, (skill - 0.5) / 0.4)) * hitR;

  let target = gateCenter(gate, n);
  let soonest = Infinity;
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
    target = crossing - side * AIM_OFFSET * paddleHalfWidth(n, config);
    soonest = t;
  }

  const diff = angleDiff(target, g.paddle);
  const deadzone = paddleHalfWidth(n, config) * 0.25;
  if (Math.abs(diff) < deadzone) return 0;
  return diff > 0 ? 1 : -1;
}
