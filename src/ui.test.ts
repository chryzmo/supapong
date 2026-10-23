import { describe, expect, it } from 'vitest';
import { errorMessage } from './ui';

describe('errorMessage', () => {
  it('reads Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('reads plain error objects, like the ones supabase-js returns', () => {
    expect(errorMessage({ message: 'That room is full.', code: 'P0001' })).toBe('That room is full.');
  });

  it('falls back for anything else', () => {
    expect(errorMessage('nope')).toBe('Something went wrong.');
    expect(errorMessage(null)).toBe('Something went wrong.');
    expect(errorMessage({ message: 42 })).toBe('Something went wrong.');
  });
});
