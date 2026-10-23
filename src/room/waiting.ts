import { leaveRoom } from '../lobby/api';
import type { Player, SeatedRoom } from '../types';
import { errorMessage, h, type View } from '../ui';

export interface WaitingActions {
  left(): void;
}

// Placeholder waiting room.  Milestone 3 adds the Presence roster and the
// host's Start button.
export function waitingScreen(player: Player, room: SeatedRoom, actions: WaitingActions): View {
  const isHost = room.hostId === player.id;
  const status = h('p', { className: 'error' });

  const leave = h('button', { className: 'secondary', type: 'button' }, isHost ? 'Close room' : 'Leave room');
  leave.addEventListener('click', async () => {
    leave.disabled = true;
    try {
      await leaveRoom(room, player.id);
      actions.left();
    } catch (err) {
      status.textContent = errorMessage(err);
      leave.disabled = false;
    }
  });

  return {
    el: h(
      'div',
      { className: 'panel' },
      h('h1', {}, room.name),
      h('p', {}, `You're in seat ${room.seat + 1} of ${room.maxPlayers}${isHost ? ' and hosting' : ''}.`),
      h('p', {}, 'Waiting for players…'),
      h('div', { className: 'row' }, leave),
      status,
    ),
  };
}
