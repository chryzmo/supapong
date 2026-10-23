import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, ROOM_NAME_MAX, validateDisplayName, validateRoomName } from './types';

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
