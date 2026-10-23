import { MIN_PLAYERS, type Gate, type RosterEntry } from '../types';
import { errorMessage, h, type View } from '../ui';
import type { RoomSession } from './session';

export interface RoomActions {
  started(gates: Gate[]): void;
  /** Back to the lobby, with an optional reason to show there. */
  left(notice?: string): void;
}

/** Gives up the seat (best effort) and returns to the lobby with a reason. */
export async function exitRoom(session: RoomSession, actions: RoomActions, notice?: string): Promise<void> {
  try {
    await session.leave();
  } catch {
    // The seat or room may already be gone; the lobby is still the right place.
  }
  actions.left(notice);
}

/** A Leave button that calls exitRoom once. */
export function leaveButton(session: RoomSession, actions: RoomActions, label: string): HTMLButtonElement {
  const button = h('button', { className: 'secondary', type: 'button' }, label);
  button.addEventListener('click', () => {
    button.disabled = true;
    void exitRoom(session, actions);
  });
  return button;
}

export function waitingScreen(session: RoomSession, actions: RoomActions): View {
  const { room, player, isHost } = session;
  const status = h('p', { className: 'error' });
  const list = h('ul', { className: 'rooms roster' });
  const waitingFor = h('p', {});

  const start = h('button', { type: 'button', disabled: true }, 'Start match');
  start.addEventListener('click', async () => {
    start.disabled = true;
    status.textContent = '';
    try {
      actions.started(await session.startMatch());
    } catch (err) {
      status.textContent = errorMessage(err);
      renderRoster(session.getRoster());
    }
  });

  const leave = leaveButton(session, actions, isHost ? 'Close room' : 'Leave room');

  function renderRoster(roster: RosterEntry[]): void {
    const bySeat = new Map(roster.map((entry) => [entry.seat, entry]));
    const rows: HTMLElement[] = [];
    for (let seat = 0; seat < room.maxPlayers; seat++) {
      const entry = bySeat.get(seat);
      if (!entry) {
        rows.push(h('li', { className: 'open' }, `Seat ${seat + 1}: open`));
        continue;
      }
      const tags = h('span', { className: 'tags' });
      if (entry.playerId === room.hostId) tags.append(h('span', { className: 'tag' }, 'host'));
      if (entry.playerId === player.id) tags.append(h('span', { className: 'tag you' }, 'you'));
      rows.push(h('li', {}, h('span', {}, `Seat ${seat + 1}: ${entry.displayName}`), tags));
    }
    list.replaceChildren(...rows);

    const connected = roster.length;
    if (isHost) {
      start.disabled = connected < MIN_PLAYERS;
      start.textContent = connected < MIN_PLAYERS ? `Waiting for players…` : `Start match (${connected} players)`;
    } else {
      const host = roster.find((entry) => entry.playerId === room.hostId);
      waitingFor.textContent = host ? `Waiting for ${host.displayName} to start…` : 'Waiting for the host to connect…';
    }
  }

  session.listen({
    roster: renderRoster,
    event(event) {
      if (event.type === 'start') actions.started(event.gates);
      if (event.type === 'closed') actions.left('The host closed the room.');
    },
    hostGone: () => void exitRoom(session, actions, 'The host disconnected, so the room closed.'),
    seatLost: () => actions.left('You lost your seat in the room.'),
  });

  return {
    el: h(
      'div',
      { className: 'panel' },
      h('h1', {}, room.name),
      h('p', {}, isHost ? `You're hosting.  Start when everyone's here.` : `You're in seat ${room.seat + 1}.`),
      list,
      isHost ? h('div', { className: 'row' }, start, leave) : h('div', {}, waitingFor, h('div', { className: 'row' }, leave)),
      status,
    ),
  };
}
