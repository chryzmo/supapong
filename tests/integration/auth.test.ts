// src/auth.ts with a real anonymous sign-in (the one test that uses the sign-in endpoint).
import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { currentUserId, ensureSignedIn, fetchPlayer, savePlayer, signOut } from '../../src/auth';
import type { Database } from '../../src/database.types';
import { actAs, admin, cleanupUser, stack } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

// Cloudflare's Turnstile test secret in supabase/config.toml accepts this token.
const TEST_CAPTCHA_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

it('signs in anonymously, saves a profile, and signs out', async () => {
  actAs({ client: createClient<Database>(stack.url, stack.anonKey, { auth: { persistSession: false } }) });

  expect(await currentUserId()).toBeNull();

  // The local stack requires a CAPTCHA, like the hosted project.
  await expect(ensureSignedIn()).rejects.toMatchObject({ code: 'captcha_failed' });

  const userId = await ensureSignedIn(() => Promise.resolve(TEST_CAPTCHA_TOKEN));
  cleanupUser(userId);
  const { data } = await admin.auth.admin.getUserById(userId);
  expect(data.user?.is_anonymous).toBe(true);

  // A second call reuses the session instead of creating another user, and
  // doesn't ask for a CAPTCHA token.
  const captchaToken = vi.fn(() => Promise.resolve(TEST_CAPTCHA_TOKEN));
  expect(await ensureSignedIn(captchaToken)).toBe(userId);
  expect(captchaToken).not.toHaveBeenCalled();
  expect(await currentUserId()).toBe(userId);

  expect(await fetchPlayer(userId)).toBeNull();
  expect(await savePlayer(userId, 'Ada')).toEqual({ id: userId, displayName: 'Ada' });
  expect(await savePlayer(userId, 'Ada L')).toEqual({ id: userId, displayName: 'Ada L' });
  expect(await fetchPlayer(userId)).toEqual({ id: userId, displayName: 'Ada L' });

  await expect(savePlayer(userId, 'x'.repeat(25))).rejects.toMatchObject({ code: '23514' });

  await signOut();
  expect(await currentUserId()).toBeNull();
});
