// Dropdowns for the match settings, shared by Create room, the waiting room
// and practice.
import { GAME_TYPES, GOAL_LIMIT_CHOICES, MATCH_LENGTH_CHOICES, type GameType, type MatchSettings } from './types';
import { h } from './ui';

/** Power-ups, Only multiball, No power-ups. */
export function gameTypeSelect(selected: GameType = 'power-ups'): HTMLSelectElement {
  const select = h('select', { name: 'game_type' });
  for (const type of GAME_TYPES) select.append(h('option', { value: type.value, title: type.title, selected: type.value === selected }, type.label));
  return select;
}

/** The game type a gameTypeSelect shows. */
export function chosenGameType(select: HTMLSelectElement): GameType {
  return GAME_TYPES.find((type) => type.value === select.value)?.value ?? 'power-ups';
}

/**
 * Fills the goal limit and length dropdowns to show `settings`.  "No limit"
 * is the empty value, and only one of the two can have it, so each one's is
 * disabled while the other has it.  A goal limit outside the usual choices
 * (set some other way) still shows.
 */
export function showLimits(goals: HTMLSelectElement, length: HTMLSelectElement, settings: Pick<MatchSettings, 'goalLimit' | 'matchSeconds'>): void {
  const choices = [...new Set([...GOAL_LIMIT_CHOICES, ...(settings.goalLimit !== null ? [settings.goalLimit] : [])])].sort((a, b) => a - b);
  goals.replaceChildren(
    ...choices.map((n) => h('option', { value: String(n), selected: n === settings.goalLimit }, `${n} goals`)),
    h('option', { value: '', selected: settings.goalLimit === null, disabled: settings.matchSeconds === null }, 'No limit'),
  );
  length.replaceChildren(
    ...MATCH_LENGTH_CHOICES.map((n) => h('option', { value: String(n), selected: n === settings.matchSeconds }, `${n / 60} minutes`)),
    h('option', { value: '', selected: settings.matchSeconds === null, disabled: settings.goalLimit === null }, 'No limit'),
  );
}

/** A limit dropdown's value: null for "no limit". */
export function chosenLimit(select: HTMLSelectElement): number | null {
  return select.value === '' ? null : Number(select.value);
}
