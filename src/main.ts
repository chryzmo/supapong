import { currentUserId, ensureSignedIn, fetchPlayer, savePlayer, signOut } from './auth';
import { DISPLAY_NAME_MAX, validateDisplayName, type Player } from './types';

type Screen = { name: 'loading' } | { name: 'pick-name'; current?: Player } | { name: 'lobby'; player: Player };

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element.');
const root: HTMLElement = app;

/** Small element helper.  Text always goes through textContent, never innerHTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function show(screen: Screen): void {
  root.replaceChildren(render(screen));
}

function render(screen: Screen): HTMLElement {
  switch (screen.name) {
    case 'loading':
      return h('div', { className: 'panel' }, h('p', {}, 'Loading…'));
    case 'pick-name':
      return pickNameScreen(screen.current);
    case 'lobby':
      return lobbyScreen(screen.player);
  }
}

function pickNameScreen(current?: Player): HTMLElement {
  const input = h('input', {
    name: 'display_name',
    maxLength: DISPLAY_NAME_MAX,
    autocomplete: 'off',
    required: true,
    value: current?.displayName ?? '',
  });
  const error = h('p', { className: 'error' });
  const submit = h('button', { type: 'submit' }, current ? 'Save' : 'Play');

  const form = h('form', {}, h('label', {}, 'Display name', input), error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = validateDisplayName(input.value);
    if (!result.ok) {
      error.textContent = result.error;
      return;
    }
    submit.disabled = true;
    error.textContent = '';
    try {
      // Sign in only once the player commits to a name, so just opening the
      // page doesn't create an anonymous user.
      const userId = await ensureSignedIn();
      const player = await savePlayer(userId, result.value);
      show({ name: 'lobby', player });
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : 'Something went wrong.';
      submit.disabled = false;
    }
  });

  queueMicrotask(() => input.focus());
  return h(
    'div',
    { className: 'panel' },
    h('h1', {}, 'Arena Pong'),
    h('p', {}, current ? 'Change your display name.' : 'Pick a name to get started. No account needed.'),
    form,
  );
}

function lobbyScreen(player: Player): HTMLElement {
  const rename = h('button', { className: 'secondary', type: 'button' }, 'Change name');
  rename.addEventListener('click', () => show({ name: 'pick-name', current: player }));

  const leave = h('button', { className: 'secondary', type: 'button' }, 'Sign out');
  leave.addEventListener('click', async () => {
    await signOut();
    show({ name: 'pick-name' });
  });

  return h(
    'div',
    { className: 'panel' },
    h('h1', {}, `Hi, ${player.displayName}`),
    h('p', {}, 'The lobby arrives in milestone 2.'),
    h('div', { className: 'row' }, rename, leave),
  );
}

async function boot(): Promise<void> {
  show({ name: 'loading' });
  const userId = await currentUserId();
  const player = userId ? await fetchPlayer(userId) : null;
  show(player ? { name: 'lobby', player } : { name: 'pick-name' });
}

boot().catch((err: unknown) => {
  console.error(err);
  root.replaceChildren(
    h('div', { className: 'panel' }, h('p', { className: 'error' }, err instanceof Error ? err.message : String(err))),
  );
});
