import type { DoomResources } from '../wad/resources';
import type { IndexedImage } from '../wad/graphics';
import { PowerType, type Player } from '../simulation/player';

export function paletteForPlayer(player: Player): number {
  const strength = player.powers[PowerType.pw_strength] ?? 0;
  const damage = Math.max(player.damageCount, strength ? 12 - (strength >> 6) : 0);
  if (damage > 0) return 1 + Math.min(7, (damage + 7) >> 3);
  if (player.bonusCount > 0) return 9 + Math.min(3, (player.bonusCount + 7) >> 3);
  const radiation = player.powers[PowerType.pw_ironfeet] ?? 0;
  return radiation > 128 || (radiation & 8) !== 0 ? 13 : 0;
}

export interface PatchPainter {
  image(name: string, palette?: number, colormap?: number): HTMLCanvasElement;
  indexed(image: IndexedImage, palette?: number, colormap?: number): HTMLCanvasElement;
  patch(context: CanvasRenderingContext2D, name: string, x: number, y: number, palette?: number): void;
  text(context: CanvasRenderingContext2D, text: string, x: number, y: number, palette?: number): void;
  textWidth(text: string): number;
  clear(): void;
}

export function createPatchPainter(resources: DoomResources, owner: Document): PatchPainter {
  const cache = new Map<IndexedImage, Map<number, HTMLCanvasElement>>();
  const indexed = (image: IndexedImage, palette = 0, colormap = 0): HTMLCanvasElement => {
    if (!Number.isInteger(palette) || palette < 0 || palette > 13 || !Number.isInteger(colormap) || colormap < 0 || colormap > 33) {
      throw new Error('Invalid patch palette or colormap');
    }
    let variants = cache.get(image);
    if (!variants) { variants = new Map(); cache.set(image, variants); }
    const key = palette * 34 + colormap;
    const existing = variants.get(key);
    if (existing) return existing;
    const canvas = owner.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    const rgba = context.createImageData(image.width, image.height);
    for (let pixel = 0; pixel < image.pixels.length; pixel++) {
      const color = resources.colormaps[colormap * 256 + (image.pixels[pixel] ?? 0)] ?? 0;
      const offset = palette * 768 + color * 3;
      rgba.data[pixel * 4] = resources.palettes[offset] ?? 0;
      rgba.data[pixel * 4 + 1] = resources.palettes[offset + 1] ?? 0;
      rgba.data[pixel * 4 + 2] = resources.palettes[offset + 2] ?? 0;
      rgba.data[pixel * 4 + 3] = image.alpha[pixel] ?? 0;
    }
    context.putImageData(rgba, 0, 0);
    // HUD variants are small, but cycling palettes must not retain an unbounded
    // collection of weapon canvases across a long game.
    if (variants.size >= 16) { const oldest = variants.keys().next().value; if (oldest !== undefined) variants.delete(oldest); }
    variants.set(key, canvas);
    return canvas;
  };
  const glyph = (character: string): IndexedImage | null => {
    const code = character.toUpperCase().charCodeAt(0);
    return code >= 33 && code <= 95 ? resources.patch(`STCFN${code.toString().padStart(3, '0')}`) : null;
  };
  return {
    image: (name, palette = 0, colormap = 0) => indexed(resources.patch(name), palette, colormap), indexed,
    patch(context, name, x, y, palette = 0): void {
      const patch = resources.patch(name);
      context.drawImage(indexed(patch, palette), x - patch.leftOffset, y - patch.topOffset);
    },
    text(context, text, x, y, palette = 0): void {
      const origin = x;
      for (const character of text) {
        if (character === '\n') { x = origin; y += 12; continue; }
        const image = glyph(character);
        if (!image) { x += 4; continue; }
        if (x + image.width > 320) { x = origin; y += 12; }
        context.drawImage(indexed(image, palette), x, y); x += image.width;
      }
    },
    textWidth(text): number { return [...text].reduce((width, character) => width + (glyph(character)?.width ?? 4), 0); },
    clear(): void { cache.clear(); },
  };
}
