import { mountDoom, type DoomGame } from '@doom-threejs/game';

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof type)) throw new Error(`Missing playground element ${selector}`);
  return value;
}

const surface = element('#game', HTMLDivElement);
const loadingPanel = element('#loading', HTMLDivElement);
const loadingText = element('#loading-text', HTMLParagraphElement);
const retry = element('#retry', HTMLButtonElement);
const play = element('#play', HTMLButtonElement);
const playLabel = element('#play-label', HTMLSpanElement);
const demo = element('#demo', HTMLButtonElement);
const fullscreen = element('#fullscreen', HTMLButtonElement);
const menu = element('#menu', HTMLButtonElement);
const chooseWad = element('#choose-wad', HTMLButtonElement);
const wadFile = element('#wad-file', HTMLInputElement);
const wadName = element('#wad-name', HTMLParagraphElement);
const level = element('#level', HTMLSpanElement);
const performance = element('#performance', HTMLSpanElement);
const notice = element('#notice', HTMLParagraphElement);
const controls = document.querySelectorAll<HTMLButtonElement>('[data-game-control]');
let game: DoomGame | null = null;
let mounting = false,
  loadingFile = false,
  closed = false;

function updateControls(): void {
  const disabled = game === null || mounting || loadingFile;
  for (const button of controls) button.disabled = disabled;
  wadFile.disabled = disabled;
}

function report(value: unknown): void {
  if (closed) return;
  const text = value instanceof Error ? value.message : String(value);
  notice.textContent = text.toLowerCase();
  notice.hidden = false;
}

function run(action: (game: DoomGame) => void | Promise<void>): void {
  if (!game || loadingFile) return;
  notice.hidden = true;
  try {
    void Promise.resolve(action(game)).catch(report);
  } catch (error) {
    report(error);
  }
}

function setPlayLabel(started: boolean): void {
  playLabel.textContent = started ? 'restart' : 'play';
}

async function start(): Promise<void> {
  if (game || mounting || closed) return;
  mounting = true;
  updateControls();
  notice.hidden = true;
  loadingPanel.hidden = false;
  retry.hidden = true;
  loadingText.textContent = 'loading doom.';
  surface.setAttribute('aria-busy', 'true');
  try {
    const mounted = await mountDoom(surface, {
      resolution: 640,
      onStatus(status) {
        level.textContent = status.level.toLowerCase();
        performance.textContent = `${status.fps} fps${status.paused ? ' / paused' : ''}`;
      },
      onError: report,
    });
    if (closed) {
      mounted.dispose();
      return;
    }
    game = mounted;
    loadingPanel.hidden = true;
    performance.textContent = 'ready';
  } catch (error) {
    report(error);
    loadingText.textContent = 'could not start doom.';
    retry.hidden = false;
    performance.textContent = 'unavailable';
  } finally {
    mounting = false;
    surface.setAttribute('aria-busy', 'false');
    updateControls();
  }
}

play.addEventListener('click', () =>
  run((active) => {
    active.newGame();
    setPlayLabel(true);
  }),
);
demo.addEventListener('click', () =>
  run((active) => {
    active.playDemo();
    setPlayLabel(true);
  }),
);
fullscreen.addEventListener('click', () => run((active) => active.fullscreen()));
menu.addEventListener('click', () => run((active) => active.openMenu()));
retry.addEventListener('click', () => {
  void start();
});
chooseWad.addEventListener('click', () =>
  run((active) => {
    active.pause();
    wadFile.click();
  }),
);
wadFile.addEventListener('cancel', () => run((active) => active.openMenu()));
wadFile.addEventListener('change', () => {
  const file = wadFile.files?.[0];
  wadFile.value = '';
  if (!file) {
    run((active) => active.openMenu());
    return;
  }
  if (!game || loadingFile) return;
  const active = game;
  loadingFile = true;
  updateControls();
  notice.hidden = true;
  wadName.textContent = 'reading your wad.';
  void (async () => {
    try {
      if (!/\.wad$/i.test(file.name)) throw new Error('choose a .wad file.');
      if (file.size > 64 * 1024 * 1024) throw new Error('choose a doom wad below 64 mb.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (closed || game !== active) return;
      active.loadWad(bytes);
      setPlayLabel(false);
      wadName.textContent = `${file.name.toLowerCase()} / local file`;
    } catch (error) {
      report(error);
      wadName.textContent = 'your current wad is still loaded.';
      if (!closed && game === active) active.openMenu();
    } finally {
      loadingFile = false;
      updateControls();
    }
  })();
});

window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    game?.pause();
    return;
  }
  closed = true;
  game?.dispose();
  game = null;
});
void start();
