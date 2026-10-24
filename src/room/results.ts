import { SEAT_COLORS } from '../game/render';
import { errorMessage, h, type View } from '../ui';
import { headline, standings, type MatchResult } from './standings';

export interface ResultsOptions {
  roomName: string;
  playerId: string;
  /** Host only: records the result.  Called on open, and again from Retry if it fails. */
  save?: () => Promise<void>;
  back(): void;
}

export function resultsScreen(result: MatchResult, options: ResultsOptions): View {
  const rows = standings(result);
  let disposed = false;

  const list = h(
    'ol',
    { className: 'rooms results' },
    ...rows.map((row) => {
      const swatch = h('span', { className: 'swatch' });
      swatch.style.background = SEAT_COLORS[row.gate % SEAT_COLORS.length]!;
      const tags = h('span', { className: 'tags' });
      if (row.playerId === options.playerId) tags.append(h('span', { className: 'tag you' }, 'you'));
      if (row.left) tags.append(h('span', { className: 'tag' }, 'left'));
      return h(
        'li',
        { className: row.place === 1 ? 'winner' : '' },
        h('span', { className: 'place' }, `${row.place}`),
        swatch,
        h('span', { className: 'name' }, row.displayName),
        tags,
        h('strong', { className: 'score' }, String(row.score)),
      );
    }),
  );

  const status = h('p', { className: 'muted' });
  const retry = h('button', { type: 'button', className: 'secondary', hidden: true }, 'Retry');

  async function save(): Promise<void> {
    if (!options.save) return;
    retry.hidden = true;
    status.className = 'muted';
    status.textContent = 'Saving the result…';
    try {
      await options.save();
      if (!disposed) status.textContent = 'Result saved.';
    } catch (err) {
      if (disposed) return;
      status.className = 'error';
      status.textContent = `Couldn't save the result: ${errorMessage(err)}`;
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', () => void save());
  void save();

  const back = h('button', { type: 'button' }, 'Back to lobby');
  back.addEventListener('click', () => options.back());

  return {
    el: h(
      'div',
      { className: 'panel' },
      h('p', { className: 'muted' }, `${options.roomName} · final score`),
      h('h1', {}, headline(rows)),
      list,
      status,
      h('div', { className: 'row' }, back, retry),
    ),
    dispose() {
      disposed = true;
    },
  };
}
