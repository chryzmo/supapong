// Computer-controlled paddles for the sandbox.  Pure, like physics.ts.
import {
  angleDiff,
  exitTime,
  gateCenter,
  paddleHalfWidth,
  type Dir,
  type GameState,
  type PhysicsConfig,
} from './physics';

/**
 * Picks a direction for `gate`'s paddle.
 *
 * The bot aims where the ball will cross the paddle radius, but only once the
 * ball is heading its way and has come within reach.  Lower skill means it
 * reacts later (the ball must be closer), so it misses fast or angled shots.
 *
 * @param skill 0 (sleepy) to 1 (reacts as soon as the ball heads its way).
 */
export function botInput(state: GameState, gate: number, config: PhysicsConfig, skill = 0.7): Dir {
  const g = state.gates[gate];
  if (!g?.active) return 0;
  const n = state.gates.length;
  const { x, y, vx, vy } = state.ball;
  const hitR = config.paddleRadius - config.ballRadius;

  let target = gateCenter(gate, n);
  const outward = x * vx + y * vy > 0;
  const reactRadius = (1 - skill) * hitR;
  if (state.respawnTicks === 0 && outward && Math.hypot(x, y) >= reactRadius) {
    const t = exitTime(x, y, vx, vy, hitR);
    if (Number.isFinite(t)) {
      const crossing = Math.atan2(y + vy * t, x + vx * t);
      // Only chase balls headed for this gate's side of the board.
      if (Math.abs(angleDiff(crossing, gateCenter(gate, n))) < Math.PI / n) target = crossing;
    }
  }

  const diff = angleDiff(target, g.paddle);
  const deadzone = paddleHalfWidth(n, config) * 0.25;
  if (Math.abs(diff) < deadzone) return 0;
  return diff > 0 ? 1 : -1;
}
