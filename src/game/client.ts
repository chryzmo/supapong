// A non-host player's side of a match: buffers the host's snapshots, draws
// slightly in the past so motion is smooth, and predicts its own paddle so
// keys feel instant.
import type { Gate, StateMessage } from '../types';
import { DEFAULT_CONFIG, angleDiff, createGame, movePaddle, type Dir, type GameState, type PhysicsConfig } from './physics';
import { SnapshotBuffer, decodeState } from './snapshot';

/** Share of the gap to the host's paddle closed per frame once we stop moving. */
const RECONCILE_RATE = 0.15;
/** While moving, resend our paddle position this often, so the host's copy can't drift. */
export const RESEND_MS = 200;

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

  /**
   * @param sendInput Called with our direction and paddle position when the
   *   direction changes, and every RESEND_MS while moving.  Standing still
   *   sends nothing, which keeps traffic low.
   */
  constructor(
    readonly gates: Gate[],
    readonly myGate: number,
    private readonly sendInput: (dir: Dir, paddle: number) => void,
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
    // While we're still, ease toward where the host has our paddle.  The host
    // adopts our position, so this only matters if a message was lost.  While
    // moving, the host lags behind by our input's travel time, so leave it.
    const hostPaddle = this.buffer.latest()?.gates[this.myGate]?.paddle;
    if (hostPaddle !== undefined && this.ownDir === 0) {
      this.ownPaddle += angleDiff(hostPaddle, this.ownPaddle) * RECONCILE_RATE;
    }

    const state = this.buffer.sample(now) ?? this.initial;
    const own = state.gates[this.myGate];
    if (!own?.active) return state;
    return { ...state, gates: state.gates.map((g, i) => (i === this.myGate ? { ...g, paddle: this.ownPaddle } : g)) };
  }

  /** Our paddle angle as predicted locally.  Exposed for tests. */
  predictedPaddle(): number {
    return this.ownPaddle;
  }
}
