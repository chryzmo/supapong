// Canvas 2D drawing.  No game logic: it draws whatever state it's given.
import { TICK_RATE, gateCenter, gateHalfWidth, paddleHalfWidth, paddleWidth, type GameState, type Pickup, type PhysicsConfig } from './physics';

/** One color per seat, chosen to stay distinct on the dark background. */
export const SEAT_COLORS = ['#3ecf8e', '#4ea1ff', '#ff7a59', '#f5c542', '#c77dff', '#ff5c8a', '#3fd0d4', '#a3e635'] as const;

const BACKGROUND = '#0f1115';
const BOARD = '#151821';
const WALL = '#3a4150';
const TEXT = '#e6e8ee';
const MUTED = '#8b91a0';
const LABEL_FONT = '600 13px system-ui, sans-serif';
/** Distance from the rim to a label, in CSS pixels. */
const LABEL_GAP = 18;
/** Effects and tokens blink for their last this-many ticks, as a warning. */
const ENDING_TICKS = 2 * TICK_RATE;

export interface GateLabel {
  name: string;
  color: string;
}

export interface RenderView {
  labels: GateLabel[];
  /** The gate drawn at the bottom of the screen, or null for no rotation. */
  viewerGate: number | null;
  /** Gate to flash, e.g. just after it conceded. */
  flashGate?: number;
  /** Paddle to light up alongside the flash: the gate that scored. */
  scorerGate?: number;
  /** Big text in the middle, e.g. a countdown. */
  centerText?: string;
}

/** Sizes the canvas's backing store to its CSS size times devicePixelRatio, so lines stay crisp. */
export function fitCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { width, height };
}

