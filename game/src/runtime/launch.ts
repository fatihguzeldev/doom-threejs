import type { MountOptions } from './browser';

export function playerOptions(search: string): MountOptions {
  const query = new URLSearchParams(search);
  const requested = Number(query.get('resolution'));
  return {
    input: { keyboardProfile: query.get('controls') === 'desktop' ? 'desktop' : 'buttons' },
    resolution: requested === 640 || requested === 960 ? requested : 320,
    screenMode: 'fullscreen',
    touchControls: !query.has('handheld') && query.get('touch') !== 'off',
    allowQuit: false,
  };
}
