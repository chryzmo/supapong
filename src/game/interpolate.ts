// Blending between two game states for drawing.  Pure.
import { angleDiff, wrapAngle, type GameState } from './physics';

/**
 * The state `alpha` of the way from `a` to `b` (0..1), for drawing between
 * ticks (and, in networked play, between snapshots).
 *
 * The ball isn't blended across a goal or launch, when it teleports to or
 * from the center: it stays as in `a` until `b` is reached.  Paddles blend
 * along the short way round the circle.
 */
export function interpolate(a: GameState, b: GameState, alpha: number): GameState {
  const t = Math.max(0, Math.min(1, alpha));
  const teleported = a.respawnTicks === 0 !== (b.respawnTicks === 0);
  if (teleported && t < 1) return { ...b, ball: a.ball, respawnTicks: a.respawnTicks, gates: blendGates(a, b, t) };
  const ball = teleported
    ? b.ball
    : {
        x: a.ball.x + (b.ball.x - a.ball.x) * t,
        y: a.ball.y + (b.ball.y - a.ball.y) * t,
        vx: b.ball.vx,
        vy: b.ball.vy,
      };
  return { ...b, ball, gates: blendGates(a, b, t) };
}

function blendGates(a: GameState, b: GameState, t: number): GameState['gates'] {
  return b.gates.map((gate, i) => {
    const from = a.gates[i];
    if (!from || !from.active || !gate.active) return gate;
    return { ...gate, paddle: wrapAngle(from.paddle + angleDiff(gate.paddle, from.paddle) * t) };
  });
}
