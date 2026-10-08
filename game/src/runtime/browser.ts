import { createGameAudio, type AudioScene } from '../audio/game-audio';
import { createBrowserInput, type InputAction } from '../input/browser';
import { drawAutomap } from '../presentation/automap';
import { createGameMenu, type MenuAction } from '../presentation/menu';
import { createPatchPainter, paletteForPlayer } from '../presentation/patches';
import { drawSessionScreen } from '../presentation/screens';
import { createStatusBar } from '../presentation/status';
import { createWorldRenderer } from '../render/world';
import { createSession, type SessionOptions } from '../session/session';
import { advanceClock, createClock } from '../simulation/clock';
import { createCheats } from '../simulation/cheats';
import { TicButton, WEAPON_SHIFT } from '../simulation/command';
import { FRAC_UNIT } from '../simulation/fixed';
import { menuRandom } from '../simulation/random';
import type { World } from '../simulation/world';
import { findLump, parseWad, readLump } from '../wad/archive';
import { decodeDemo, type DoomDemo } from '../wad/demo';
import { createResources } from '../wad/resources';
import { gameStyles } from './styles';

export interface GameStatus {
  readonly state: 'level' | 'intermission' | 'finale';
  readonly level: string;
  readonly paused: boolean;
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly simulationMs: number;
  readonly renderCpuMs: number;
}

export interface MountOptions {
  readonly wadUrl?: string;
  readonly wadBytes?: Uint8Array;
  readonly resolution?: 320 | 640 | 960;
  readonly onStatus?: (status: GameStatus) => void;
  readonly onError?: (error: Error) => void;
}

export interface DoomGame {
  newGame(options?: SessionOptions): void;
  playDemo(name?: string): void;
  pause(): void;
  resume(): void;
  openMenu(): void;
  save(slot?: number): void;
  load(slot?: number): void;
  loadWad(bytes: Uint8Array): void;
  fullscreen(): Promise<void>;
  dispose(): void;
}

