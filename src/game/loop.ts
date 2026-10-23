import { DT } from './physics';

/** Longest frame gap we catch up on.  After a stall (e.g. a background tab) we skip ahead instead. */
const MAX_FRAME_SECONDS = 0.25;

export interface FixedLoop {
  stop(): void;
  setPaused(paused: boolean): void;
}

/**
 * Runs `tick` at a fixed 60 Hz and `draw` once per animation frame.
 *
 * Physics needs fixed steps to be deterministic, while screens refresh at
 * whatever rate they like.  Each frame runs however many ticks have come due,
 * then draws with `alpha`, how far we are between the last tick and the next
 * (0..1), so rendering can blend the two and look smooth on any display.
 */
export function startFixedLoop(tick: () => void, draw: (alpha: number) => void): FixedLoop {
  let last = performance.now();
  let accumulator = 0;
  let paused = false;
  let frame = requestAnimationFrame(function loop(now) {
    const elapsed = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
    last = now;
    if (!paused) {
      accumulator += elapsed;
      while (accumulator >= DT) {
        tick();
        accumulator -= DT;
      }
    }
    draw(paused ? 1 : accumulator / DT);
    frame = requestAnimationFrame(loop);
  });

  return {
    stop: () => cancelAnimationFrame(frame),
    setPaused(value) {
      paused = value;
    },
  };
}
