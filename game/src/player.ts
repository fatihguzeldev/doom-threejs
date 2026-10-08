import { mountDoom } from './runtime/browser';
import { playerOptions } from './runtime/launch';

const container = document.querySelector<HTMLElement>('#game');
const status = document.querySelector<HTMLElement>('#loading');
if (!container || !status) throw new Error('Missing player surface');

void mountDoom(container, playerOptions(location.search)).then(game => {
  status.remove();
  const restore = (event: PageTransitionEvent): void => {
    if (event.persisted) game.openMenu();
  };
  const leave = (event: PageTransitionEvent): void => {
    if (event.persisted) game.pause();
    else {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
      game.dispose();
    }
  };
  window.addEventListener('pagehide', leave);
  window.addEventListener('pageshow', restore);
}).catch(error => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
