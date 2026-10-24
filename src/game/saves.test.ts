import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DT, gateCenter, paddleReach, type Ball } from './physics';
import { detectSave, type DrawnFrame } from './saves';

const config = DEFAULT_CONFIG;
const n = 3;
const gate = gateCenter(1, n);
const hitR = config.paddleRadius - config.ballRadius;
const speed = 1.2;

/** The ball on its way out along the gate's center line, `r` from the middle. */
function outward(r: number, angle = gate): Ball {
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

/** Two frames one tick apart, with the ball crossing the paddle line halfway between. */
function frames(paddle: number, after: Partial<DrawnFrame> = {}): [DrawnFrame, DrawnFrame] {
  const r = hitR - (speed * DT) / 2;
  const prev = { tick: 100, balls: [outward(r)], respawnTicks: 0, paddle };
  const next = { tick: 101, balls: [outward(r + speed * DT)], respawnTicks: 0, paddle, ...after };
  return [prev, next];
}

describe('detectSave', () => {
  it('claims a save when our paddle covers the spot and the host had no bounce', () => {
    const claim = detectSave(...frames(gate), n, config);
    expect(claim?.tick).toBeCloseTo(100.5, 6);
    expect(claim?.paddle).toBeCloseTo(gate, 9);
  });

  it('reports the paddle partway through the frame, when the ball got there', () => {
    const [prev, next] = frames(gate - 0.02, {});
    const claim = detectSave(prev, { ...next, paddle: gate + 0.02 }, n, config);
    expect(claim?.paddle).toBeCloseTo(gate, 6);
  });

  it('claims through a goal: the host reset the ball, so it missed', () => {
    expect(detectSave(...frames(gate, { respawnTicks: 70, balls: [{ x: 0, y: 0, vx: 0, vy: 0 }] }), n, config)).not.toBeNull();
  });

  it('claims for whichever ball it was, by index', () => {
    const [prev, next] = frames(gate);
    const elsewhere = outward(0.3);
    const claim = detectSave({ ...prev, balls: [elsewhere, prev.balls[0]!] }, { ...next, balls: [elsewhere, next.balls[0]!] }, n, config);
    expect(claim?.ball).toBe(1);
    expect(claim?.tick).toBeCloseTo(100.5, 6);
  });

  it('reaches as far as a wide paddle does', () => {
    const off = paddleReach(n, config) + 0.01;
    const [prev, next] = frames(gate + off);
    expect(detectSave(prev, next, n, config)).toBeNull();
    expect(detectSave({ ...prev, width: 1.6 }, { ...next, width: 1.6 }, n, config)).not.toBeNull();
  });

  it("doesn't claim when the paddle doesn't cover the spot", () => {
    const off = paddleReach(n, config) + 0.01;
    expect(detectSave(...frames(gate + off), n, config)).toBeNull();
  });

  it("doesn't claim when the host had it bounce", () => {
    const back = outward(hitR - 0.01);
    expect(detectSave(...frames(gate, { balls: [{ ...back, vx: -back.vx, vy: -back.vy }] }), n, config)).toBeNull();
  });

  it("doesn't claim when the ball doesn't reach the paddle line in the frame", () => {
    const [prev, next] = frames(gate);
    expect(detectSave({ ...prev, balls: [outward(0.5)] }, next, n, config)).toBeNull();
  });

  it("doesn't claim for a ball heading in, waiting at the center, or no time passing", () => {
    const [prev, next] = frames(gate);
    expect(detectSave({ ...prev, balls: [{ ...prev.balls[0]!, vx: -prev.balls[0]!.vx, vy: -prev.balls[0]!.vy }] }, next, n, config)).toBeNull();
    expect(detectSave({ ...prev, respawnTicks: 10 }, next, n, config)).toBeNull();
    expect(detectSave(prev, { ...next, tick: prev.tick }, n, config)).toBeNull();
  });
});
