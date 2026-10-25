import { describe, expect, it } from 'vitest';
import { fitBoard, type LabelBox } from './render';

const bottom: LabelBox = { dx: 0, dy: 1, width: 95 };
const top: LabelBox = { dx: 0, dy: -1, width: 95 };
const left: LabelBox = { dx: -1, dy: 0, width: 95 };
const right: LabelBox = { dx: 1, dy: 0, width: 95 };

describe('fitBoard', () => {
  it('spends only height on labels at the top and bottom', () => {
    const { radius, inside } = fitBoard(720, 720, [bottom, top]);
    expect(inside).toBe(false);
    // Half the canvas, less the edge, half a line of text and the gap.
    expect(radius).toBe(360 - 8 - 8 - 18);
  });

  it('puts labels outside when a wide canvas has room at the sides', () => {
    const { radius, inside } = fitBoard(1100, 760, [bottom, left, top, right]);
    expect(inside).toBe(false);
    expect(radius).toBe(380 - 8 - 8 - 18);
  });

  it('moves labels inside on a narrow screen rather than shrinking the board', () => {
    // A phone: outside, side labels would leave a radius of about 60.
    expect(fitBoard(358, 358, [bottom, left, top, right])).toEqual({ radius: 171, inside: true });
  });

  it('ignores the width of a missing label', () => {
    expect(fitBoard(358, 500, [{ ...left, width: 0 }, { ...right, width: 0 }]).inside).toBe(false);
  });
});
