// Why a CAPTCHA?  Anonymous sign-in creates a real auth.users row for anyone
// who asks, so a public deployment needs something to stop scripts from
// minting users in bulk.  Supabase Auth verifies Turnstile tokens itself: the
// browser solves the challenge, passes the token to signInAnonymously(), and
// Supabase checks it with Cloudflare before creating the user.  No backend
// code of our own.
//
// The script loads from Cloudflare on demand instead of from npm, so there's
// no new dependency and pages that never sign anyone in never fetch it.

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Empty in builds without a key, which then sign in without a CAPTCHA. */
export const captchaSiteKey: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY || undefined;

interface TurnstileOptions {
  sitekey: string;
  theme?: 'auto' | 'light' | 'dark';
  appearance?: 'always' | 'execute' | 'interaction-only';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (code: string) => void;
}

interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('The CAPTCHA script loaded but did not start.'));
    };
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(new Error('Could not load the CAPTCHA.  Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return loading;
}

export interface Captcha {
  /** Where the widget draws.  It stays empty unless Cloudflare wants the player to click. */
  el: HTMLElement;
  /** Resolves with a token once the challenge passes.  Each token works once. */
  token(): Promise<string>;
  /** Discards the current token and runs a fresh challenge, e.g. after a failed sign-in. */
  reset(): void;
  dispose(): void;
}

export function captchaWidget(siteKey: string): Captcha {
  const el = document.createElement('div');
  el.className = 'captcha';

  let turnstile: Turnstile | undefined;
  let widgetId: string | undefined;
  let token: string | undefined;
  let failure: Error | undefined;
  let disposed = false;
  let waiters: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];

  function fail(err: Error): void {
    failure = err;
    for (const waiter of waiters.splice(0)) waiter.reject(err);
  }

  loadTurnstile()
    .then((loaded) => {
      if (disposed) return;
      turnstile = loaded;
      widgetId = loaded.render(el, {
        sitekey: siteKey,
        theme: 'dark',
        // Most players pass without seeing anything.  The widget only appears
        // when Cloudflare wants an interaction.
        appearance: 'interaction-only',
        callback(value) {
          token = value;
          failure = undefined;
          for (const waiter of waiters.splice(0)) waiter.resolve(value);
        },
        'expired-callback'() {
          token = undefined;
        },
        'error-callback'(code) {
          fail(new Error(`The CAPTCHA check failed (${code}).  Reload the page and try again.`));
        },
      });
    })
    .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));

  return {
    el,
    token() {
      if (token) return Promise.resolve(token);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    reset() {
      token = undefined;
      failure = undefined;
      if (turnstile && widgetId) turnstile.reset(widgetId);
    },
    dispose() {
      disposed = true;
      waiters = [];
      if (turnstile && widgetId) turnstile.remove(widgetId);
    },
  };
}
