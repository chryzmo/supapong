// Spotting, on a guest's screen, a save the host may have missed.  Pure;
// unit tested in saves.test.ts.
//
// A guest draws the ball as the host had it ~100 ms ago, but their own
// paddle where it is now.  So the guest's screen can show the ball meeting
// their paddle where the host, with the paddle as it was then, saw a miss.
// When that happens the guest tells the host, which rewinds and replays the
// moment with the guest's paddle (HostGame.claimSave).
import { DT, angleDiff, exitTime, paddleReach, wrapAngle, type Ball, type PhysicsConfig } from './physics';

/** What a guest drew in one frame. */
export interface DrawnFrame {
  /** The host tick the frame shows, fractional. */
  tick: number;
  ball: Ball;
  respawnTicks: number;
  /** The guest's own paddle, as drawn. */
  paddle: number;
}

export interface SaveClaim {
  /** Host tick when the ball reached the paddle, fractional. */
  tick: number;
  /** Where the guest's paddle was then. */
  paddle: number;
}

/**
 * A save to claim if, between frames `prev` and `next`, the ball reached the
 * guest's paddle line with the guest's paddle covering that spot, while the
 * host's version (the ball the guest is drawing) didn't bounce off it.
 */
export function detectSave(prev: DrawnFrame, next: DrawnFrame, gateCount: number, config: PhysicsConfig): SaveClaim | null {
  if (next.tick <= prev.tick || prev.respawnTicks > 0) return null;
  const { x, y, vx, vy } = prev.ball;
  if (x * vx + y * vy <= 0) return null; // Heading in, not out.
  const t = exitTime(x, y, vx, vy, config.paddleRadius - config.ballRadius);
  const span = (next.tick - prev.tick) * DT;
  if (t > span) return null; // Doesn't reach the paddle line in this frame.
  // Heading back in already means the host had it bounce: nothing to claim.
  const after = next.ball;
  if (next.respawnTicks === 0 && after.x * after.vx + after.y * after.vy < 0) return null;

  const angle = Math.atan2(y + vy * t, x + vx * t);
  // The paddle partway through the frame, when the ball got there.
  const paddle = wrapAngle(prev.paddle + angleDiff(next.paddle, prev.paddle) * (t / span));
  if (Math.abs(angleDiff(angle, paddle)) > paddleReach(gateCount, config)) return null;
  return { tick: prev.tick + t / DT, paddle };
}