export function draw(canvas: HTMLCanvasElement, state: GameState, config: PhysicsConfig, view: RenderView): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = fitCanvas(canvas);
  const dpr = canvas.width / width;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const n = state.gates.length;
  const cx = width / 2;
  const cy = height / 2;
  const labelText = (i: number): string => `${shorten(view.labels[i]?.name ?? '', 10)}  ${state.scores[i] ?? 0}`;
  ctx.font = LABEL_FONT;
  const labelWidth = Math.max(0, ...state.gates.map((_, i) => ctx.measureText(labelText(i)).width));
  // Leave room outside the rim for the labels: their width at the sides,
  // a line of text at the top and bottom.
  const R = Math.max(40, Math.min(width / 2 - LABEL_GAP - labelWidth - 8, height / 2 - LABEL_GAP - 20));
  // Rotate the world so the viewer's gate sits at the bottom (world angle -π/2).
  const rotation = view.viewerGate === null ? 0 : -Math.PI / 2 - gateCenter(view.viewerGate, n);

  // World angle -> canvas angle.  The world is y-up and counterclockwise; the
  // canvas is y-down, so angles flip sign.
  const screenAngle = (a: number): number => -(a + rotation);
  const toScreen = (x: number, y: number): [number, number] => {
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    return [cx + R * (x * c - y * s), cy - R * (x * s + y * c)];
  };
  /** Strokes the world arc from a1 counterclockwise to a2 at radius r. */
  const arc = (r: number, a1: number, a2: number): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * R, screenAngle(a1), screenAngle(a2), true);
    ctx.stroke();
  };

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = BOARD;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fill();

  const gateHalf = gateHalfWidth(n, config);
  ctx.lineCap = 'round';
  /** On or off, four times a second, for something about to run out. */
  const blinkOff = (ticksLeft: number): boolean => ticksLeft < ENDING_TICKS && Math.floor(state.tick / (TICK_RATE / 8)) % 2 === 1;

  // Walls: the rim between gates, plus any gate whose player has left.
  ctx.strokeStyle = WALL;
  ctx.lineWidth = Math.max(3, R * 0.02);
  for (let i = 0; i < n; i++) {
    const center = gateCenter(i, n);
    const nextCenter = center + (2 * Math.PI) / n;
    arc(1, center + gateHalf, nextCenter - gateHalf);
    if (!state.gates[i]!.active) arc(1, center - gateHalf, center + gateHalf);
  }

  // Gate openings: a thin line in the defender's color.
  for (let i = 0; i < n; i++) {
    if (!state.gates[i]!.active) continue;
    const color = view.labels[i]?.color ?? MUTED;
    const center = gateCenter(i, n);
    ctx.strokeStyle = color;
    ctx.globalAlpha = view.flashGate === i ? 0.9 : 0.3;
    ctx.lineWidth = view.flashGate === i ? Math.max(4, R * 0.03) : 2;
    arc(1, center - gateHalf, center + gateHalf);
    ctx.globalAlpha = 1;
  }

  // Shields: a bright arc in the owner's color across their gate.
  state.gates.forEach((gate, i) => {
    if (!gate.active || !gate.shieldTicks || blinkOff(gate.shieldTicks)) return;
    const color = view.labels[i]?.color ?? TEXT;
    const center = gateCenter(i, n);
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.lineWidth = Math.max(4, R * 0.025);
    arc(1, center - gateHalf, center + gateHalf);
    ctx.shadowBlur = 0;
  });

  // Paddles.  A wide one glows while it lasts.
  ctx.lineWidth = Math.max(5, R * 0.03);
  state.gates.forEach((gate, i) => {
    if (!gate.active) return;
    const color = view.labels[i]?.color ?? TEXT;
    ctx.strokeStyle = color;
    const wide = !!gate.wideTicks && !blinkOff(gate.wideTicks);
    if (view.scorerGate === i || wide) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
    }
    const half = paddleHalfWidth(n, config, paddleWidth(gate, config));
    arc(config.paddleRadius, gate.paddle - half, gate.paddle + half);
    ctx.shadowBlur = 0;
  });

  if (state.pickup && !blinkOff(state.pickup.ticksLeft)) {
    const [px, py] = toScreen(state.pickup.x, state.pickup.y);
    drawToken(ctx, px, py, Math.max(8, config.pickupRadius * R), state.pickup.kind);
  }

  // Balls, with a soft glow, each in the color of whoever would score if it
  // went in now (the last paddle to touch it), or white before anyone has.
  if (state.respawnTicks === 0) {
    for (const ball of state.balls) {
      const [bx, by] = toScreen(ball.x, ball.y);
      const ballColor = view.labels[ball.lastTouch]?.color ?? TEXT;
      ctx.fillStyle = ballColor;
      ctx.shadowColor = ballColor;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(3, config.ballRadius * R), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // Names and scores outside each gate, kept upright.
  // Labels grow away from the board: left of it on the left side, and so on.
  ctx.textBaseline = 'middle';
  ctx.font = LABEL_FONT;
  for (let i = 0; i < n; i++) {
    const label = view.labels[i];
    if (!label) continue;
    const center = gateCenter(i, n);
    const [lx, ly] = toScreen(Math.cos(center) * (1 + LABEL_GAP / R), Math.sin(center) * (1 + LABEL_GAP / R));
    const side = (lx - cx) / R;
    ctx.textAlign = side < -0.3 ? 'right' : side > 0.3 ? 'left' : 'center';
    ctx.globalAlpha = state.gates[i]!.active ? 1 : 0.4;
    ctx.fillStyle = label.color;
    ctx.fillText(labelText(i), lx, ly);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'center';

  if (view.centerText) {
    ctx.fillStyle = TEXT;
    ctx.font = `700 ${Math.round(R * 0.16)}px system-ui, sans-serif`;
    ctx.fillText(view.centerText, cx, cy);
  }
}

/** A token: a ring with an icon for its kind, in plain white so it isn't mistaken for a player's color. */
function drawToken(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, kind: Pickup['kind']): void {
  ctx.save();
  ctx.strokeStyle = TEXT;
  ctx.fillStyle = TEXT;
  ctx.shadowColor = TEXT;
  ctx.shadowBlur = 10;
  ctx.lineWidth = Math.max(2, r * 0.14);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.beginPath();
  if (kind === 'wide') {
    // A bar with arrowheads: wider.
    const w = r * 0.55;
    const a = r * 0.22;
    ctx.moveTo(x - w, y);
    ctx.lineTo(x + w, y);
    ctx.moveTo(x - w + a, y - a);
    ctx.lineTo(x - w, y);
    ctx.lineTo(x - w + a, y + a);
    ctx.moveTo(x + w - a, y - a);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - a, y + a);
    ctx.stroke();
  } else if (kind === 'shield') {
    // A shield: flat top, coming to a point.
    const w = r * 0.42;
    ctx.moveTo(x - w, y - w);
    ctx.lineTo(x + w, y - w);
    ctx.quadraticCurveTo(x + w, y + w * 0.6, x, y + w * 1.15);
    ctx.quadraticCurveTo(x - w, y + w * 0.6, x - w, y - w);
    ctx.stroke();
  } else {
    // Three balls.
    const d = r * 0.3;
    for (const [dx, dy] of [[0, -d], [-d * 0.95, d * 0.6], [d * 0.95, d * 0.6]] as const) {
      ctx.moveTo(x + dx + r * 0.16, y + dy);
      ctx.arc(x + dx, y + dy, r * 0.16, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
  ctx.restore();
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
