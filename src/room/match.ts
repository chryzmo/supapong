import type { Gate } from '../types';
import { h, type View } from '../ui';
import type { RoomSession } from './session';
import { exitRoom, leaveButton, type RoomActions } from './waiting';

// Placeholder match screen: shows the gate order.  Milestone 5 replaces the
// body with the game.
export function matchScreen(session: RoomSession, gates: Gate[], actions: RoomActions): View {
  const { room, player, isHost } = session;
  const leave = leaveButton(session, actions, isHost ? 'End match' : 'Leave match');

  session.listen({
    event(event) {
      if (event.type === 'closed') actions.left('The host ended the match.');
    },
    hostGone: () => void exitRoom(session, actions, 'The host disconnected, so the match ended.'),
    seatLost: () => actions.left('You were disconnected from the match.'),
  });

  return {
    el: h(
      'div',
      { className: 'panel' },
      h('h1', {}, room.name),
      h('p', {}, 'Match started.  Gameplay arrives in milestone 5.'),
      h(
        'ol',
        { className: 'rooms' },
        ...gates.map((gate, i) =>
          h('li', {}, `Gate ${i + 1}: ${gate.displayName}${gate.playerId === player.id ? ' (you)' : ''}`),
        ),
      ),
      h('div', { className: 'row' }, leave),
    ),
  };
}
