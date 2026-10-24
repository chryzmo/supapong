// Sending feedback: the create-issue Edge Function saves it and files it as a
// GitHub issue (see supabase/functions/create-issue).
import { FunctionsHttpError } from '@supabase/supabase-js';
import type { Feedback } from '../../supabase/functions/create-issue/issue';
import { supabase } from '../supabase';

export interface Sent {
  /** The GitHub issue, or null where GitHub is off (local development). */
  issueUrl: string | null;
}

/** Sends feedback as the signed-in player.  Throws with the function's own message if it refuses. */
export async function sendFeedback(feedback: Feedback): Promise<Sent> {
  const { data, error } = await supabase.functions.invoke<{ issueUrl?: string | null }>('create-issue', { body: feedback });
  if (error instanceof FunctionsHttpError) {
    const body: unknown = await (error.context as Response).json().catch(() => null);
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null;
    throw new Error(message ?? 'Couldn’t send the feedback.');
  }
  if (error) throw error;
  const issueUrl = data?.issueUrl;
  // Only ever link to an issue on GitHub.
  return { issueUrl: typeof issueUrl === 'string' && issueUrl.startsWith('https://github.com/') ? issueUrl : null };
}
