// Single-player sandbox: you at gate 0, bots (or walls) everywhere else, and
// sliders for tuning the physics live.  No network.
import { MAX_PLAYERS, MIN_PLAYERS } from '../types';
import { h, type View } from '../ui';
import { botInput } from './bot';
import { keyboardInput } from './input';
import { interpolate } from './interpolate';
import { startFixedLoop } from './loop';
import {
  DEFAULT_CONFIG,
  TICK_RATE,
  ballSpeed,
  createGame,
  isOver,
  setGateActive,
  step,
  type Dir,
  type GameState,
  type PhysicsConfig,
} from './physics';
import { SEAT_COLORS, draw, type GateLabel } from './render';

interface Slider {
  key: keyof PhysicsConfig;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: Slider[] = [
  { key: 'launchSpeed', label: 'Launch speed', min: 0.2, max: 1.5, step: 0.05 },
  { key: 'speedUpPerHit', label: 'Speed-up per hit', min: 1, max: 1.2, step: 0.01 },
  { key: 'maxSpeed', label: 'Max speed', min: 0.5, max: 3, step: 0.05 },
  { key: 'paddleFraction', label: 'Paddle size (share of gate)', min: 0.1, max: 0.8, step: 0.02 },
  { key: 'paddleSpeed', label: 'Paddle speed (gates/s)', min: 0.3, max: 4, step: 0.1 },
  { key: 'english', label: 'English', min: 0, max: 1.5, step: 0.05 },
  { key: 'minRadialShare', label: 'Min bounce-back angle', min: 0, max: 0.9, step: 0.05 },
  { key: 'gateFraction', label: 'Gate size (share of sector)', min: 0.2, max: 1, step: 0.02 },
  { key: 'ballRadius', label: 'Ball size', min: 0.01, max: 0.06, step: 0.002 },
];

const FLASH_TICKS = 36;

export interface SandboxActions {
  back(): void;
}

export function sandboxScreen(actions: SandboxActions): View {
  const config: PhysicsConfig = { ...DEFAULT_CONFIG };
  let players = 4;
  let bots = true;
  let botSkill = 0.7;
  let seed = 1;

  let state = newGame();
  let prev = state;
  let flash: { gate: number; until: number } | undefined;
  let over = false;
  let paused = false;

  /** A fresh game with a new seed.  Without bots, the other gates are walls. */
  function newGame(): GameState {
    seed = (seed * 1103515245 + 12345) >>> 0;
    let game = createGame(players, seed, config);
    if (!bots) for (let i = 1; i < players; i++) game = setGateActive(game, i, false);
    return game;
  }

  function restart(): void {
    state = newGame();
    prev = state;
    flash = undefined;
    over = false;
    setPaused(false);
  }

  function setPaused(value: boolean): void {
    paused = value;
    loop.setPaused(value);
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
  }

  // Controls -------------------------------------------------------------------
  const playersSelect = h('select', {});
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    playersSelect.append(h('option', { value: String(n), selected: n === players }, `${n} gates`));
  }
  playersSelect.addEventListener('change', () => {
    players = Number(playersSelect.value);
    restart();
  });

  const botsToggle = h('input', { type: 'checkbox', checked: bots });
  botsToggle.addEventListener('change', () => {
    bots = botsToggle.checked;
    restart();
  });

