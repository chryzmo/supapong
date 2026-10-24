// Blending between two game states for drawing.  Pure.
import { angleDiff, wrapAngle, type GameState } from './physics';

/**
 * The state `alpha` of the way from `a` to `b` (0..1), for drawing between
 * ticks (and, in networked play, between snapshots).
 *
 * Balls blend by index.  They aren't blended across a goal or launch, when
 * a ball teleports to or from the center, or when the number of balls
 * changes: they stay as in `a` until `b` is reached.  Paddles blend along the
 * short way round the circle.
 */
export function interpolate(a: GameState, b: GameState, alpha: number): GameState {
  const t = Math.max(0, Math.min(1, alpha));
  const teleported = a.respawnTicks === 0 !== (b.respawnTicks === 0) || a.balls.length !== b.balls.length;
  if (teleported && t < 1) return { ...b, balls: a.balls, respawnTicks: a.respawnTicks, gates: blendGates(a, b, t) };
  const balls = teleported
    ? b.balls
    : b.balls.map((ball, i) => {
        const from = a.balls[i]!;
        return { ...ball, x: from.x + (ball.x - from.x) * t, y: from.y + (ball.y - from.y) * t };
      });
  return { ...b, balls, gates: blendGates(a, b, t) };
}

function blendGates(a: GameState, b: GameState, t: number): GameState['gates'] {
  return b.gates.map((gate, i) => {
    const from = a.gates[i];
    if (!from || !from.active || !gate.active) return gate;
    return { ...gate, paddle: wrapAngle(from.paddle + angleDiff(gate.paddle, from.paddle) * t) };
  });
}
