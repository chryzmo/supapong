// Single-player sandbox: you at gate 0, bots (or walls) everywhere else, and
// sliders for tuning the physics live.  No network.
import { MAX_PLAYERS, MIN_PLAYERS } from '../types';
import { h, type View } from '../ui';
import { Announcer } from './announce';
import { botInput } from './bot';
import { paddleInput } from './input';
import { hudParts } from './hud';
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
import { onMobileBrowser, touchControls } from './touch';

/** The config's numeric settings, the ones a slider can set. */
type NumberKey = { [K in keyof PhysicsConfig]: PhysicsConfig[K] extends number ? K : never }[keyof PhysicsConfig];

interface Slider {
  key: NumberKey;
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
  { key: 'wallJitter', label: 'Wall bounce jitter (rad)', min: 0, max: 0.5, step: 0.01 },
  { key: 'gateFraction', label: 'Gate size (share of sector)', min: 0.2, max: 1, step: 0.02 },
  { key: 'paddleOverhang', label: 'Paddle past gate end (share of half-width)', min: 0, max: 1, step: 0.05 },
  { key: 'ballRadius', label: 'Ball size', min: 0.01, max: 0.06, step: 0.002 },
];

const POWER_UP_SLIDERS: Slider[] = [
  { key: 'pickupVolley', label: 'Token every N hits in a rally', min: 2, max: 20, step: 1 },
  { key: 'pickupMinSeconds', label: 'Token timer, shortest (s)', min: 1, max: 30, step: 1 },
  { key: 'pickupMaxSeconds', label: 'Token timer, longest (s)', min: 1, max: 30, step: 1 },
  { key: 'pickupLifetime', label: 'Token lasts (s)', min: 2, max: 30, step: 1 },
  { key: 'pickupMax', label: 'Tokens on the board at once', min: 1, max: 8, step: 1 },
  { key: 'wideFactor', label: 'Wide paddle size (×)', min: 1, max: 3, step: 0.1 },
  { key: 'wideDuration', label: 'Wide paddle lasts (s)', min: 1, max: 20, step: 1 },
  { key: 'shieldDuration', label: 'Shield lasts (s)', min: 1, max: 30, step: 1 },
];

const FLASH_TICKS = 36;

export interface SandboxActions {
  back(): void;
}

export function sandboxScreen(actions: SandboxActions): View {
  // Power-ups are off for online matches (DEFAULT_CONFIG) for now, but on here.
  const config: PhysicsConfig = { ...DEFAULT_CONFIG, powerUps: true };
  let players = 4;
  let bots = true;
  let botSkill = 0.7;
  // Random, so the first game doesn't always open the same way.
  let seed = (Math.random() * 2 ** 32) >>> 0;

  let state = newGame();
  let prev = state;
  let flash: { gate: number; scorer: number; until: number } | undefined;
  const announcer = new Announcer();
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

  const powerUpsToggle = h('input', { type: 'checkbox', checked: config.powerUps });
  powerUpsToggle.addEventListener('change', () => {
    config.powerUps = powerUpsToggle.checked;
    restart();
  });

  const slider = (spec: Slider): HTMLElement => {
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
  };
  const sliders = SLIDERS.map(slider);
  const powerUpSliders = POWER_UP_SLIDERS.map(slider);

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
    // Without powerUps: DEFAULT_CONFIG keeps them off until online matches carry them.
    const { powerUps: _, ...tuned } = config;
    void navigator.clipboard.writeText(JSON.stringify(tuned, null, 2)).then(() => {
      copyButton.textContent = 'Copied';
      setTimeout(() => (copyButton.textContent = 'Copy config'), 1200);
    });
  });

  // HUD and board ---------------------------------------------------------------
  const canvas = h('canvas', { className: 'board' });
  const hud = h('p', { className: 'muted hud' });
  const input = paddleInput();
  const touch = onMobileBrowser();

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
      if (goal?.type === 'goal') flash = { gate: goal.gate, scorer: goal.scorer, until: state.tick + FLASH_TICKS };
      if (isOver(state, config)) {
        over = true;
        prev = state;
      }
    },
    (alpha) => {
      const shown = interpolate(prev, state, alpha);
      const announced = announcer.next(shown, performance.now(), labels());
      draw(canvas, shown, config, {
        labels: labels(),
        viewerGate: 0,
        ...(announced ? { announcement: announced } : {}),
        ...(flash && state.tick < flash.until ? { flashGate: flash.gate, ...(flash.scorer >= 0 ? { scorerGate: flash.scorer } : {}) } : {}),
        ...(over ? { centerText: 'Match over' } : state.tick < config.respawnDelay * TICK_RATE ? { centerText: 'Ready' } : {}),
      });
      hud.textContent = [...hudParts(state, config, 0), `speed ${Math.max(...state.balls.map(ballSpeed)).toFixed(2)}`].join(' · ');
    },
  );

  const el = h(
    'div',
    { className: 'stage' },
    h(
      'div',
      { className: touch ? 'stage-main touch' : 'stage-main' },
      canvas,
      ...(touch ? [touchControls(input)] : []),
      hud,
      h('p', { className: 'muted' }, touch ? 'Hold ◀ ▶ to move' : '← → or A D to move · Space to pause · R to restart'),
    ),
    h(
      'aside',
      { className: 'panel tuning' },
      h('div', { className: 'header' }, h('h1', {}, 'Practice'), backButton),
      h('div', { className: 'row' }, h('label', {}, 'Gates', playersSelect), h('label', { className: 'check' }, botsToggle, 'Bots')),
      h('label', {}, h('span', { className: 'slider-label' }, 'Bot skill', skillValue), skillSlider),
      h('h2', {}, 'Physics'),
      ...sliders,
      h('h2', {}, 'Power-ups'),
      h('label', { className: 'check' }, powerUpsToggle, 'Power-ups'),
      ...powerUpSliders,
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
