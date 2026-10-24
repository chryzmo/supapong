// The line of text under the board.  Pure; unit tested in helpers.test.ts.
import { TICK_RATE, type GameState, type PhysicsConfig } from './physics';

/**
 * The clock, the goals, the longest rally, and `gate`'s power-ups, as parts
 * to join.  With no time limit (an infinite matchDuration) the clock counts
 * up; with no goal limit, the goals are just a count.
 */
export function hudParts(state: GameState, config: PhysicsConfig, gate: number): string[] {
  const played = state.tick / TICK_RATE;
  const timed = Number.isFinite(config.matchDuration);
  const clock = timed ? `${minutesSeconds(Math.max(0, config.matchDuration - played))} left` : `${minutesSeconds(played)} played`;
  const goals = Number.isFinite(config.goalLimit) ? `${state.goals}/${config.goalLimit} goals` : `${state.goals} goals`;
  const mine = state.gates[gate];
  return [
    clock,
    goals,
    `rally ${Math.max(...state.balls.map((b) => b.rally))}`,
    ...(mine?.wideTicks ? [`wide ${Math.ceil(mine.wideTicks / TICK_RATE)}s`] : []),
    ...(mine?.shieldTicks ? [`shield ${Math.ceil(mine.shieldTicks / TICK_RATE)}s`] : []),
  ];
}

/** 75 -> "1:15". */
function minutesSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
