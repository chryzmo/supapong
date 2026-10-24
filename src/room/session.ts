// A player's connection to one room: the `room:{id}` Realtime channel, plus
// the host's job of removing seats whose players have disconnected.
//
// Why Presence for the roster?  The database knows who holds a seat, but not
// who is actually connected.  Presence is tied to the socket, so a closed tab
// or a dropped network shows up as a leave without any heartbeat code of ours.
//
// Why Broadcast for room events, inputs and game state?  They only matter to
// people connected right now, so there's no reason to write them to a table.
// Broadcast sends them straight to the other sockets on the channel.
//
// The session lives from entering a room until returning to the lobby, so the
// same channel carries the waiting room and the match.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, type AppClient } from '../supabase';
import {
  MIN_PLAYERS,
  parseInputMessage,
  parseRoomEvent,
  parseStateMessage,
  type Gate,
  type InputMessage,
  type Player,
  type RoomEvent,
  type RosterEntry,
  type SeatedRoom,
  type StateMessage,
} from '../types';
import { deleteRoom, fetchSeatIds, hasSeat, removePlayer, setRoomStatus } from './api';
import { AbsenceTracker, rosterFromPresence, staleSeats } from './presence';

/** How long a player can be missing from Presence before losing their seat. Covers a page reload. */
export const ROOM_GRACE_MS = 8000;
const CHECK_INTERVAL_MS = 2000;

export interface SessionOptions {
  client?: AppClient;
  graceMs?: number;
  checkIntervalMs?: number;
}

/** What the current screen wants to hear about.  One screen listens at a time. */
export interface SessionListener {
  roster?(roster: RosterEntry[]): void;
  event?(event: RoomEvent): void;
  /** The host has been missing for the grace period.  Non-hosts only. */
  hostGone?(): void;
  /** This player no longer has a seat: removed by the host, or lost during a disconnect. */
  seatLost?(): void;
  /** Host only: a player has been gone for the grace period and lost their seat. */
  playerGone?(playerId: string): void;
  /** Host only: a player's paddle input. */
  input?(message: InputMessage): void;
  /** Non-hosts: a game snapshot from the host. */
  state?(message: StateMessage): void;
}

export class RoomSession {
  readonly isHost: boolean;
  private readonly client: AppClient;
  private readonly graceMs: number;
  private readonly channel: RealtimeChannel;
  private readonly ready: Promise<void>;
  private listener: SessionListener = {};
  private roster: RosterEntry[] = [];
  private tracker: AbsenceTracker | undefined;
  private seatFirstSeen = new Map<string, number>();
  /** Everyone who has appeared in Presence, so the host notices leavers whose seat row is already gone. */
  private seenIds = new Set<string>();
  /** Players the host has already removed. */
  private gone = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private checking = false;
  private subscribedBefore = false;
  private phase: 'waiting' | 'playing' = 'waiting';
  private ended = false;

  constructor(
    readonly room: SeatedRoom,
    readonly player: Player,
    options: SessionOptions = {},
  ) {
    this.isHost = room.hostId === player.id;
    this.client = options.client ?? supabase;
    this.graceMs = options.graceMs ?? ROOM_GRACE_MS;

    this.channel = this.client.channel(`room:${room.id}`, {
      config: { presence: { key: player.id }, broadcast: { self: false } },
    });

    let markReady: () => void = () => {};
    this.ready = new Promise((resolve) => (markReady = resolve));

    this.channel
      .on('presence', { event: 'sync' }, () => this.onPresenceSync())
      .on('broadcast', { event: 'event' }, (message: { payload?: unknown }) => this.onBroadcast(message.payload))
      .on('broadcast', { event: 'input' }, (message: { payload?: unknown }) => {
        const input = this.isHost ? parseInputMessage(message.payload) : null;
        if (input) this.listener.input?.(input);
      })
      .on('broadcast', { event: 'state' }, (message: { payload?: unknown }) => {
        const state = this.isHost ? null : parseStateMessage(message.payload);
        if (state) this.listener.state?.(state);
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        void this.channel.track({ playerId: player.id, displayName: player.displayName, seat: room.seat });
        // A second SUBSCRIBED means the socket dropped and rejoined.  The host
        // may have removed our seat in the meantime, so check.
        if (this.subscribedBefore) void this.checkOwnSeat();
        this.subscribedBefore = true;
        markReady();
      });

    this.timer = setInterval(() => void this.check(), options.checkIntervalMs ?? CHECK_INTERVAL_MS);
  }

  /** Resolves once the channel has joined and this player is tracked. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Makes `listener` the only listener, and sends it the current roster. */
  listen(listener: SessionListener): void {
    this.listener = listener;
    listener.roster?.(this.roster);
  }

  getRoster(): RosterEntry[] {
    return this.roster;
  }

