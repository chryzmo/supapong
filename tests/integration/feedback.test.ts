// src/feedback/api.ts against the create-issue Edge Function on the local
// stack.  Locally there's no GITHUB_TOKEN, so the function saves feedback
// and stops before GitHub: these tests never file real issues.
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Feedback } from '../../supabase/functions/create-issue/issue';
import { sendFeedback } from '../../src/feedback/api';
import { actAs, admin, createPlayer, stack } from './helpers';

vi.mock('../../src/supabase', () => import('./helpers').then((m) => m.appSupabaseModule));

const feedback: Feedback = {
  kind: 'bug',
  title: 'The ball froze',
  body: 'It stopped in the middle of the board.',
  doing: 'Hosting a match with two bots',
  context: { version: 'test', where: 'results', mobile: false },
};

describe('sendFeedback', () => {
  it('saves the feedback as the player, and says GitHub is off here', async () => {
    const ada = await createPlayer('Ada');
    actAs(ada);
    expect(await sendFeedback(feedback)).toEqual({ issueUrl: null });

    const { data } = await admin.from('feedback').select('player_id, kind, title, body, doing, context, issue_url, error').eq('player_id', ada.id);
    expect(data).toEqual([
      {
        player_id: ada.id,
        kind: 'bug',
        title: 'The ball froze',
        body: 'It stopped in the middle of the board.',
        doing: 'Hosting a match with two bots',
        context: feedback.context,
        issue_url: null,
        error: 'GitHub is off here (no GITHUB_TOKEN).',
      },
    ]);
  });

  it('passes on why it refused', async () => {
    const bob = await createPlayer('Bob');
    actAs(bob);
    await expect(sendFeedback({ ...feedback, title: 'x' })).rejects.toThrow('Give it a title of 3 to 80 characters.');
  });

  it('stops at five a day', async () => {
    const cy = await createPlayer('Cy');
    actAs(cy);
    for (let i = 0; i < 5; i++) await sendFeedback({ ...feedback, title: `Report ${i + 1}` });
    await expect(sendFeedback(feedback)).rejects.toThrow("That's plenty of feedback for one day.");
  });

  it('needs a name', async () => {
    const nameless = await createPlayer('Nameless');
    await admin.from('profiles').delete().eq('id', nameless.id);
    actAs(nameless);
    await expect(sendFeedback(feedback)).rejects.toThrow('Pick a name before sending feedback.');
  });

  it('needs a signed-in player, not just the public key', async () => {
    const anonymous = createClient(stack.url, stack.anonKey, { auth: { persistSession: false } });
    const { error } = await anonymous.functions.invoke('create-issue', { body: feedback });
    expect(error).not.toBeNull();
    const body: unknown = await (error!.context as Response).json();
    expect(body).toEqual({ error: 'Sign in to send feedback.' });
  });
});