  const skillValue = h('span', { className: 'muted' }, botSkill.toFixed(2));
  const skillSlider = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(botSkill) });
  skillSlider.addEventListener('input', () => {
    botSkill = Number(skillSlider.value);
    skillValue.textContent = botSkill.toFixed(2);
  });

  const sliders = SLIDERS.map((spec) => {
    const value = h('span', { className: 'muted' }, String(config[spec.key]));
    const input = h('input', {
      type: 'range',
      min: String(spec.min),
      max: String(spec.max),
      step: String(spec.step),
      value: String(config[spec.key]),
    });
    input.addEventListener('input', () => {
      config[spec.key] = Number(input.value);
      value.textContent = input.value;
    });
    return h('label', {}, h('span', { className: 'slider-label' }, spec.label, value), input);
  });

  const pauseButton = h('button', { type: 'button', className: 'secondary' }, 'Pause');
  const togglePause = (): void => {
    if (!over) setPaused(!paused);
  };
  pauseButton.addEventListener('click', togglePause);

  const restartButton = h('button', { type: 'button' }, 'Restart');
  restartButton.addEventListener('click', restart);

  const backButton = h('button', { type: 'button', className: 'secondary' }, 'Back');
  backButton.addEventListener('click', () => actions.back());

  const copyButton = h('button', { type: 'button', className: 'secondary' }, 'Copy config');
  copyButton.addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(config, null, 2)).then(() => {
      copyButton.textContent = 'Copied';
      setTimeout(() => (copyButton.textContent = 'Copy config'), 1200);
    });
  });

  // HUD and board ---------------------------------------------------------------
  const canvas = h('canvas', { className: 'board' });
  const hud = h('p', { className: 'muted hud' });
  const input = keyboardInput();

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyP' || e.code === 'Space') {
      e.preventDefault();
      togglePause();
    }
    if (e.code === 'KeyR') restart();
  };
  window.addEventListener('keydown', onKey);

  const labels = (): GateLabel[] =>
    Array.from({ length: players }, (_, i) => ({
      name: i === 0 ? 'You' : `Bot ${i}`,
      color: SEAT_COLORS[i % SEAT_COLORS.length]!,
    }));

  const loop = startFixedLoop(
    () => {
      if (over) return;
      const inputs: Dir[] = state.gates.map((_, i) => (i === 0 ? input.dir() : botInput(state, i, config, botSkill)));
      const result = step(state, inputs, config);
      prev = state;
      state = result.state;
      const goal = result.events.find((e) => e.type === 'goal');
      if (goal?.type === 'goal') flash = { gate: goal.gate, until: state.tick + FLASH_TICKS };
      if (isOver(state, config)) {
        over = true;
        prev = state;
      }
    },
    (alpha) => {
      const shown = interpolate(prev, state, alpha);
      const secondsLeft = Math.max(0, config.matchDuration - state.tick / TICK_RATE);
      draw(canvas, shown, config, {
        labels: labels(),
        viewerGate: 0,
        ...(flash && state.tick < flash.until ? { flashGate: flash.gate } : {}),
        ...(over ? { centerText: 'Match over' } : state.tick < config.respawnDelay * TICK_RATE ? { centerText: 'Ready' } : {}),
      });
      const time = `${Math.floor(secondsLeft / 60)}:${String(Math.floor(secondsLeft % 60)).padStart(2, '0')}`;
      hud.textContent = `${time} left · first to ${config.scoreCap} · rally ${state.rally} · speed ${ballSpeed(state.ball).toFixed(2)}`;
    },
  );

  const el = h(
    'div',
    { className: 'stage' },
    h(
      'div',
      { className: 'stage-main' },
      canvas,
      hud,
      h('p', { className: 'muted' }, '← → or A D to move · Space to pause · R to restart'),
    ),
    h(
      'aside',
      { className: 'panel tuning' },
      h('div', { className: 'header' }, h('h1', {}, 'Practice'), backButton),
      h('div', { className: 'row' }, h('label', {}, 'Gates', playersSelect), h('label', { className: 'check' }, botsToggle, 'Bots')),
      h('label', {}, h('span', { className: 'slider-label' }, 'Bot skill', skillValue), skillSlider),
      h('h2', {}, 'Physics'),
      ...sliders,
      h('div', { className: 'row' }, restartButton, pauseButton, copyButton),
    ),
  );

  return {
    el,
    dispose() {
      loop.stop();
      input.dispose();
      window.removeEventListener('keydown', onKey);
    },
  };
}
