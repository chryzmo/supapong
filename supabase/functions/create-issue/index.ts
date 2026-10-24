// create-issue: files a player's feedback as a GitHub issue.
//
// Why an Edge Function?  Creating an issue needs a GitHub token, and a token
// in the browser could be pulled out of the page and used for anything it
// allows.  The function holds it (the GITHUB_TOKEN secret) and does exactly
// one thing with it.
//
// The player's own JWT comes with the request, and the function saves the
// feedback with it, so the database's rules apply as to any client: only
// signed-in players with a name, only as themselves, a few a day.  Then it
// files the issue and records the result with the service role.  Without
// GITHUB_TOKEN (local development), it saves the feedback and stops there.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { buildIssue, parseFeedback } from './issue.ts';

const REPO = Deno.env.get('GITHUB_REPO') ?? 'chryzmo/supapong';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Send feedback with POST.' });

  const authorization = req.headers.get('Authorization');
  if (!authorization) return reply(401, { error: 'Sign in to send feedback.' });
  const feedback = parseFeedback(await req.json().catch(() => null));
  if (typeof feedback === 'string') return reply(400, { error: feedback });

  const url = Deno.env.get('SUPABASE_URL')!;
  const asPlayer = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await asPlayer.auth.getUser();
  if (!auth.user) return reply(401, { error: 'Sign in to send feedback.' });
  const { data: profile } = await asPlayer.from('profiles').select('display_name').eq('id', auth.user.id).maybeSingle();
  if (!profile) return reply(403, { error: 'Pick a name before sending feedback.' });

  const { data: saved, error: saveError } = await asPlayer
    .from('feedback')
    .insert({
      kind: feedback.kind,
      title: feedback.title,
      body: feedback.body,
      doing: feedback.doing ?? null,
      context: feedback.context,
    })
    .select('id')
    .single();
  if (saveError || !saved) {
    // P0001 is the daily limit; anything else is a check the form should have caught.
    return reply(saveError?.code === 'P0001' ? 429 : 400, { error: saveError?.message ?? 'Couldn’t save the feedback.' });
  }

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const token = Deno.env.get('GITHUB_TOKEN');
  if (!token) {
    await admin.from('feedback').update({ error: 'GitHub is off here (no GITHUB_TOKEN).' }).eq('id', saved.id);
    return reply(200, { id: saved.id, issueUrl: null });
  }

  const response = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'arena-pong-feedback',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildIssue(feedback, profile.display_name)),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    await admin.from('feedback').update({ error: `GitHub ${response.status}: ${detail}` }).eq('id', saved.id);
    return reply(502, { id: saved.id, error: 'Your feedback is saved, but GitHub didn’t take it just now.  We’ll file it by hand.' });
  }
  const issue = (await response.json()) as { number: number; html_url: string };
  await admin.from('feedback').update({ issue_number: issue.number, issue_url: issue.html_url }).eq('id', saved.id);
  return reply(200, { id: saved.id, issueUrl: issue.html_url });
});
