import { currentUserId, ensureSignedIn, fetchPlayer, savePlayer, signOut } from './auth';
import { fetchRoom, fetchSeatedRoom } from './lobby/api';
import { lobbyScreen } from './lobby/lobby';
import { waitingScreen } from './room/waiting';
import { DISPLAY_NAME_MAX, validateDisplayName, type Player, type SeatedRoom } from './types';
import { errorMessage, h, type View } from './ui';

type Screen =
  | { name: 'loading' }
  | { name: 'pick-name'; current?: Player }
  | { name: 'lobby'; player: Player }
  | { name: 'room'; player: Player; room: SeatedRoom };

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element.');
const root: HTMLElement = app;

let current: View | undefined;

function show(screen: Screen): void {
  current?.dispose?.();
  current = render(screen);
  root.replaceChildren(current.el);
}

function showError(err: unknown): void {
  console.error(err);
  current?.dispose?.();
  current = undefined;
  root.replaceChildren(h('div', { className: 'panel' }, h('p', { className: 'error' }, errorMessage(err))));
}

function render(screen: Screen): View {
  switch (screen.name) {
    case 'loading':
      return { el: h('div', { className: 'panel' }, h('p', {}, 'Loading…')) };
    case 'pick-name':
      return pickNameScreen(screen.current);
    case 'lobby': {
      const { player } = screen;
      return lobbyScreen(player, {
        enterRoom(roomId, seat) {
          fetchRoom(roomId, seat)
            .then((room) => show({ name: 'room', player, room }))
            .catch(showError);
        },
        rename: () => show({ name: 'pick-name', current: player }),
        signOut() {
          signOut()
            .then(() => show({ name: 'pick-name' }))
            .catch(showError);
        },
      });
    }
    case 'room': {
      const { player, room } = screen;
      return waitingScreen(player, room, { left: () => show({ name: 'lobby', player }) });
    }
  }
}

function pickNameScreen(current?: Player): View {
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
      error.textContent = errorMessage(err);
      submit.disabled = false;
    }
  });

  queueMicrotask(() => input.focus());
  return {
    el: h(
      'div',
      { className: 'panel' },
      h('h1', {}, 'Arena Pong'),
      h('p', {}, current ? 'Change your display name.' : 'Pick a name to get started. No account needed.'),
      form,
    ),
  };
}

async function boot(): Promise<void> {
  show({ name: 'loading' });
  const userId = await currentUserId();
  const player = userId ? await fetchPlayer(userId) : null;
  if (!player) {
    show({ name: 'pick-name' });
    return;
  }
  // A reload while seated in a waiting room goes straight back to it.
  const room = await fetchSeatedRoom(player.id);
  show(room ? { name: 'room', player, room } : { name: 'lobby', player });
}

boot().catch(showError);