  async send(event: RoomEvent): Promise<void> {
    const result = await this.channel.send({ type: 'broadcast', event: 'event', payload: event });
    if (result !== 'ok') throw new Error(`Couldn't reach the room (${result}).`);
  }

  /** Fire and forget: a lost input is fixed by the next one, a lost snapshot by the next snapshot. */
  sendInput(message: InputMessage): void {
    void this.channel.send({ type: 'broadcast', event: 'input', payload: message });
  }

  sendState(message: StateMessage): void {
    void this.channel.send({ type: 'broadcast', event: 'state', payload: message });
  }

  /**
   * Host only.  Locks the room (no more joins), drops seats whose players
   * aren't connected, and tells everyone the gate order.
   */
  async startMatch(): Promise<Gate[]> {
    if (!this.isHost) throw new Error('Only the host can start the match.');
    const gates: Gate[] = this.roster.map(({ seat, playerId, displayName }) => ({ seat, playerId, displayName }));
    if (gates.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} connected players.`);

    await setRoomStatus(this.client, this.room.id, 'playing');
    const inMatch = new Set(gates.map((gate) => gate.playerId));
    for (const playerId of await fetchSeatIds(this.client, this.room.id)) {
      if (!inMatch.has(playerId)) await removePlayer(this.client, this.room.id, playerId);
    }
    this.phase = 'playing';
    await this.send({ type: 'start', gates });
    return gates;
  }

  /**
   * Leaves the room for good.  A guest gives up their seat.  The host tells
   * everyone first (there's no one to hear from afterwards), then closes the
   * room: deleting it while waiting, or marking it finished mid-match so the
   * match can still be recorded.
   */
  async leave(): Promise<void> {
    if (!this.isHost) {
      await removePlayer(this.client, this.room.id, this.player.id);
      return;
    }
    await this.send({ type: 'closed' }).catch(() => {});
    if (this.phase === 'waiting') await deleteRoom(this.client, this.room.id);
    else await setRoomStatus(this.client, this.room.id, 'finished');
  }

  /** Stops timers and leaves the channel.  Doesn't touch the database. */
  async close(): Promise<void> {
    this.ended = true;
    this.listener = {};
    clearInterval(this.timer);
    await this.client.removeChannel(this.channel);
  }

  private onPresenceSync(): void {
    this.roster = rosterFromPresence(this.channel.presenceState());
    for (const entry of this.roster) this.seenIds.add(entry.playerId);
    const now = Date.now();
    this.tracker ??= new AbsenceTracker(now);
    this.tracker.update(
      this.roster.map((entry) => entry.playerId),
      now,
    );
    this.listener.roster?.(this.roster);
  }

  private onBroadcast(payload: unknown): void {
    const event = parseRoomEvent(payload);
    if (!event) return;
    if (event.type === 'removed') {
      if (event.playerId === this.player.id) this.loseSeat();
      return;
    }
    if (event.type === 'start') this.phase = 'playing';
    this.listener.event?.(event);
  }

  private loseSeat(): void {
    if (this.ended) return;
    this.listener.seatLost?.();
  }

  private async checkOwnSeat(): Promise<void> {
    if (!(await hasSeat(this.client, this.room.id, this.player.id))) this.loseSeat();
  }

  /** Runs every few seconds.  The host removes stale seats; everyone else watches for the host. */
  private async check(): Promise<void> {
    // No judgments until the first Presence sync, when the roster is known.
    if (!this.tracker || this.checking || this.ended) return;
    const now = Date.now();

    if (!this.isHost) {
      if (this.tracker.absentFor(this.room.hostId, now) >= this.graceMs) {
        clearInterval(this.timer);
        this.listener.hostGone?.();
      }
      return;
    }

    this.checking = true;
    try {
      // Polling the seats (one small query every few seconds, host only)
      // also catches seats whose player never connected at all.  Players
      // seen in Presence count too, in case they deleted their own seat.
      const seatIds = await fetchSeatIds(this.client, this.room.id);
      const candidates = [...new Set([...seatIds, ...this.seenIds])].filter((id) => !this.gone.has(id));
      for (const id of candidates) if (!this.seatFirstSeen.has(id)) this.seatFirstSeen.set(id, now);
      const seats = candidates.map((playerId) => ({ playerId, firstSeenAt: this.seatFirstSeen.get(playerId) ?? now }));

      for (const playerId of staleSeats(seats, this.tracker, this.player.id, now, this.graceMs)) {
        if (seatIds.includes(playerId)) await removePlayer(this.client, this.room.id, playerId);
        this.gone.add(playerId);
        this.seatFirstSeen.delete(playerId);
        this.listener.playerGone?.(playerId);
        await this.send({ type: 'removed', playerId });
      }
    } catch (err) {
      console.warn('Seat check failed; will retry.', err);
    } finally {
      this.checking = false;
    }
  }
}
