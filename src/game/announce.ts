// Who just collected a token, worked out from two drawn states.  Pure;
// unit tested in helpers.test.ts.
//
// Why not a message from the host?  Every screen already has what it needs:
// effects only count down, so a gate's wide or shield time going up means it
// just got one, and the ball count only goes up on a multiball, whose new
// balls carry the collector as their last toucher.  So guests and the host
// spot the same thing from the states they draw, with nothing new to send.
import type { GameState, PickupKind } from './physics';
import type { GateLabel, RenderView } from './render';

export interface Collected {
  gate: number;
  kind: PickupKind;
}

/** What got collected between drawing `prev` and `next`. */
export function collected(prev: GameState, next: GameState): Collected[] {
  const found: Collected[] = [];
  next.gates.forEach((gate, i) => {
    const before = prev.gates[i];
    if (!before || !gate.active) return;
    if ((gate.wideTicks ?? 0) > (before.wideTicks ?? 0)) found.push({ gate: i, kind: 'wide' });
    if ((gate.shieldTicks ?? 0) > (before.shieldTicks ?? 0)) found.push({ gate: i, kind: 'shield' });
  });
  const collector = next.balls.at(-1)?.lastTouch ?? -1;
  if (next.balls.length > prev.balls.length && collector >= 0) found.push({ gate: collector, kind: 'multiball' });
  return found;
}

/** "Ada: shield!" */
export function announcement(name: string, kind: PickupKind): string {
  const label = { wide: 'wide paddle', shield: 'shield', multiball: 'multiball' }[kind];
  return `${name}: ${label}!`;
}

/** How long an announcement stays up, and how long of that it spends fading out. */
const SHOW_MS = 1600;
const FADE_MS = 400;

/**
 * Watches the states a screen draws and announces each collection, one at a
 * time: a newer one replaces the last.
 */
export class Announcer {
  private prev: GameState | undefined;
  private current: { text: string; color: string; until: number } | undefined;

  /** The announcement to draw with `state` at time `now` (ms), if any. */
  next(state: GameState, now: number, labels: GateLabel[]): RenderView['announcement'] {
    const latest = this.prev ? collected(this.prev, state).at(-1) : undefined;
    this.prev = state;
    if (latest) {
      const label = labels[latest.gate];
      this.current = { text: announcement(label?.name ?? 'Someone', latest.kind), color: label?.color ?? '#e6e8ee', until: now + SHOW_MS };
    }
    const current = this.current;
    if (!current || now >= current.until) return undefined;
    return { text: current.text, color: current.color, alpha: Math.min(1, (current.until - now) / FADE_MS) };
  }
}
