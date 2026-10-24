import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX,
  ROOM_NAME_MAX,
  parseInputMessage,
  parseRoomEvent,
  parseRosterEntry,
  parseStateMessage,
  validateDisplayName,
  validateRoomName,
} from './types';

describe('validateDisplayName', () => {
  it('trims whitespace', () => {
    expect(validateDisplayName('  Ada  ')).toEqual({ ok: true, value: 'Ada' });
  });

  it('rejects empty and whitespace-only names', () => {
    expect(validateDisplayName('').ok).toBe(false);
    expect(validateDisplayName('   ').ok).toBe(false);
  });

  it('enforces the same max length as the profiles check constraint', () => {
    expect(validateDisplayName('x'.repeat(DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(validateDisplayName('x'.repeat(DISPLAY_NAME_MAX + 1)).ok).toBe(false);
  });
});

describe('validateRoomName', () => {
  it('trims whitespace and rejects empty names', () => {
    expect(validateRoomName(' Arena ')).toEqual({ ok: true, value: 'Arena' });
    expect(validateRoomName('  ').ok).toBe(false);
  });

  it('enforces the same max length as the rooms check constraint', () => {
    expect(validateRoomName('x'.repeat(ROOM_NAME_MAX)).ok).toBe(true);
    expect(validateRoomName('x'.repeat(ROOM_NAME_MAX + 1)).ok).toBe(false);
  });
});

describe('parseRosterEntry', () => {
  const entry = { playerId: 'p1', displayName: 'Ada', seat: 3 };

  it('accepts a valid entry and drops extra fields', () => {
    expect(parseRosterEntry({ ...entry, presence_ref: 'x' })).toEqual(entry);
  });

  it.each([
    ['missing id', { displayName: 'Ada', seat: 0 }],
    ['empty name', { ...entry, displayName: '' }],
    ['long name', { ...entry, displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1) }],
    ['fractional seat', { ...entry, seat: 1.5 }],
    ['negative seat', { ...entry, seat: -1 }],
    ['seat past the max', { ...entry, seat: 8 }],
    ['string seat', { ...entry, seat: '1' }],
    ['array', [entry]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(parseRosterEntry(value)).toBeNull();
  });
});

describe('parseRoomEvent', () => {
  const gates = [
    { seat: 0, playerId: 'a', displayName: 'Ada' },
    { seat: 2, playerId: 'b', displayName: 'Bob' },
  ];

  it('accepts goal and end', () => {
    expect(parseRoomEvent({ type: 'goal', gate: 2 })).toEqual({ type: 'goal', gate: 2 });
    expect(parseRoomEvent({ type: 'goal', gate: 2, scorer: 0 })).toEqual({ type: 'goal', gate: 2, scorer: 0 });
    expect(parseRoomEvent({ type: 'goal', gate: 2, scorer: 2 })).toBeNull();
    expect(parseRoomEvent({ type: 'goal', gate: 2, scorer: 9 })).toBeNull();
    expect(parseRoomEvent({ type: 'end', scores: [3, 0, 10] })).toEqual({ type: 'end', scores: [3, 0, 10] });
    expect(parseRoomEvent({ type: 'goal', gate: 9 })).toBeNull();
    expect(parseRoomEvent({ type: 'end', scores: [3, -1] })).toBeNull();
    expect(parseRoomEvent({ type: 'end', scores: [3] })).toBeNull();
  });

  it('accepts start, closed and removed', () => {
    expect(parseRoomEvent({ type: 'start', gates, goalLimit: 15 })).toEqual({ type: 'start', gates, goalLimit: 15 });
  });

  it('keeps the bot flag on bot gates', () => {
    const withBot = [gates[0], { seat: 1, playerId: 'bot-1', displayName: 'Bot 1', bot: true }];
    expect(parseRoomEvent({ type: 'start', gates: withBot, goalLimit: 10 })).toEqual({ type: 'start', gates: withBot, goalLimit: 10 });
    expect(parseRoomEvent({ type: 'start', gates: [gates[0], { ...withBot[1], bot: 'yes' }], goalLimit: 10 })).toEqual({
      type: 'start',
      gates: [gates[0], { seat: 1, playerId: 'bot-1', displayName: 'Bot 1' }],
      goalLimit: 10,
    });
  });

  it('plays to 10 when a start has no goal limit (a host on the previous version)', () => {
    expect(parseRoomEvent({ type: 'start', gates })).toEqual({ type: 'start', gates, goalLimit: 10 });
    expect(parseRoomEvent({ type: 'closed' })).toEqual({ type: 'closed' });
    expect(parseRoomEvent({ type: 'removed', playerId: 'a' })).toEqual({ type: 'removed', playerId: 'a' });
  });

  it.each([
    ['an unknown type', { type: 'explode' }],
    ['a start with one gate', { type: 'start', gates: gates.slice(0, 1) }],
    ['a start with no goals to play', { type: 'start', gates, goalLimit: 0 }],
    ['a start with too many goals', { type: 'start', gates, goalLimit: 51 }],
    ['a start with a fractional goal limit', { type: 'start', gates, goalLimit: 2.5 }],
    ['a start with nine gates', { type: 'start', gates: Array.from({ length: 9 }, (_, i) => ({ seat: i % 8, playerId: `p${i}`, displayName: 'P' })) }],
    ['a start with a bad gate', { type: 'start', gates: [...gates, { seat: 'x' }] }],
    ['a start with duplicate seats', { type: 'start', gates: [gates[0], { ...gates[1], seat: 0 }] }],
    ['a start with duplicate players', { type: 'start', gates: [gates[0], { ...gates[1], playerId: 'a' }] }],
    ['a start without gates', { type: 'start' }],
    ['a removed without a player', { type: 'removed' }],
    ['a string', 'start'],
  ])('rejects %s', (_label, value) => {
    expect(parseRoomEvent(value)).toBeNull();
  });
});

describe('parseInputMessage', () => {
  it('accepts a seat and a direction', () => {
    expect(parseInputMessage({ seat: 3, dir: -1 })).toEqual({ seat: 3, dir: -1 });
    expect(parseInputMessage({ seat: 0, dir: 0 })).toEqual({ seat: 0, dir: 0 });
  });

  it.each([
    ['a bad direction', { seat: 0, dir: 2 }],
    ['a fractional direction', { seat: 0, dir: 0.5 }],
    ['a bad seat', { seat: 8, dir: 1 }],
    ['nothing', null],
  ])('rejects %s', (_label, value) => {
    expect(parseInputMessage(value)).toBeNull();
  });
});

describe('parseStateMessage', () => {
  const state = {
    tick: 30,
    ball: [0.1, -0.2, 0.5, 0.3],
    paddles: [0, 2.09, -2.09],
    active: [true, true, false],
    scores: [1, 0, 2],
    goals: 3,
    touch: 1,
    respawn: 0,
    rally: 4,
  };

  it('accepts a valid snapshot', () => {
    expect(parseStateMessage(state)).toEqual(state);
    expect(parseStateMessage({ ...state, touch: -1 })).toEqual({ ...state, touch: -1 });
  });

  it('treats a missing touch (a host on the previous version) as nobody', () => {
    expect(parseStateMessage({ ...state, touch: undefined })).toEqual({ ...state, touch: -1 });
  });

  it.each([
    ['a short ball', { ...state, ball: [0, 0, 0] }],
    ['a NaN in the ball', { ...state, ball: [0, Number.NaN, 0, 0] }],
    ['one gate', { ...state, paddles: [0], active: [true], scores: [0] }],
    ['mismatched lengths', { ...state, active: [true, true] }],
    ['non-boolean active', { ...state, active: [1, 1, 0] }],
    ['a negative score', { ...state, scores: [1, -1, 2] }],
    ['a fractional tick', { ...state, tick: 1.5 }],
    ['a missing respawn', { ...state, respawn: undefined }],
    ['missing goals', { ...state, goals: undefined }],
    ['a touch past the last gate', { ...state, touch: 3 }],
    ['a touch below -1', { ...state, touch: -2 }],
  ])('rejects %s', (_label, value) => {
    expect(parseStateMessage(value)).toBeNull();
  });
});
