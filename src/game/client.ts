// A non-host player's side of a match: buffers the host's snapshots, draws
// slightly in the past so motion is smooth, and predicts its own paddle so
// keys feel instant.
import type { Gate, StateMessage } from '../types';
import { DEFAULT_CONFIG, angleDiff, createGame, movePaddle, type Dir, type GameState, type PhysicsConfig } from './physics';
import { SnapshotBuffer, decodeState } from './snapshot';

/** Share of the gap to the host's paddle closed per frame once we stop moving. */
const RECONCILE_RATE = 0.15;

export interface ClientOptions {
  config?: PhysicsConfig;
  now?: () => number;
}

export class ClientGame {
  private readonly buffer = new SnapshotBuffer();
  private readonly config: PhysicsConfig;
  private readonly now: () => number;
  private readonly initial: GameState;
  private ownDir: Dir = 0;
  private ownPaddle: number;
  private lastViewAt: number | undefined;

  /**
   * @param sendInput Called when our direction changes.  Inputs are only sent
   *   on change, which keeps traffic low: one message per key press or release.
   */
  constructor(
    readonly gates: Gate[],
    readonly myGate: number,
    private readonly sendInput: (dir: Dir) => void,
    options: ClientOptions = {},
  ) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.now = options.now ?? (() => performance.now());
    this.initial = createGame(gates.length, 0, this.config);
    this.ownPaddle = this.initial.gates[myGate]?.paddle ?? 0;
  }

  onState(message: StateMessage): void {
    this.buffer.push(decodeState(message), this.now());
  }

  hasState(): boolean {
    return this.buffer.latest() !== undefined;
  }

  setOwnInput(dir: Dir): void {
    if (dir === this.ownDir) return;
    this.ownDir = dir;
    this.sendInput(dir);
  }

  /**
   * The state to draw now: the host's snapshots, interpolated about 100 ms in
   * the past, with our own paddle replaced by the locally predicted one.
   */
  view(): GameState {
    const now = this.now();
    const dt = this.lastViewAt === undefined ? 0 : Math.min((now - this.lastViewAt) / 1000, 0.1);
    this.lastViewAt = now;

    const n = this.gates.length;
    this.ownPaddle = movePaddle(this.ownPaddle, this.myGate, n, this.ownDir, dt, this.config);
    // While we're still, ease toward where the host has our paddle.  While
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
