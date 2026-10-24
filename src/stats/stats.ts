import type { LeaderboardEntry, MatchSummary, Player } from '../types';
import { errorMessage, h, type View } from '../ui';
import { fetchLeaderboard, fetchRecentMatches, fetchStanding } from './api';
import { ordinal, timeAgo } from './history';

export interface StatsActions {
  back(): void;
}

/** The leaderboard and recent matches, fetched once on open. */
export function statsScreen(player: Player, actions: StatsActions): View {
  let disposed = false;
  const status = h('p', { className: 'error' });

  function fail(err: unknown): void {
    if (!disposed) status.textContent = errorMessage(err);
  }

  // Leaderboard --------------------------------------------------------------
  const board = h('ol', { className: 'rooms results leaderboard' }, h('li', { className: 'empty' }, 'Loading…'));

  function standingRow(entry: LeaderboardEntry): HTMLLIElement {
    const you = entry.playerId === player.id;
    return h(
      'li',
      { className: you ? 'you' : '' },
      h('span', { className: 'place' }, String(entry.rank)),
      h('span', { className: 'name' }, entry.displayName),
      ...(you ? [h('span', { className: 'tag you' }, 'you')] : []),
      h('span', { className: 'muted stat' }, `${entry.wins} W · ${entry.points} pts · ${entry.matches} played`),
    );
  }

  async function loadBoard(): Promise<void> {
    const [top, mine] = await Promise.all([fetchLeaderboard(), fetchStanding(player.id)]);
    if (disposed) return;
    if (top.length === 0) {
      board.replaceChildren(h('li', { className: 'empty' }, 'No finished matches yet.'));
      return;
    }
    const rows = top.map(standingRow);
    // Players outside the top still see where they stand.
    if (mine && !top.some((entry) => entry.playerId === mine.playerId)) {
      rows.push(h('li', { className: 'gap' }, '…'), standingRow(mine));
    }
    board.replaceChildren(...rows);
  }

  // Recent matches -------------------------------------------------------------
  const history = h('ul', { className: 'rooms history' });
  const allButton = h('button', { type: 'button', className: 'secondary' }, 'All');
  const mineButton = h('button', { type: 'button', className: 'secondary' }, 'Mine');

  function matchRow(match: MatchSummary, now: Date): HTMLLIElement {
    const lineup = h('span', { className: 'lineup' });
    match.players.forEach((p, i) => {
      if (i > 0) lineup.append(' · ');
      const name = h('span', { className: p.won ? 'won' : '' }, `${p.displayName} ${p.score}`);
      lineup.append(name);
    });
    const me = match.players.find((p) => p.playerId === player.id);
    return h(
      'li',
      {},
      h(
        'div',
        { className: 'room-info' },
        h('strong', {}, match.roomName ?? 'Untitled room'),
        h('span', { className: 'muted' }, `${timeAgo(match.finishedAt, now)} · ${match.players.length} players`),
        lineup,
      ),
      ...(me ? [h('span', { className: me.won ? 'tag you' : 'tag' }, `you: ${ordinal(me.place)}`)] : []),
    );
  }

  let request = 0;
  async function loadHistory(onlyMine: boolean): Promise<void> {
    allButton.setAttribute('aria-pressed', String(!onlyMine));
    mineButton.setAttribute('aria-pressed', String(onlyMine));
    history.replaceChildren(h('li', { className: 'empty' }, 'Loading…'));
    // Switching filters quickly shouldn't let an older reply win.
    const mine = ++request;
    const matches = await fetchRecentMatches(onlyMine ? { playerId: player.id } : {});
    if (disposed || mine !== request) return;
    if (matches.length === 0) {
      history.replaceChildren(h('li', { className: 'empty' }, onlyMine ? "You haven't finished a match yet." : 'No finished matches yet.'));
      return;
    }
    const now = new Date();
    history.replaceChildren(...matches.map((match) => matchRow(match, now)));
  }

  allButton.addEventListener('click', () => loadHistory(false).catch(fail));
  mineButton.addEventListener('click', () => loadHistory(true).catch(fail));

  loadBoard().catch(fail);
  loadHistory(false).catch(fail);

  const back = h('button', { type: 'button', className: 'secondary' }, 'Back to lobby');
  back.addEventListener('click', () => actions.back());

  return {
    el: h(
      'div',
      { className: 'panel' },
      h('div', { className: 'header' }, h('h1', {}, 'Leaderboard'), back),
      board,
      h('p', { className: 'muted' }, 'Ranked by wins, then points.  Sharing first place counts as a win; a match where everyone ties has no winner.'),
      h('div', { className: 'header' }, h('h2', {}, 'Recent matches'), h('div', { className: 'row toggle' }, allButton, mineButton)),
      history,
      status,
    ),
    dispose() {
      disposed = true;
    },
  };
}
