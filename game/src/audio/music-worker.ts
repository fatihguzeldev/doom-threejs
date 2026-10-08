import { createMusicRenderer } from './music';
import type { MusicRenderer } from './music';

export type MusicRequest =
  | { readonly type: 'load'; readonly id: number; readonly mus: Uint8Array;
    readonly genMidi: Uint8Array; readonly loop: boolean }
  | { readonly type: 'render'; readonly id: number; readonly frames: number }
  | { readonly type: 'stop'; readonly id: number };

export type MusicResponse =
  | { readonly type: 'loaded'; readonly id: number }
  | { readonly type: 'chunk'; readonly id: number; readonly samples: Float32Array<ArrayBuffer>;
    readonly ended: boolean }
  | { readonly type: 'error'; readonly id: number; readonly message: string };

// Keep synthesis off the simulation/render thread; only requested chunks exist.
// DOM and worker globals share postMessage/onmessage, without requiring a second
// tsconfig or exposing WebWorker's conflicting global type declarations.
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MusicRequest>) => void) | null;
  postMessage(message: MusicResponse, transfer?: Transferable[]): void;
};
let renderer: MusicRenderer | null = null;
let currentId = -1;
workerScope.onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      currentId = data.id;
      renderer = createMusicRenderer(data.mus, data.genMidi, data.loop);
      workerScope.postMessage({ type: 'loaded', id: data.id });
    } else if (data.type === 'stop') {
      currentId = data.id;
      renderer = null;
    } else if (data.id === currentId && renderer) {
      const chunk = renderer.render(data.frames);
      workerScope.postMessage({ type: 'chunk', id: data.id, ...chunk }, [chunk.samples.buffer]);
    }
  } catch (error: unknown) {
    renderer = null;
    workerScope.postMessage({ type: 'error', id: data.id,
      message: error instanceof Error ? error.message : String(error) });
  }
};
