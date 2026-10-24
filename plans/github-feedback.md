# GitHub feedback

Status: ready to start.  Open decision: [straight to public issues, or reviewed first](#open-decision).

## Goal

A Feedback button opens a modal where a player picks **Bug** or **Feature request**, writes a title and a description, and sends it.  Each submission becomes a GitHub issue on this repo, labeled by kind.

## Why an Edge Function

Creating an issue needs a GitHub token.  A token in the browser can be pulled out of the page and used for anything it allows, so something server-side has to hold it.  A Supabase Edge Function does that without adding a server of our own, which keeps the "Supabase is the backend" goal and shows off one more primitive.

## Design

```
modal ──insert──▶ feedback table ──database webhook──▶ Edge Function create-issue ──▶ GitHub API
                       ▲                                        │
                       └──────────── issue number, url ─────────┘
```

1. **The modal** (`src/feedback/`): a Feedback button in the lobby, and on the results screen.
   - Fields: kind (Bug / Feature request), title (up to 80 characters), description (up to 2000), and for bugs an optional "what were you doing?".
   - It attaches context the player doesn't type: the app's commit SHA (injected by Vite at build), the user agent, the screen size, and whether it's a mobile browser (`isMobileBrowser`).
   - A note under the form says the feedback will be public on GitHub, if we go that way (see the open decision).
   - On success it says thanks.  Once the issue exists it can show the link, by listening for the row's update with Postgres Changes, or just by not waiting.
2. **The `feedback` table**, which the modal inserts into directly:

   ```sql
   feedback (
     id uuid primary key default gen_random_uuid(),
     player_id uuid not null references profiles default auth.uid(),
     kind text not null check (kind in ('bug', 'feature')),
     title text not null check (length(title) between 3 and 80),
     body text not null check (length(body) between 1 and 2000),
     context jsonb not null default '{}',
     issue_number int,          -- set by the function
     issue_url text,
     error text,                -- why the issue couldn't be created, if it couldn't
     created_at timestamptz default now()
   )
   ```

   - **RLS:** you may insert only rows with `player_id = auth.uid()`, and read only your own.  There's no update or delete policy: only the function, using the service role, writes `issue_*` and `error`.
   - **Rate limit:** a `before insert` trigger refuses a sixth submission from the same player within 24 hours.  Anonymous accounts are cheap to make, but sign-in has Turnstile, so making many accounts is slow.
   - **Durability:** the row is saved even when GitHub is down or the token has expired.  The `error` column shows which submissions to retry.
   - **GRANTs:** add them explicitly, since the hosted project needs them for every new table.
3. **The database webhook** on `feedback` inserts calls the Edge Function, signed with a shared secret the function checks.  It could instead be a trigger using `pg_net`.  The webhook is the dashboard-free, migration-defined form of the same thing, so we'd write it as a trigger in a migration either way: schema changes go in migrations, never through the dashboard.
4. **The Edge Function `create-issue`** (`supabase/functions/create-issue/index.ts`):
   - Builds the issue:
     - **Title:** `[Bug] …` or `[Feature] …`.
     - **Body:** the description, the "what were you doing", and a collapsed context section.  It gives the player's display name but not their user id.
     - **Labels:** `bug` or `enhancement`, plus `from-app`.
   - **Escaping:** the issue text is plain, with `@` escaped so feedback can't mention people, and `#123` references left inert.
   - Calls `POST /repos/{owner}/{repo}/issues`, then writes `issue_number` and `issue_url` (or `error`) back to the row with the service role.
   - **Pure part:** building the issue body lives in a pure module, so it can be unit tested.

## Secrets and permissions

- **GitHub token:** a fine-grained personal access token limited to this one repo, with Issues: read and write and nothing else.  Set it once with `npx supabase secrets set GITHUB_TOKEN=… GITHUB_REPO=chryzmo/supapong`.  It never goes in CI or the frontend.
- **Webhook secret:** a random value, also set with `supabase secrets set`.  It goes into the trigger through Vault rather than in the migration's text.
- **CI:** the deploy job runs `npx supabase functions deploy create-issue --project-ref $REF`.  The `SUPABASE_ACCESS_TOKEN` probably needs the Edge Functions write permission added.  Check when we get there.

## Local development

- `npx supabase functions serve` runs the function against the local stack.
- **No real GitHub locally:** locally, `GITHUB_TOKEN` is unset and the function records a fake issue (`error = 'GitHub disabled'`) instead of calling GitHub, so dev feedback never files real issues.  An env var can point it at a scratch repo when we want to test the real call.

## Tests

- **pgTAP:**
  - You can insert only as yourself.
  - The length checks hold.
  - The sixth submission in a day is refused.
  - You can't read other players' feedback, or update the issue columns.
- **Unit:** the issue builder, covering the title prefix, the labels, escaped mentions and the context block.
- **Integration:** insert feedback through the app module, and see the row get its fake issue from the locally served function, with GitHub disabled.

## Rollout

Purely additive (a new table, function and modal), so it's safe with the deployed frontend.  The order: the migration with the table and trigger, then the function deploy, then setting the secrets, then the frontend.  CI already applies migrations before deploying.

## Open decision

**Should feedback go straight to public issues, or be reviewed first?**

- **Straight to public issues** (the design above): no triage work, but any player's text appears on a public repo.  The per-player cap and mention escaping keep the damage small.
- **Reviewed first:** the function doesn't run on insert.  You read the `feedback` table in the dashboard and file the worthwhile ones, or flip a `promote` flag that triggers the function.  Safer, but it's work.
- **Middle ground:** file issues automatically, but have the function skip any that look like junk (very short, or repeated text) and leave them for review.

## Effort

About half a day: the migration and tests are an hour or two, the function and its CI deploy about the same, and the modal an hour.
