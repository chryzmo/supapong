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
// Why several private channels?  Realtime Authorization checks RLS policies
// on realtime.messages when a client joins, so only seated players get in
// (see the private_room_channels and player_input_topics migrations).
// Policies can't tell one broadcast event from another, and a message doesn't
// say who sent it, so traffic is split by who may send it:
//   room:{id}                    the host broadcasts state and events;
//                                everyone seated receives them and tracks
//                                presence
//   room:{id}:input:{player_id}  that player sends their inputs; only they
//                                and the host may join.  The host knows whose
//                                input it is from the topic, so a guest can't
//                                move someone else's paddle.
//
// The session lives from entering a room until returning to the lobby, so the
// same channel carries the waiting room and the match.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, type AppClient } from '../supabase';
import {
  MIN_PLAYERS,
  matchProtocol,
  parseInputMessage,
  parseRoomEvent,
  parseStateMessage,
  type Gate,
  type InputMessage,
  type MatchSettings,
  type MatchStart,
  type Player,
  type RoomEvent,
  type RosterEntry,
  type SeatedRoom,
  type StateMessage,
} from '../types';
import { confirmResult, deleteRoom, fetchSeatIds, finishMatch, hasSeat, removePlayer, setMatchSettings, setRoomStatus } from './api';
import { lineup } from './lineup';
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
  /** A guest's own input topic, to send on.  The host has none. */
  private readonly inputChannel: RealtimeChannel | undefined;
  /** The host's: one per guest in the match, to listen on. */
  private guestInputs: RealtimeChannel[] = [];
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
  private phase: 'waiting' | 'playing' | 'finished' = 'waiting';
  private saving: Promise<void> | undefined;
  private confirming: Promise<void> | undefined;
  /** The match settings: the room's, then the host's changes as they come. */
  private settings: MatchSettings;
  private ended = false;

  constructor(
    readonly room: SeatedRoom,
    readonly player: Player,
    options: SessionOptions = {},
  ) {
    this.isHost = room.hostId === player.id;
    this.settings = { goalLimit: room.goalLimit, matchSeconds: room.matchSeconds, powerUps: room.powerUps, multiballOnly: room.multiballOnly };
    this.client = options.client ?? supabase;
    this.graceMs = options.graceMs ?? ROOM_GRACE_MS;

    this.channel = this.client.channel(`room:${room.id}`, {
      config: { private: true, presence: { key: player.id }, broadcast: { self: false } },
    });
    this.inputChannel = this.isHost ? undefined : this.inputTopic(player.id);

    let markReady: () => void = () => {};
    let markInputReady: () => void = () => {};
    this.ready = Promise.all([
      new Promise<void>((resolve) => (markReady = resolve)),
      this.inputChannel ? new Promise<void>((resolve) => (markInputReady = resolve)) : undefined,
    ]).then(() => {});

    this.channel
      .on('presence', { event: 'sync' }, () => this.onPresenceSync())
      .on('broadcast', { event: 'event' }, (message: { payload?: unknown }) => this.onBroadcast(message.payload))
      .on('broadcast', { event: 'state' }, (message: { payload?: unknown }) => {
        const state = this.isHost ? null : parseStateMessage(message.payload);
        if (state) this.listener.state?.(state);
      })
      .subscribe((status) => {
        // Refused at join: our seat is gone (or never existed).
        if (status === 'CHANNEL_ERROR') void this.checkOwnSeat();
        if (status !== 'SUBSCRIBED') return;
        void this.channel.track({ playerId: player.id, displayName: player.displayName, seat: room.seat });
        // A second SUBSCRIBED means the socket dropped and rejoined.  The host
        // may have removed our seat in the meantime, so check.
        if (this.subscribedBefore) void this.checkOwnSeat();
        this.subscribedBefore = true;
        markReady();
      });

    // A guest joins their own input topic to send.  The host joins each
    // guest's when the match starts (listenForInputs).
    this.inputChannel?.subscribe((status) => {
      if (status === 'SUBSCRIBED') markInputReady();
    });

    this.timer = setInterval(() => void this.check(), options.checkIntervalMs ?? CHECK_INTERVAL_MS);
  }

  private inputTopic(playerId: string): RealtimeChannel {
    return this.client.channel(`room:${this.room.id}:input:${playerId}`, {
      config: { private: true, broadcast: { self: false } },
    });
  }

  /**
   * Host only.  Joins each guest's input topic, and passes on their inputs
   * with the seat that guest holds: the seat inside the message is only the
   * sender's word.  Resolves once every topic has joined or been refused.
   */
  private async listenForInputs(guests: Gate[]): Promise<void> {
    await Promise.all(
      guests.map(
        ({ playerId, seat }) =>
          new Promise<void>((resolve) => {
            const channel = this.inputTopic(playerId).on('broadcast', { event: 'input' }, (message: { payload?: unknown }) => {
              const input = parseInputMessage(message.payload);
              if (input) this.listener.input?.({ ...input, seat });
            });
            this.guestInputs.push(channel);
            // Refused (their seat went in the meantime) or not, don't hold up the match.
            channel.subscribe((status) => {
              if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn(`Input topic for seat ${seat}: ${status}`);
              resolve();
            });
          }),
      ),
    );
  }

  /** Resolves once the channels have joined and this player is tracked. */
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
    void this.inputChannel?.send({ type: 'broadcast', event: 'input', payload: message });
  }

  sendState(message: StateMessage): void {
    void this.channel.send({ type: 'broadcast', event: 'state', payload: message });
  }

  getSettings(): MatchSettings {
    return this.settings;
  }

  /**
   * Host only, before the match.  Saves the match settings (see
   * set_match_settings), then tells everyone in the room, so their waiting
   * rooms show it.  Players who join later read it from the room.
   */
  async changeSettings(settings: MatchSettings): Promise<void> {
    if (!this.isHost) throw new Error('Only the host can change the match settings.');
    await setMatchSettings(this.client, this.room.id, settings);
    this.settings = settings;
    await this.send({ type: 'settings', ...settings });
  }

  /**
   * Host only.  Locks the room (no more joins), drops seats whose players
   * aren't connected, and tells everyone the gate order, bots included.
   * Bots only fill out a match: it still needs MIN_PLAYERS connected players.
   */
  async startMatch(options: { bots?: number; botSkill?: number } = {}): Promise<MatchStart> {
    if (!this.isHost) throw new Error('Only the host can start the match.');
    const humans: Gate[] = this.roster.map(({ seat, playerId, displayName }) => ({ seat, playerId, displayName }));
    if (humans.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} connected players.`);
    const gates = lineup(humans, options.bots ?? 0);

    await setRoomStatus(this.client, this.room.id, 'playing');
    const inMatch = new Set(humans.map((gate) => gate.playerId));
    for (const playerId of await fetchSeatIds(this.client, this.room.id)) {
      if (!inMatch.has(playerId)) await removePlayer(this.client, this.room.id, playerId);
    }
    this.phase = 'playing';
    // Before `start`, so the first inputs, sent once guests hear it, aren't lost.
    await this.listenForInputs(humans.filter((gate) => gate.playerId !== this.player.id));
    const protocol = matchProtocol(this.settings);
    await this.send({ type: 'start', gates, ...this.settings, protocol });
    return { gates, ...this.settings, protocol, ...(options.botSkill !== undefined ? { botSkill: options.botSkill } : {}) };
  }

  /**
   * Host only.  Records the result (see finish_match).  Repeat calls share
   * the first attempt unless it failed, so the match and results screens
   * can both ask without saving twice.
   */
  finishMatch(scores: Record<string, number>): Promise<void> {
    if (!this.isHost) return Promise.reject(new Error('Only the host can record the result.'));
    this.phase = 'finished';
    this.saving ??= finishMatch(this.client, this.room.id, scores).catch((err: unknown) => {
      this.saving = undefined;
      throw err;
    });
    return this.saving;
  }

  /**
   * Guests only.  Reports the scores this player saw (see confirm_result),
   * once: the database keeps a player's first report.
   */
  confirmResult(scores: Record<string, number>): Promise<void> {
    if (this.isHost) return Promise.reject(new Error('The host records the result; guests confirm it.'));
    this.confirming ??= confirmResult(this.client, this.room.id, scores);
    return this.confirming;
  }

  /**
   * Leaves the room for good.  A guest gives up their seat.  The host tells
   * everyone first (there's no one to hear from afterwards), then closes the
   * room: deleting it while waiting, or marking it finished mid-match so the
   * match can still be recorded.
   */
  async leave(): Promise<void> {
    // After the final whistle there's nothing to give up: the room is done.
    if (this.phase === 'finished') return;
    if (!this.isHost) {
      await removePlayer(this.client, this.room.id, this.player.id);
      return;
    }
    await this.send({ type: 'closed' }).catch(() => {});
    if (this.phase === 'waiting') await deleteRoom(this.client, this.room.id);
    else await setRoomStatus(this.client, this.room.id, 'finished');
  }

  /** Stops timers and leaves the channels.  Doesn't touch the database. */
  async close(): Promise<void> {
    this.ended = true;
    this.listener = {};
    clearInterval(this.timer);
    const channels = [this.channel, ...(this.inputChannel ? [this.inputChannel] : []), ...this.guestInputs];
    await Promise.all(channels.map((channel) => this.client.removeChannel(channel)));
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
    if (event.type === 'settings') {
      const { goalLimit, matchSeconds, powerUps, multiballOnly } = event;
      this.settings = { goalLimit, matchSeconds, powerUps, multiballOnly };
    }
    if (event.type === 'start') this.phase = 'playing';
    if (event.type === 'end') this.phase = 'finished';
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
