import type { Dir } from './physics';

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);

/**
 * Paddle direction from the keys held down.  The board is drawn with your
 * gate at the bottom, where counterclockwise is screen-right, so Right is +1.
 * Holding both cancels out.
 */
export function dirFromKeys(held: ReadonlySet<string>): Dir {
  const left = [...held].some((code) => LEFT.has(code));
  const right = [...held].some((code) => RIGHT.has(code));
  return left === right ? 0 : right ? 1 : -1;
}

export interface KeyboardInput {
  dir(): Dir;
  dispose(): void;
}

/** Tracks the paddle keys on `window`.  Calls onChange only when the direction changes. */
export function keyboardInput(onChange?: (dir: Dir) => void): KeyboardInput {
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
    dispose() {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    },
  };
}
