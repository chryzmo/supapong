// A non-host player's side of a match: buffers the host's snapshots, draws
// slightly in the past so motion is smooth, and predicts its own paddle so
// keys feel instant.
import type { Gate, StateMessage } from '../types';
import { DEFAULT_CONFIG, angleDiff, createGame, movePaddle, type Dir, type GameState, type PhysicsConfig } from './physics';
import { detectSave, type DrawnFrame, type SaveClaim } from './saves';
import { SnapshotBuffer, decodeState } from './snapshot';

/** Share of the gap to the host's paddle closed per frame once we stop moving. */
const RECONCILE_RATE = 0.15;
/**
 * Don't ease toward the host's copy of our paddle this soon after we sent an
 * input.  Until the host has it, its snapshots still show our paddle moving,
 * and easing toward them made the paddle wobble after every key release.
 */
const RECONCILE_AFTER_MS = 500;
/** While moving, resend our paddle position this often, so the host's copy can't drift. */
export const RESEND_MS = 200;
/** Ticks between save claims, so one save is claimed once. */
const CLAIM_GAP_TICKS = 20;
/**
 * How long after a claimed save we keep drawing it before giving up on the
 * host agreeing: its claim window plus a round trip, in ticks.
 */
const CLAIM_PATIENCE_TICKS = 30;

export interface ClientOptions {
  config?: PhysicsConfig;
  now?: () => number;
}

export class ClientGame {
  private readonly buffer: SnapshotBuffer;
  private readonly config: PhysicsConfig;
  private readonly now: () => number;
  private readonly initial: GameState;
  private ownDir: Dir = 0;
  private ownPaddle: number;
  private lastViewAt: number | undefined;
  private lastSentAt = -Infinity;
  private lastFrame: DrawnFrame | undefined;
  private lastClaimTick = -Infinity;
  /**
   * A save we claimed, drawn locally until the host's corrected snapshots
   * reach the screen (from `until` on), or until we give up on it.  Without
   * this, the snapshots already on their way would show the goal first.
   */
  private claim: (SaveClaim & { until?: number }) | undefined;

  /**
   * @param sendInput Called with our direction and paddle position when the
   *   direction changes, and every RESEND_MS while moving.  Standing still
   *   sends nothing, which keeps traffic low.  `save` is set when our screen
   *   showed a save (see saves.ts).
   */
  constructor(
    readonly gates: Gate[],
    readonly myGate: number,
    private readonly sendInput: (dir: Dir, paddle: number, save?: SaveClaim) => void,
    options: ClientOptions = {},
  ) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.buffer = new SnapshotBuffer(this.config);
    this.now = options.now ?? (() => performance.now());
    this.initial = createGame(gates.length, 0, this.config);
    this.ownPaddle = this.initial.gates[myGate]?.paddle ?? 0;
  }

  onState(message: StateMessage): void {
    this.buffer.push(decodeState(message), this.now(), message.seed !== undefined);
    // The host took our save: from this snapshot on, its version has it.
    const claim = this.claim;
    if (claim && claim.until === undefined && message.tick > claim.tick && message.balls[claim.ball]?.[4] === this.myGate) claim.until = message.tick;
  }

  hasState(): boolean {
    return this.buffer.latest() !== undefined;
  }

  setOwnInput(dir: Dir): void {
    if (dir === this.ownDir) return;
    // Bring the paddle up to the moment of the key change before reporting it.
    this.advanceOwnPaddle(this.now());
    this.ownDir = dir;
    this.send(this.now());
  }

  private send(now: number): void {
    this.lastSentAt = now;
    this.sendInput(this.ownDir, this.ownPaddle);
  }

  /** Moves our predicted paddle for the time since it last moved. */
  private advanceOwnPaddle(now: number): void {
    const dt = this.lastViewAt === undefined ? 0 : Math.min((now - this.lastViewAt) / 1000, 0.1);
    this.lastViewAt = now;
    this.ownPaddle = movePaddle(this.ownPaddle, this.myGate, this.gates.length, this.ownDir, dt, this.config);
  }

  /**
   * The state to draw now: the host's snapshots, interpolated about 100 ms in
   * the past, with our own paddle replaced by the locally predicted one.
   */
  view(): GameState {
    const now = this.now();
    this.advanceOwnPaddle(now);
    if (this.ownDir !== 0 && now - this.lastSentAt >= RESEND_MS) this.send(now);
    // Once we've been still a while, ease toward where the host has our
    // paddle.  The host adopts our position, so this only matters if a
    // message was lost.
    const hostPaddle = this.buffer.latest()?.gates[this.myGate]?.paddle;
    if (hostPaddle !== undefined && this.ownDir === 0 && now - this.lastSentAt >= RECONCILE_AFTER_MS) {
      this.ownPaddle += angleDiff(hostPaddle, this.ownPaddle) * RECONCILE_RATE;
    }

    const renderTick = this.buffer.renderTick(now);
    const claim = this.claim;
    if (claim && renderTick !== undefined && renderTick > (claim.until ?? claim.tick + CLAIM_PATIENCE_TICKS)) this.claim = undefined;
    const state =
      (this.claim ? this.buffer.sampleWithSave(now, this.myGate, this.claim.tick, this.claim.paddle) : this.buffer.sample(now)) ??
      this.initial;
    const own = state.gates[this.myGate];
    if (!own?.active) return state;
    this.checkForSave(state, renderTick);
    return { ...state, gates: state.gates.map((g, i) => (i === this.myGate ? { ...g, paddle: this.ownPaddle } : g)) };
  }

  /** Claims a save if, since the last frame, our screen showed one the host's ball doesn't. */
  private checkForSave(state: GameState, tick: number | undefined): void {
    if (tick === undefined) return;
    const frame: DrawnFrame = { tick, balls: state.balls, respawnTicks: state.respawnTicks, paddle: this.ownPaddle };
    const claim = this.lastFrame && detectSave(this.lastFrame, frame, this.gates.length, this.config);
    this.lastFrame = frame;
    if (!claim || claim.tick - this.lastClaimTick < CLAIM_GAP_TICKS) return;
    this.lastClaimTick = claim.tick;
    this.claim = claim;
    this.sendInput(this.ownDir, this.ownPaddle, claim);
  }

  /** Our paddle angle as predicted locally.  Exposed for tests. */
  predictedPaddle(): number {
    return this.ownPaddle;
  }
}
