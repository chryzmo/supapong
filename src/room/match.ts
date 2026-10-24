// The match screen.  The host runs the game (HostGame); everyone else
// renders the host's snapshots (ClientGame).  Both draw the same way.
import { ClientGame } from '../game/client';
import { COUNTDOWN_SECONDS, HostGame } from '../game/host';
import { paddleInput } from '../game/input';
import { startFrames } from '../game/loop';
import { DEFAULT_CONFIG, TICK_RATE, type GameState } from '../game/physics';
import { SEAT_COLORS, draw, type RenderView } from '../game/render';
import { onMobileBrowser, touchControls } from '../game/touch';
import type { MatchStart } from '../types';
import { h, type View } from '../ui';
import type { RoomSession } from './session';
import { scoresByPlayer, type MatchResult } from './standings';
import { exitRoom, leaveButton, type RoomActions } from './waiting';

const FLASH_MS = 600;
/** How long "Match over" stays on the board before the results screen. */
const RESULTS_DELAY_MS = 1500;
export function matchScreen(session: RoomSession, start: MatchStart, actions: RoomActions): View {
  const { gates } = start;
  const config = { ...DEFAULT_CONFIG, goalLimit: start.goalLimit };
  const { room, player, isHost } = session;
  const myGate = gates.findIndex((gate) => gate.playerId === player.id);
  const labels = gates.map((gate, i) => ({ name: gate.displayName, color: SEAT_COLORS[i % SEAT_COLORS.length]! }));

  const canvas = h('canvas', { className: 'board' });
  const hud = h('p', { className: 'muted hud' });
  const leave = leaveButton(session, actions, isHost ? 'End match' : 'Leave match');

  let flash: { gate: number; until: number } | undefined;
  let finalScores: number[] | undefined;
  let resultsTimer: ReturnType<typeof setTimeout> | undefined;
  const onGoal = (gate: number): void => {
    flash = { gate, until: performance.now() + FLASH_MS };
  };
  const onEnd = (scores: number[]): void => {
    if (finalScores) return;
    finalScores = scores;
    leave.disabled = true;
    const state = host ? host.view() : client!.view();
    const result: MatchResult = { gates, scores, active: state.gates.map((g) => g.active) };
    // The host saves straight away; the results screen shows how it went.
    if (isHost) session.finishMatch(scoresByPlayer(result)).catch(() => {});
    resultsTimer = setTimeout(() => actions.ended(result), RESULTS_DELAY_MS);
  };

  const host = isHost ? new HostGame(session, gates, myGate, { config, onGoal, onEnd, ...(start.botSkill !== undefined ? { botSkill: start.botSkill } : {}) }) : undefined;
  const client = isHost
    ? undefined
    : new ClientGame(gates, myGate, (dir) => session.sendInput({ seat: room.seat, dir }), { config });
  const input = paddleInput((dir) => (host ? host.setOwnInput(dir) : client?.setOwnInput(dir)));

  session.listen({
    input: (message) => host?.applyInput(message.seat, message.dir),
    state: (message) => client?.onState(message),
    playerGone: (playerId) => host?.removePlayer(playerId),
    event(event) {
      if (event.type === 'goal' && !host) onGoal(event.gate);
      if (event.type === 'end') onEnd(event.scores);
      // After the final whistle the host leaving is expected; stay on the scores.
      if (event.type === 'closed' && !finalScores) actions.left('The host ended the match.');
    },
    hostGone: () => {
      if (!finalScores) void exitRoom(session, actions, 'The host disconnected, so the match ended.');
    },
    seatLost: () => actions.left('You were disconnected from the match.'),
  });

  host?.start();

  const stopFrames = startFrames((now) => {
    const state: GameState = host ? host.view() : client!.view();
    draw(canvas, state, config, renderView(state, now));
    const secondsLeft = Math.max(0, config.matchDuration - state.tick / TICK_RATE);
    const time = `${Math.floor(secondsLeft / 60)}:${String(Math.floor(secondsLeft % 60)).padStart(2, '0')}`;
    hud.textContent = finalScores ? 'Final score' : `${time} left · ${state.goals}/${config.goalLimit} goals · rally ${state.rally}`;
  });

  function renderView(state: GameState, now: number): RenderView {
    const view: RenderView = { labels, viewerGate: myGate >= 0 ? myGate : null };
    if (flash && now < flash.until) view.flashGate = flash.gate;
    if (finalScores) view.centerText = 'Match over';
    else if (client && !client.hasState()) view.centerText = 'Connecting…';
    else if (state.respawnTicks > 0 && state.tick < COUNTDOWN_SECONDS * TICK_RATE) {
      view.centerText = String(Math.ceil(state.respawnTicks / TICK_RATE));
    }
    return view;
  }

  // Spectators have no paddle, so they get no buttons.
  const touch = onMobileBrowser() && myGate >= 0;

  return {
    el: h(
      'div',
      { className: 'stage single' },
      h(
        'div',
        { className: touch ? 'stage-main touch' : 'stage-main' },
        canvas,
        ...(touch ? [touchControls(input)] : []),
        hud,
        h('p', { className: 'muted' }, touch ? 'Hold ◀ ▶ to move' : '← → or A D to move'),
        h('div', { className: 'row' }, leave),
      ),
    ),
    dispose() {
      clearTimeout(resultsTimer);
      stopFrames();
      input.dispose();
      host?.stop();
    },
  };
}
