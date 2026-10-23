import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill it from `npx supabase status`.',
  );
}

// The session lives in sessionStorage instead of the default localStorage, so
// each browser tab is its own anonymous player.  That makes it easy to test a
// multiplayer room from one machine.  A reload keeps the same player, and a new
// tab gets a new one.
export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    storage: window.sessionStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});

export type AppClient = typeof supabase;
