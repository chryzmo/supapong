import type { Dir } from './physics';

// Touch buttons (touch.ts) hold these pseudo-keys, so every control goes
// through the same set.
export const TOUCH_LEFT = 'TouchLeft';
export const TOUCH_RIGHT = 'TouchRight';

const LEFT = new Set(['ArrowLeft', 'KeyA', TOUCH_LEFT]);
const RIGHT = new Set(['ArrowRight', 'KeyD', TOUCH_RIGHT]);

/**
 * Paddle direction from the keys (and touch buttons) held down.  The board is drawn with your
 * gate at the bottom, where counterclockwise is screen-right, so Right is +1.
 * Holding both cancels out.
 */
export function dirFromKeys(held: ReadonlySet<string>): Dir {
  const left = [...held].some((code) => LEFT.has(code));
  const right = [...held].some((code) => RIGHT.has(code));
  return left === right ? 0 : right ? 1 : -1;
}

export interface PaddleInput {
  dir(): Dir;
  /** Presses or releases a control that isn't a key, such as a touch button. */
  hold(code: string, down: boolean): void;
  dispose(): void;
}

/**
 * Tracks the paddle keys on `window`, plus anything pressed through hold().
 * Calls onChange only when the direction changes.
 */
export function paddleInput(onChange?: (dir: Dir) => void): PaddleInput {
  const held = new Set<string>();
  let last: Dir = 0;

  const update = (): void => {
    const dir = dirFromKeys(held);
    if (dir !== last) {
      last = dir;
      onChange?.(dir);
    }
  };
  const down = (e: KeyboardEvent): void => {
    if (!LEFT.has(e.code) && !RIGHT.has(e.code)) return;
    e.preventDefault();
    held.add(e.code);
    update();
  };
  const up = (e: KeyboardEvent): void => {
    held.delete(e.code);
    update();
  };
  // Keys released while the window is unfocused never fire keyup.
  const blur = (): void => {
    held.clear();
    update();
  };

  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return {
    dir: () => last,
    hold(code, down) {
      if (down) held.add(code);
      else held.delete(code);
      update();
    },
    dispose() {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    },
  };
}
