/// <reference types="node" />
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, inject } from 'vitest';
import type { Database } from '../../src/database.types';
import type { supabase } from '../../src/supabase';

export type AppClient = typeof supabase;

export const stack = inject('stack');

/** Service-role client for setup and cleanup.  It bypasses RLS, so tests never assert through it. */
export const admin = createClient<Database>(stack.url, stack.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface TestPlayer {
  id: string;
  name: string;
  client: AppClient;
}

const created: string[] = [];

// Deleting the auth user cascades to their profile, the rooms they host and
// their seats, so each test file cleans up after itself.
afterAll(async () => {
  await Promise.all(created.map((id) => admin.auth.admin.deleteUser(id)));
});

/**
 * Creates a signed-in player with a profile.
 *
 * Test players skip the sign-in endpoint: the local stack rate-limits
 * anonymous sign-ins per IP, and a run creates dozens of players.  Instead we
 * create the user with the admin API and sign a JWT with the local stack's
 * secret, which Postgres, RLS and Realtime treat exactly like a session token.
 * auth.test.ts covers the real anonymous sign-in path.
 */
export async function createPlayer(name: string): Promise<TestPlayer> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-${randomUUID()}@example.test`,
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user.id;
  created.push(id);

  const { error: profileError } = await admin.from('profiles').insert({ id, display_name: name });
  if (profileError) throw profileError;

  const token = signToken(id);
  const client: AppClient = createClient<Database>(stack.url, stack.anonKey, {
    accessToken: async () => token,
  });
  return { id, name, client };
}

/** Removes an auth user at the end of the file (for users a test created itself). */
export function cleanupUser(id: string): void {
  created.push(id);
}

function signToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createHmac('sha256', stack.jwtSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** Polls until `check` returns true, or fails after `timeoutMs`. */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The app's modules import a single `supabase` client.  Test files replace that
// module with this one, so app code runs as whichever player they pick:
//
//   vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));
//   actAs(alice);
//   await joinRoom(roomId);

let current: AppClient | undefined;

export function actAs(player: { client: AppClient }): void {
  current = player.client;
}

export const appSupabaseModule = {
  get supabase(): AppClient {
    if (!current) throw new Error('Call actAs(player) before using app code.');
    return current;
  },
};
