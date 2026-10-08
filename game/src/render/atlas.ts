import type { IndexedImage } from '../wad/graphics';

export interface AtlasEntry {
  readonly key: string;
  readonly image: IndexedImage;
}

export interface AtlasRegion {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly leftOffset: number;
  readonly topOffset: number;
}

export interface AtlasPage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface IndexedAtlas {
  readonly pages: readonly AtlasPage[];
  readonly regions: ReadonlyMap<string, AtlasRegion>;
}

interface Source {
  key: string;
  readonly image: IndexedImage;
  readonly aliases: string[];
}

interface Shelf {
  readonly y: number;
  readonly height: number;
  nextX: number;
}

interface PageLayout {
  readonly shelves: Shelf[];
  nextY: number;
}

const PAGE_SIZE = 1024;
const MAX_PAGES = 32;
const GUTTER = 1;

function place(layouts: PageLayout[], image: IndexedImage): { page: number; x: number; y: number } {
  const width = image.width + GUTTER * 2, height = image.height + GUTTER * 2;
  for (const [page, layout] of layouts.entries()) {
    for (const shelf of layout.shelves) {
      if (height <= shelf.height && shelf.nextX + width <= PAGE_SIZE) {
        const x = shelf.nextX;
        shelf.nextX += width;
        return { page, x: x + GUTTER, y: shelf.y + GUTTER };
      }
    }
    if (layout.nextY + height <= PAGE_SIZE) {
      const y = layout.nextY;
      layout.shelves.push({ y, height, nextX: width });
      layout.nextY += height;
      return { page, x: GUTTER, y: y + GUTTER };
    }
  }
  if (layouts.length >= MAX_PAGES) throw new Error('Indexed atlas page allocation exceeds the 32-page limit');
  layouts.push({ shelves: [{ y: 0, height, nextX: width }], nextY: height });
  return { page: layouts.length - 1, x: GUTTER, y: GUTTER };
}

export function packIndexedAtlas(entries: readonly AtlasEntry[]): IndexedAtlas {
  const keys = new Set<string>();
  const sources = new Map<IndexedImage, Source>();
  for (const entry of entries) {
    if (entry.key.length === 0 || keys.has(entry.key)) throw new Error(`Invalid or duplicate atlas key ${entry.key}`);
    keys.add(entry.key);
    const { width, height, pixels, alpha } = entry.image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
        width + GUTTER * 2 > PAGE_SIZE || height + GUTTER * 2 > PAGE_SIZE) {
      throw new Error(`Atlas image ${entry.key} dimensions do not fit a 1024-square page with gutters`);
    }
    if (pixels.byteLength !== width * height || alpha.byteLength !== width * height) {
      throw new Error(`Atlas image ${entry.key} buffers do not match its dimensions`);
    }
    const existing = sources.get(entry.image);
    if (existing) {
      existing.aliases.push(entry.key);
      if (entry.key < existing.key) existing.key = entry.key;
    } else sources.set(entry.image, { key: entry.key, image: entry.image, aliases: [entry.key] });
  }
  const ordered = [...sources.values()].sort((first, second) =>
    second.image.height - first.image.height || second.image.width - first.image.width ||
    (first.key < second.key ? -1 : first.key > second.key ? 1 : 0));
  const layouts: PageLayout[] = [];
  const regions = new Map<string, AtlasRegion>();
  const placements: { readonly image: IndexedImage; readonly region: AtlasRegion }[] = [];
  for (const source of ordered) {
    const image = source.image;
    const region: AtlasRegion = {
      ...place(layouts, image), width: image.width, height: image.height,
      leftOffset: image.leftOffset, topOffset: image.topOffset,
    };
    for (const key of source.aliases) regions.set(key, region);
    placements.push({ image, region });
  }
  // Invalid dimensions or excessive page counts fail before GPU-sized allocations.
  const pages: AtlasPage[] = layouts.map(() => ({ width: PAGE_SIZE, height: PAGE_SIZE, pixels: new Uint8Array(PAGE_SIZE * PAGE_SIZE * 2) }));
  for (const { image, region } of placements) {
    const page = pages[region.page];
    if (!page) throw new Error('Atlas placement has no page');
    const pixels = new DataView(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength);
    const alpha = new DataView(image.alpha.buffer, image.alpha.byteOffset, image.alpha.byteLength);
    for (let y = -GUTTER; y < image.height + GUTTER; y++) {
      const sourceY = (y + image.height) % image.height;
      for (let x = -GUTTER; x < image.width + GUTTER; x++) {
        const source = sourceY * image.width + (x + image.width) % image.width;
        const target = ((region.y + y) * PAGE_SIZE + region.x + x) * 2;
        page.pixels[target] = pixels.getUint8(source);
        page.pixels[target + 1] = alpha.getUint8(source);
      }
    }
  }
  return { pages, regions };
}
