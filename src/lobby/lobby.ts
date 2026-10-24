import { MAX_PLAYERS, MIN_PLAYERS, ROOM_NAME_MAX, validateRoomName, type LobbyRoom, type Player } from '../types';
import { errorMessage, h, type View } from '../ui';
import { createRoom, fetchLobbyRooms, joinRoom, subscribeLobby } from './api';

export interface LobbyActions {
  enterRoom(roomId: string, seat: number): void;
  practice(): void;
  leaderboard(): void;
  rename(): void;
  signOut(): void;
}

/** @param notice Shown at the top, e.g. why the player was sent back from a room. */
export function lobbyScreen(player: Player, actions: LobbyActions, notice?: string): View {
  const status = h('p', { className: 'error' });
  const list = h('ul', { className: 'rooms' });

  // Only one create or join at a time.
  let busy = false;
  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    status.textContent = '';
    try {
      await task();
    } catch (err) {
      status.textContent = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  // Create form ----------------------------------------------------------------
  const nameInput = h('input', {
    name: 'room_name',
    maxLength: ROOM_NAME_MAX,
    autocomplete: 'off',
    value: `${player.displayName}'s room`.slice(0, ROOM_NAME_MAX),
  });
  const sizeSelect = h('select', { name: 'max_players' });
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    sizeSelect.append(h('option', { value: String(n), selected: n === 4 }, `${n} players`));
  }
  const createButton = h('button', { type: 'submit' }, 'Create room');
  const createForm = h(
    'form',
    { className: 'create' },
    h('label', {}, 'Room name', nameInput),
    h('label', {}, 'Size', sizeSelect),
    createButton,
  );
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = validateRoomName(nameInput.value);
    if (!result.ok) {
      status.textContent = result.error;
      return;
    }
    void run(async () => {
      createButton.disabled = true;
      try {
        const roomId = await createRoom(result.value, Number(sizeSelect.value));
        actions.enterRoom(roomId, 0);
      } finally {
        createButton.disabled = false;
      }
    });
  });

  // Room list ------------------------------------------------------------------
  function renderRooms(rooms: LobbyRoom[]): void {
    if (rooms.length === 0) {
      list.replaceChildren(h('li', { className: 'empty' }, 'No open rooms yet. Create one!'));
      return;
    }
    list.replaceChildren(
      ...rooms.map((room) => {
        const full = room.playerCount >= room.maxPlayers;
        const join = h('button', { type: 'button', disabled: full }, full ? 'Full' : 'Join');
        join.addEventListener('click', () => {
          void run(async () => {
            const seat = await joinRoom(room.id);
            actions.enterRoom(room.id, seat);
          });
        });
        return h(
          'li',
          {},
          h(
            'div',
            { className: 'room-info' },
            h('strong', {}, room.name),
            h('span', { className: 'muted' }, `${room.hostName} · ${room.playerCount}/${room.maxPlayers}`),
          ),
          join,
        );
      }),
    );
  }

  let disposed = false;
  async function refresh(): Promise<void> {
    try {
      const rooms = await fetchLobbyRooms();
      if (!disposed) renderRooms(rooms);
    } catch (err) {
      if (!disposed) status.textContent = errorMessage(err);
    }
  }

  list.append(h('li', { className: 'empty' }, 'Loading rooms…'));
  void refresh();
  const unsubscribe = subscribeLobby(() => void refresh());

  // Header ---------------------------------------------------------------------
  const renameButton = h('button', { className: 'secondary', type: 'button' }, 'Change name');
  renameButton.addEventListener('click', () => actions.rename());
  const signOutButton = h('button', { className: 'secondary', type: 'button' }, 'Sign out');
  signOutButton.addEventListener('click', () => actions.signOut());
  const practiceButton = h('button', { className: 'secondary', type: 'button' }, 'Practice');
  practiceButton.addEventListener('click', () => actions.practice());
  const leaderboardButton = h('button', { className: 'secondary', type: 'button' }, 'Leaderboard');
  leaderboardButton.addEventListener('click', () => actions.leaderboard());

  const el = h(
    'div',
    { className: 'panel' },
    h(
      'div',
      { className: 'header' },
      h('h1', {}, `Hi, ${player.displayName}`),
      h('div', { className: 'row' }, leaderboardButton, renameButton, signOutButton),
    ),
    ...(notice ? [h('p', { className: 'notice' }, notice)] : []),
    h('h2', {}, 'Open rooms'),
    list,
    h('h2', {}, 'New room'),
    createForm,
    status,
    h('div', { className: 'row' }, practiceButton, h('p', { className: 'muted' }, 'Try the physics on your own, against bots.')),
  );

  return {
    el,
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
