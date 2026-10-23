import { describe, expect, it } from 'vitest';
import { isPostgresChangesReady } from './realtime';

describe('isPostgresChangesReady', () => {
  it('matches the "Subscribed to PostgreSQL" system message', () => {
    expect(
      isPostgresChangesReady({ message: 'Subscribed to PostgreSQL', status: 'ok', extension: 'postgres_changes', channel: 'lobby' }),
    ).toBe(true);
  });

  it('ignores errors and other system messages', () => {
    expect(isPostgresChangesReady({ status: 'error', extension: 'postgres_changes' })).toBe(false);
    expect(isPostgresChangesReady({ status: 'ok', extension: 'broadcast' })).toBe(false);
    expect(isPostgresChangesReady(null)).toBe(false);
    expect(isPostgresChangesReady('ok')).toBe(false);
  });
});
