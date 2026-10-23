import { describe, expect, it } from 'vitest';
import { AbsenceTracker, rosterFromPresence, staleSeats } from './presence';

const ada = { playerId: 'a', displayName: 'Ada', seat: 2 };
const bob = { playerId: 'b', displayName: 'Bob', seat: 0 };

describe('rosterFromPresence', () => {
  it('returns one entry per player, sorted by seat', () => {
    expect(rosterFromPresence({ a: [{ ...ada, presence_ref: '1' }], b: [{ ...bob, presence_ref: '2' }] })).toEqual([bob, ada]);
  });

  it('collapses several connections for the same player', () => {
    expect(rosterFromPresence({ a: [{ ...ada, presence_ref: '1' }, { ...ada, presence_ref: '2' }] })).toEqual([ada]);
  });

  it('drops invalid payloads and entries tracked under the wrong key', () => {
    expect(
      rosterFromPresence({
        a: [{ playerId: 'a', displayName: '', seat: 1 }],
        b: [{ playerId: 'b', displayName: 'Bob', seat: 99 }],
        c: [{ ...ada }],
        d: ['nonsense', null],
      }),
    ).toEqual([]);
  });

  it('uses the first valid entry when a key has a bad one first', () => {
    expect(rosterFromPresence({ a: [{ junk: true }, ada] })).toEqual([ada]);
  });
});

describe('AbsenceTracker', () => {
  it('reports 0 for present players', () => {
    const tracker = new AbsenceTracker(0);
    tracker.update(['a'], 100);
    expect(tracker.absentFor('a', 5000)).toBe(0);
  });

  it('counts players never seen as absent since tracking began', () => {
    const tracker = new AbsenceTracker(1000);
    tracker.update([], 1000);
    expect(tracker.absentFor('ghost', 4000)).toBe(3000);
  });

  it('counts from when a player left', () => {
    const tracker = new AbsenceTracker(0);
    tracker.update(['a'], 0);
    tracker.update([], 2000);
    expect(tracker.absentFor('a', 2500)).toBe(500);
  });

  it('resets when a player comes back', () => {
    const tracker = new AbsenceTracker(0);
    tracker.update(['a'], 0);
    tracker.update([], 1000);
    tracker.update(['a'], 1500);
    tracker.update([], 9000);
    expect(tracker.absentFor('a', 9100)).toBe(100);
  });
});

describe('staleSeats', () => {
  const grace = 8000;

  it('removes seats absent for the grace period', () => {
    const tracker = new AbsenceTracker(0);
    tracker.update(['host', 'a'], 0);
    tracker.update(['host'], 1000);
    const seats = [
      { playerId: 'host', firstSeenAt: 0 },
      { playerId: 'a', firstSeenAt: 0 },
    ];
    expect(staleSeats(seats, tracker, 'host', 8999, grace)).toEqual([]);
    expect(staleSeats(seats, tracker, 'host', 9000, grace)).toEqual(['a']);
  });

  it('gives a newly taken seat the full grace period to connect', () => {
    const tracker = new AbsenceTracker(0);
    tracker.update(['host'], 0);
    const seats = [{ playerId: 'late', firstSeenAt: 20_000 }];
    expect(staleSeats(seats, tracker, 'host', 27_000, grace)).toEqual([]);
    expect(staleSeats(seats, tracker, 'host', 28_000, grace)).toEqual(['late']);
  });

  it('never removes the host', () => {
    const tracker = new AbsenceTracker(0);
    tracker.update([], 0);
    expect(staleSeats([{ playerId: 'host', firstSeenAt: 0 }], tracker, 'host', 60_000, grace)).toEqual([]);
  });
});
