// Pure Presence helpers: no client, no timers.  Unit tested in presence.test.ts.
import { parseRosterEntry, type RosterEntry } from '../types';

/**
 * Turns a channel's presenceState() into a roster sorted by seat.
 *
 * State is keyed by presence key (the player id) and each key can have
 * several entries, one per connection (e.g. a second tab, or a reload that
 * overlaps the old socket).  We keep one valid entry per key, and ignore
 * entries whose playerId doesn't match the key they were tracked under.
 */
export function rosterFromPresence(state: Record<string, unknown[]>): RosterEntry[] {
  const roster: RosterEntry[] = [];
  for (const [key, metas] of Object.entries(state)) {
    for (const meta of metas) {
      const entry = parseRosterEntry(meta);
      if (entry && entry.playerId === key) {
        roster.push(entry);
        break;
      }
    }
  }
  return roster.sort((a, b) => a.seat - b.seat);
}

/**
 * Remembers when each player was last seen in Presence.
 *
 * A player who drops out of Presence isn't treated as gone right away: a page
 * reload briefly drops the connection, and we don't want that to cost anyone
 * their seat.  Callers check absentFor() against a grace period instead.
 */
export class AbsenceTracker {
  private present = new Set<string>();
  private absentSince = new Map<string, number>();

  /** @param startedAt When tracking began.  Players never seen count as absent since then. */
  constructor(private readonly startedAt: number) {}

  update(presentIds: Iterable<string>, now: number): void {
    const next = new Set(presentIds);
    for (const id of this.present) {
      if (!next.has(id)) this.absentSince.set(id, now);
    }
    for (const id of next) this.absentSince.delete(id);
    this.present = next;
  }

  /** Milliseconds the player has been absent; 0 if present. */
  absentFor(id: string, now: number): number {
    if (this.present.has(id)) return 0;
    return now - (this.absentSince.get(id) ?? this.startedAt);
  }
}

export interface SeatRow {
  playerId: string;
  /**
   * When the host first saw this seat, on the host's clock.  Not joined_at
   * from the database: the browser's clock can be off from the server's.
   */
  firstSeenAt: number;
}

/**
 * Seats the host should remove: players absent for at least the grace period.
 *
 * A new seat also gets the full grace period from when the host first saw it,
 * since join_room writes the seat before the player's channel connects.
 */
export function staleSeats(
  seats: SeatRow[],
  tracker: AbsenceTracker,
  hostId: string,
  now: number,
  graceMs: number,
): string[] {
  return seats
    .filter(
      (seat) =>
        seat.playerId !== hostId &&
        tracker.absentFor(seat.playerId, now) >= graceMs &&
        now - seat.firstSeenAt >= graceMs,
    )
    .map((seat) => seat.playerId);
}
