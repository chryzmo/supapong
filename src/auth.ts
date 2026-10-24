import { supabase } from './supabase';
import type { Player } from './types';

// Why anonymous sign-in?  It gives every player a real auth.users row and a
// JWT, so RLS policies can use auth.uid() exactly as they would for a real
// account, with no email or password step.  Supabase can later link an
// anonymous user to an email or OAuth identity without changing its id.

/** Returns the signed-in user's id from the stored session, if any. */
export async function currentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.user.id ?? null;
}

/**
 * Signs in anonymously if there's no session yet, and returns the user id.
 * `captchaToken` is only called when a new user is actually created, since
 * Supabase checks the CAPTCHA on sign-in and nowhere else.
 */
export async function ensureSignedIn(captchaToken?: () => Promise<string>): Promise<string> {
  const existing = await currentUserId();
  if (existing) return existing;

  const options = captchaToken ? { captchaToken: await captchaToken() } : {};
  const { data, error } = await supabase.auth.signInAnonymously({ options });
  if (error) throw error;
  if (!data.user) throw new Error('Anonymous sign-in returned no user.');
  return data.user.id;
}

/** Loads the player's profile, or null if they haven't picked a name yet. */
export async function fetchPlayer(userId: string): Promise<Player | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, displayName: data.display_name } : null;
}

/**
 * Creates or renames the player's profile.  RLS only allows writing the row
 * whose id matches auth.uid(), so this can't touch anyone else's profile.
 */
export async function savePlayer(userId: string, displayName: string): Promise<Player> {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: userId, display_name: displayName })
    .select('id, display_name')
    .single();
  if (error) throw error;
  return { id: data.id, displayName: data.display_name };
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
