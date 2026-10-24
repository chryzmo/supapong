import { BOT_LEVELS } from '../game/bot';
import { MIN_PLAYERS, type Gate, type MatchStart, type RosterEntry } from '../types';
import { errorMessage, h, type View } from '../ui';
import { lineup, maxBots } from './lineup';
import type { RoomSession } from './session';
import type { MatchResult } from './standings';

export interface RoomActions {
  started(start: MatchStart): void;
  /** The match is over: show the results. */
  ended(result: MatchResult): void;
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

  // Host only: bots fill out the match, up to 8 gates whatever the room's
  // size.  The count's choices follow the roster.
  const botsSelect = h('select', { name: 'bots' });
  const skillSelect = h('select', { name: 'bot_skill' });
  BOT_LEVELS.forEach((level, i) => skillSelect.append(h('option', { value: String(i), selected: level.label === 'Normal' }, level.label)));
  const botCount = (): number => Number(botsSelect.value || 0);
  botsSelect.addEventListener('change', () => renderRoster(session.getRoster()));
  const botControls = h(
    'div',
    { className: 'row bots' },
    h('label', {}, 'Bots', botsSelect),
    h('label', {}, 'Bot skill', skillSelect),
  );

  const start = h('button', { type: 'button', disabled: true }, 'Start match');
  start.addEventListener('click', async () => {
    start.disabled = true;
    status.textContent = '';
    try {
      const level = BOT_LEVELS[Number(skillSelect.value)] ?? BOT_LEVELS[1];
      actions.started(await session.startMatch({ bots: botCount(), botSkill: level.skill }));
    } catch (err) {
      status.textContent = errorMessage(err);
      renderRoster(session.getRoster());
    }
  });

  const leave = leaveButton(session, actions, isHost ? 'Close room' : 'Leave room');

  function renderBotChoices(humans: number): void {
    const most = maxBots(humans);
    const chosen = Math.min(botCount(), most);
    botsSelect.replaceChildren(
      ...Array.from({ length: most + 1 }, (_, n) => h('option', { value: String(n), selected: n === chosen }, n === 0 ? 'None' : String(n))),
    );
    skillSelect.disabled = chosen === 0;
  }

  function renderRoster(roster: RosterEntry[]): void {
    if (isHost) renderBotChoices(roster.length);
    // The host sees where the bots will sit; everyone else sees open seats.
    const bots: Gate[] = isHost ? lineup(roster, botCount()).filter((gate) => gate.bot) : [];
    const botBySeat = new Map(bots.map((gate) => [gate.seat, gate]));
    const bySeat = new Map(roster.map((entry) => [entry.seat, entry]));
    const rows: HTMLElement[] = [];
    // Bots can sit past the room's size, so list up to the last of them.
    const lastSeat = Math.max(room.maxPlayers, ...bots.map((gate) => gate.seat + 1));
    for (let seat = 0; seat < lastSeat; seat++) {
      const entry = bySeat.get(seat);
      const bot = botBySeat.get(seat);
      if (bot) {
        rows.push(h('li', {}, h('span', {}, `Seat ${seat + 1}: ${bot.displayName}`), h('span', { className: 'tags' }, h('span', { className: 'tag' }, 'bot'))));
        continue;
      }
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
      const bots = botCount();
      start.textContent =
        connected < MIN_PLAYERS
          ? `Waiting for players…`
          : `Start match (${connected} players${bots ? ` + ${bots} bot${bots === 1 ? '' : 's'}` : ''})`;
    } else {
      const host = roster.find((entry) => entry.playerId === room.hostId);
      waitingFor.textContent = host ? `Waiting for ${host.displayName} to start…` : 'Waiting for the host to connect…';
    }
  }

  session.listen({
    roster: renderRoster,
    event(event) {
      if (event.type === 'start') actions.started({ gates: event.gates, goalLimit: event.goalLimit });
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
      h('p', { className: 'muted' }, `${room.goalLimit} goals, or 2 minutes.`),
      list,
      ...(isHost ? [botControls] : []),
      isHost ? h('div', { className: 'row' }, start, leave) : h('div', {}, waitingFor, h('div', { className: 'row' }, leave)),
      status,
    ),
  };
}
