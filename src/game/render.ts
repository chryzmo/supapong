// Canvas 2D drawing.  No game logic: it draws whatever state it's given.
import { gateCenter, gateHalfWidth, paddleHalfWidth, type GameState, type PhysicsConfig } from './physics';

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
  const paddleHalf = paddleHalfWidth(n, config);
  ctx.lineCap = 'round';

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

  // Paddles.
  ctx.lineWidth = Math.max(5, R * 0.03);
  state.gates.forEach((gate, i) => {
    if (!gate.active) return;
    ctx.strokeStyle = view.labels[i]?.color ?? TEXT;
    arc(config.paddleRadius, gate.paddle - paddleHalf, gate.paddle + paddleHalf);
  });

  // Ball, with a soft glow.
  if (state.respawnTicks === 0) {
    const [bx, by] = toScreen(state.ball.x, state.ball.y);
    ctx.fillStyle = TEXT;
    ctx.shadowColor = TEXT;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(bx, by, Math.max(3, config.ballRadius * R), 0, 2 * Math.PI);
    ctx.fill();
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

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