export async function mountDoom(
  container: HTMLElement,
  options: MountOptions = {},
): Promise<DoomGame> {
  const owner = container.ownerDocument,
    window = owner.defaultView;
  if (!window) throw new Error('Doom requires a browser window');
  const bytes =
    options.wadBytes ??
    (await (async () => {
      const response = await fetch(
        options.wadUrl ?? new URL('../../assets/doom1.wad?no-inline', import.meta.url).href,
      );
      if (!response.ok) throw new Error(`Could not load Doom WAD (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    })());
  let wad = parseWad(bytes),
    resources = createResources(wad),
    session = createSession(wad, resources);
  const root = owner.createElement('div');
  root.className = 'doom-threejs';
  const style = owner.createElement('style');
  style.textContent = gameStyles;
  root.append(style);
  const stage = owner.createElement('div');
  stage.className = 'doom-stage';
  stage.tabIndex = 0;
  stage.setAttribute('role', 'application');
  stage.setAttribute(
    'aria-label',
    'Doom. WASD to move, mouse to turn, control to fire, space to use, escape for menu.',
  );
  const screen = owner.createElement('div');
  screen.className = 'doom-screen';
  let canvas = owner.createElement('canvas');
  canvas.className = 'doom-world';
  const overlay = owner.createElement('canvas');
  overlay.className = 'doom-overlay';
  overlay.width = 320;
  overlay.height = 200;
  const context = overlay.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  context.imageSmoothingEnabled = false;
  screen.append(canvas, overlay);
  stage.append(screen);
  root.append(stage);
  const statusText = owner.createElement('div');
  statusText.className = 'doom-sr';
  statusText.setAttribute('aria-live', 'polite');
  root.append(statusText);
  const errorPanel = owner.createElement('div');
  errorPanel.className = 'doom-error';
  errorPanel.hidden = true;
  const errorText = owner.createElement('p'),
    errorClose = owner.createElement('button');
  errorClose.type = 'button';
  errorClose.textContent = 'return to menu';
  errorPanel.append(errorText, errorClose);
  screen.append(errorPanel);
  let currentWorld: World | null = null;
  const audioOptions = {
    random: () => (currentWorld ? menuRandom(currentWorld.random) : 0),
    onError: (error: Error) => reportError(error),
  };
  let renderer = createWorldRenderer(canvas, resources),
    audio = createGameAudio(wad, audioOptions);
  let painter = createPatchPainter(resources, owner),
    statusBar = createStatusBar(painter);
  const resolution = options.resolution ?? 640;
  renderer.resize(resolution, Math.round((resolution * 168) / 320));
  const input = createBrowserInput(stage),
    touch = new Set<string>();
  const touchPanel = owner.createElement('div');
  touchPanel.className = 'doom-touch';
  const touchCaptions = {
    left: '←',
    forward: '↑',
    back: '↓',
    right: '→',
    fire: 'fire',
    use: 'use',
    menu: 'menu',
  };
  for (const [key, label] of [
    ['left', 'turn left'],
    ['forward', 'forward'],
    ['back', 'back'],
    ['right', 'turn right'],
    ['fire', 'fire'],
    ['use', 'use'],
    ['menu', 'menu'],
  ] as const) {
    const button = owner.createElement('button');
    button.type = 'button';
    button.textContent = touchCaptions[key];
    button.setAttribute('aria-label', label);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      stage.focus();
      void audio.unlock().catch(reportError);
      if (key === 'menu') handleAction('menu');
      else touch.add(key);
    });
    const release = (): void => {
      touch.delete(key);
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    touchPanel.append(button);
  }
  root.append(touchPanel);
  let paused = false,
    automap = false,
    disposed = false,
    failedRender = false,
    pendingWeapon: number | null = null;
  let automapReveal: 0 | 1 | 2 = 0;
  const cheats = createCheats();
  let message = '',
    messageUntil = 0,
    menuTick = 0,
    frameId = 0,
    lastStatus = 0,
    fps = 60,
    previousFrame = performance.now();
  let sfxVolume = 0.8,
    musicVolume = 0.55,
    demo: DoomDemo | null = null,
    demoTic = 0;
  audio.setVolume(sfxVolume, musicVolume);
  const clock = createClock(previousFrame);
  const ensureActive = (): void => {
    if (disposed) throw new Error('Doom game is disposed');
  };
  const storageKey = (slot: number): string =>
    `doom-threejs:${wad.kind}:${wad.bytes.length}:${slot}`;
  const savedSlots = (): string[] => {
    try {
      return Array.from(
        { length: 6 },
        (_, slot) => window.localStorage.getItem(`${storageKey(slot)}:label`) ?? 'EMPTY SLOT',
      );
    } catch {
      return [];
    }
  };
  let menu = createGameMenu(
    painter,
    () => (session.state.kind === 'level' ? session.state.world.mode : sessionOptionsMode()),
    savedSlots,
  );
  function sessionOptionsMode() {
    return findLump(wad, 'E4M1')
      ? ('retail' as const)
      : findLump(wad, 'E2M1')
        ? ('registered' as const)
        : ('shareware' as const);
  }
  const reportError = (value: unknown): void => {
    const error = value instanceof Error ? value : new Error(String(value));
    paused = true;
    audio.pause(true);
    errorText.textContent = error.message;
    errorPanel.hidden = false;
    owner.exitPointerLock();
    options.onError?.(error);
  };
  const tell = (text: string): void => {
    message = text.toUpperCase();
    messageUntil = performance.now() + 3500;
    statusText.textContent = text;
  };
  const scene = (world: World): AudioScene => {
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Listener actor is missing');
    return {
      listener: { actor: actor.id, x: actor.x, y: actor.y, angle: actor.angle },
      actors: world.actorsById,
      sectors: world.sectors,
      mapNumber: world.mapNumber,
    };
  };
  const soundScene = (): AudioScene =>
    currentWorld
      ? scene(currentWorld)
      : {
          listener: { actor: -1, x: 0, y: 0, angle: 0 },
          actors: new Map(),
          sectors: [],
          mapNumber: 1,
        };
  const resetClock = (): void => {
    clock.previousTime = performance.now();
    clock.accumulatedMs = 0;
  };
  function openMenu(): void {
    ensureActive();
    errorPanel.hidden = true;
    menu.show();
    touch.clear();
    input.clear();
    audio.pause(true);
    owner.exitPointerLock();
    stage.focus();
  }
  const resume = (): void => {
    ensureActive();
    paused = false;
    menu.hide();
    errorPanel.hidden = true;
    resetClock();
    audio.pause(false);
    stage.focus();
    void audio.unlock().catch(reportError);
  };
  const save = (slot = 0): void => {
    ensureActive();
    try {
      const value = session.save();
      window.localStorage.setItem(storageKey(slot), value);
      const state = session.state;
      const label =
        state.kind === 'level'
          ? `${state.world.spatial.map.name} / ${Math.floor(state.world.levelTime / 35)} SEC`
          : state.kind.toUpperCase();
      window.localStorage.setItem(`${storageKey(slot)}:label`, label);
      tell(`saved ${label}`);
    } catch (error) {
      reportError(error);
    }
  };
  const load = (slot = 0): void => {
    ensureActive();
    try {
      const value = window.localStorage.getItem(storageKey(slot));
      if (!value) {
        tell('empty save slot');
        menu.show('load');
        audio.pause(true);
        return;
      }
      session.load(value);
      demo = null;
      currentWorld = null;
      automap = false;
      automapReveal = 0;
      cheats.reset();
      failedRender = false;
      pendingWeapon = null;
      input.clear();
      touch.clear();
      audio.stopSounds();
      tell('game loaded');
      resume();
    } catch (error) {
      reportError(error);
    }
  };
  const newGame = (next: SessionOptions = {}): void => {
    ensureActive();
    session.newGame(next);
    demo = null;
    demoTic = 0;
    currentWorld = null;
    automap = false;
    automapReveal = 0;
    cheats.reset();
    failedRender = false;
    pendingWeapon = null;
    input.clear();
    touch.clear();
    audio.stopSounds();
    resume();
  };
  const handleMenu = (action: MenuAction | null): void => {
    if (!action) return;
    if (action.type === 'newGame') newGame({ episode: action.episode, skill: action.skill });
    else if (action.type === 'save') {
      save(action.slot);
      if (errorPanel.hidden) resume();
    } else if (action.type === 'load') load(action.slot);
    else if (action.type === 'volume') {
      if (action.channel === 'sfx') sfxVolume = action.value;
      else musicVolume = action.value;
      audio.setVolume(sfxVolume, musicVolume);
    } else if (action.type === 'close') resume();
    else {
      paused = true;
      tell('game paused');
    }
  };
  const fullscreen = async (): Promise<void> => {
    ensureActive();
    if (owner.fullscreenElement === root) await owner.exitFullscreen();
    else await root.requestFullscreen();
    stage.focus();
  };
  const handleAction = (action: InputAction): void => {
    if (menu.open) {
      handleMenu(menu.input(action));
      return;
    }
    if (action === 'menu') {
      openMenu();
      return;
    }
    if (action === 'pause') {
      paused = !paused;
      audio.pause(paused);
      resetClock();
    } else if (action === 'save') save();
    else if (action === 'load') load();
    else if (action === 'fullscreen') void fullscreen().catch(reportError);
    else if (action === 'automap') automap = !automap;
    else if (
      (action === 'previousWeapon' || action === 'nextWeapon') &&
      session.state.kind === 'level'
    ) {
      const player = session.state.world.player,
        direction = action === 'previousWeapon' ? -1 : 1;
      let weapon = pendingWeapon ?? player.readyWeapon;
      for (let attempt = 0; attempt < 8; attempt++) {
        weapon = (weapon + direction + 8) % 8;
        if (
          player.ownedWeapons[weapon] &&
          (session.state.world.mode !== 'shareware' || (weapon !== 5 && weapon !== 6))
        )
          break;
      }
      pendingWeapon = weapon;
    } else if (action === 'confirm' && session.state.kind !== 'level')
      session.advanceIntermission();
  };
  const click = (event: MouseEvent): void => {
    stage.focus();
    void audio.unlock().catch(reportError);
    if (menu.open) {
      const bounds = screen.getBoundingClientRect();
      handleMenu(
        menu.click(
          ((event.clientX - bounds.left) / bounds.width) * 320,
          ((event.clientY - bounds.top) / bounds.height) * 200,
        ),
      );
    } else if (
      !paused &&
      owner.pointerLockElement !== stage &&
      window.matchMedia('(pointer:fine)').matches
    ) {
      void stage.requestPointerLock()?.catch(() => {
        tell('click the game to capture your mouse');
      });
    }
  };
  stage.addEventListener('click', click);
  errorClose.addEventListener('click', (event) => {
    event.stopPropagation();
    openMenu();
  });
  const visibility = (): void => {
    if (owner.hidden) {
      paused = true;
      audio.pause(true);
      input.clear();
      touch.clear();
    }
    resetClock();
  };
  owner.addEventListener('visibilitychange', visibility);
  const blur = (): void => {
    paused = true;
    audio.pause(true);
    input.clear();
    touch.clear();
    resetClock();
  };
  window.addEventListener('blur', blur);
  const frame = (now: number): void => {
    if (disposed) return;
    if (!errorPanel.hidden) {
      frameId = window.requestAnimationFrame(frame);
      return;
    }
    try {
      fps += (1000 / Math.max(1, now - previousFrame) - fps) * 0.05;
      previousFrame = now;
      // rAF timestamps can predate setup or another callback in the same frame.
      // This clock uses a single monotonic performance.now() time domain.
      const steps = advanceClock(clock, performance.now()),
        simulationStart = performance.now();
      for (const action of input.actions()) handleAction(action);
      const characters = input.characters();
      if (session.state.kind === 'level' && !menu.open && !paused) {
        const world = session.state.world;
        for (const effect of cheats.feed(world, characters, automap)) {
          if (effect.type === 'message') tell(effect.text);
          else if (effect.type === 'automapReveal') automapReveal = effect.level;
          else if (effect.type === 'music') {
            if (findLump(wad, effect.name)) audio.setMusic(effect.name, effect.loop);
            else tell('IMPOSSIBLE SELECTION');
          } else
            newGame({
              episode: effect.episode,
              mapNumber: effect.mapNumber,
              skill: world.skill,
              mode: world.mode,
              fastMonsters: world.fastMonsters,
              respawnMonsters: world.respawnMonsters,
            });
        }
      }
      for (let tic = 0; tic < steps.ticks; tic++) {
        menuTick++;
        let command = input.command();
        for (const action of input.actions()) handleAction(action);
        if (menu.open || paused || !errorPanel.hidden) continue;
        if (touch.size !== 0)
          command = {
            forwardMove: (Number(touch.has('forward')) - Number(touch.has('back'))) * 25,
            sideMove: 0,
            angleTurn: (Number(touch.has('left')) - Number(touch.has('right'))) * 640,
            buttons:
              (touch.has('fire') ? TicButton.attack : 0) | (touch.has('use') ? TicButton.use : 0),
          };
        if (demo !== null) {
          const next = demo.tics[demoTic++]?.find((entry) => entry.player === 0)?.command;
          if (!next) {
            demo = null;
            openMenu();
            continue;
          }
          command = next;
        }
        if (pendingWeapon !== null) {
          command = {
            ...command,
            buttons:
              (command.buttons & ~56) | TicButton.changeWeapon | (pendingWeapon << WEAPON_SHIFT),
          };
          pendingWeapon = null;
        }
        session.tick(command);
        if (session.state.kind === 'level') {
          statusBar.tick(session.state.world);
          if (session.state.world.player.state !== 'alive') automap = false;
        }
      }
      const simulationMs = performance.now() - simulationStart;
      if (session.state.kind === 'level' && currentWorld !== session.state.world && !failedRender) {
        audio.stopSounds();
        renderer.setWorld(session.state.world);
        currentWorld = session.state.world;
        automapReveal = 0;
        cheats.reset();
      }
      for (const event of session.events.splice(0)) {
        if (event.type === 'music') audio.setMusic(event.name, event.loop);
        else if (event.type === 'message') tell(event.text);
        else if (event.type !== 'state')
          audio.handleEvents(
            [event],
            session.state.kind === 'level' ? scene(session.state.world) : soundScene(),
          );
      }
      const renderStart = performance.now();
      context.clearRect(0, 0, 320, 200);
      const state = session.state;
      if (failedRender && menu.open) {
        context.fillStyle = '#000';
        context.fillRect(0, 0, 320, 200);
      } else if (state.kind === 'level') {
        const world = state.world,
          actor = world.actorsById.get(world.player.actorId);
        if (!actor) throw new Error('Player actor is missing');
        renderer.render({
          x: actor.x / FRAC_UNIT,
          y: actor.y / FRAC_UNIT,
          z:
            (world.player.viewZ === 1 ? actor.z + world.player.viewHeight : world.player.viewZ) /
            FRAC_UNIT,
          angle: actor.angle,
        });
        if (automap) drawAutomap(context, world, resources, 1, automapReveal);
        statusBar.draw(context, world, paletteForPlayer(world.player));
        audio.update(scene(world));
      } else drawSessionScreen(context, state, resources, painter);
      if (paused && !menu.open) {
        painter.patch(context, 'M_PAUSE', (320 - resources.patch('M_PAUSE').width) / 2, 70);
      }
      if (now < messageUntil) painter.text(context, message, 2, 2);
      menu.draw(context, menuTick);
      const renderCpuMs = performance.now() - renderStart;
      if (now - lastStatus >= 500) {
        lastStatus = now;
        const stats = renderer.stats;
        options.onStatus?.({
          state: state.kind,
          level: state.kind === 'level' ? state.world.spatial.map.name : state.kind,
          paused: paused || menu.open,
          fps: Math.round(fps),
          drawCalls: stats?.drawCalls ?? 0,
          triangles:
            (stats?.wallTriangles ?? 0) +
            (stats?.flatTriangles ?? 0) +
            (stats?.spriteTriangles ?? 0) +
            (stats?.skyTriangles ?? 0) +
            (stats?.fuzzTriangles ?? 0) +
            (stats?.weaponTriangles ?? 0),
          simulationMs,
          renderCpuMs,
        });
      }
    } catch (error) {
      failedRender = true;
      reportError(error);
    }
    frameId = window.requestAnimationFrame(frame);
  };
  container.append(root);
  audio.pause(true);
  frameId = window.requestAnimationFrame(frame);
  return {
    newGame,
    playDemo(name = 'DEMO1'): void {
      ensureActive();
      const lump = findLump(wad, name);
      if (!lump) throw new Error(`Missing demo ${name}`);
      const next = decodeDemo(readLump(wad, lump));
      if (!next.header.playersActive[0] || next.header.playersActive.slice(1).some(Boolean))
        throw new Error('Only single-player demos can run');
      newGame({
        episode: next.header.episode,
        mapNumber: next.header.mapNumber,
        skill: next.header.skill,
        noMonsters: next.header.noMonsters,
        fastMonsters: next.header.fast,
        respawnMonsters: next.header.respawn,
      });
      demo = next;
    },
    pause(): void {
      ensureActive();
      paused = true;
      audio.pause(true);
      input.clear();
      touch.clear();
    },
    resume,
    openMenu,
    save,
    load,
    fullscreen,
    loadWad(nextBytes): void {
      ensureActive();
      const nextWad = parseWad(nextBytes),
        nextResources = createResources(nextWad),
        nextSession = createSession(nextWad, nextResources);
      const nextCanvas = owner.createElement('canvas');
      nextCanvas.className = 'doom-world';
      const nextRenderer = createWorldRenderer(nextCanvas, nextResources);
      try {
        nextRenderer.resize(resolution, Math.round((resolution * 168) / 320));
        if (nextSession.state.kind === 'level') nextRenderer.setWorld(nextSession.state.world);
      } catch (error) {
        nextRenderer.dispose();
        throw error;
      }
      const nextAudio = createGameAudio(nextWad, audioOptions);
      renderer.dispose();
      audio.dispose();
      painter.clear();
      wad = nextWad;
      resources = nextResources;
      session = nextSession;
      canvas.replaceWith(nextCanvas);
      canvas = nextCanvas;
      renderer = nextRenderer;
      audio = nextAudio;
      painter = createPatchPainter(resources, owner);
      statusBar = createStatusBar(painter);
      audio.setVolume(sfxVolume, musicVolume);
      menu = createGameMenu(painter, sessionOptionsMode, savedSlots);
      currentWorld = nextSession.state.kind === 'level' ? nextSession.state.world : null;
      demo = null;
      automap = false;
      automapReveal = 0;
      cheats.reset();
      failedRender = false;
      pendingWeapon = null;
      openMenu();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(frameId);
      input.dispose();
      audio.dispose();
      renderer.dispose();
      painter.clear();
      owner.removeEventListener('visibilitychange', visibility);
      stage.removeEventListener('click', click);
      window.removeEventListener('blur', blur);
      if (owner.pointerLockElement === stage) owner.exitPointerLock();
      root.remove();
    },
  };
}
