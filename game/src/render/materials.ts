import {
  DataTexture, NearestFilter, NoColorSpace, RedFormat, RGFormat, RGBAFormat,
  ShaderMaterial, UnsignedByteType, Vector2,
} from 'three';
import { PowerType } from '../simulation/player';
import type { Player } from '../simulation/player';
import type { DoomResources } from '../wad/resources';
import type { IndexedAtlas } from './atlas';

export interface NativeUniforms {
  readonly uPaletteIndex: { value: number };
  readonly uFixedColormap: { value: number };
  readonly uExtraLight: { value: number };
  readonly uViewWidth: { value: number };
  readonly uProjectionScale: { value: number };
  readonly uPalette: { value: DataTexture };
  readonly uColormap: { value: DataTexture };
}

export interface NativeMaterials {
  readonly pages: readonly ShaderMaterial[];
  readonly atlasTextures: readonly DataTexture[];
  readonly paletteTexture: DataTexture;
  readonly colormapTexture: DataTexture;
  readonly uniforms: NativeUniforms;
  updatePlayer(player: Player): void;
  setView(width: number, projectionScale?: number): void;
  dispose(): void;
}

const vertexShader = `
attribute vec4 atlasRect;
attribute float lightLevel;
attribute float lightOffset;
attribute float fullbright;
attribute float flatSurface;
attribute float repeatTexture;
attribute float spriteSurface;
attribute float spriteFlip;
varying vec2 vTexel;
varying vec4 vAtlasRect;
varying float vLightLevel;
varying float vLightOffset;
varying float vFullbright;
varying float vFlatSurface;
varying float vRepeatTexture;
varying float vDepth;
void main() {
  vec4 localPosition = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    localPosition = instanceMatrix * localPosition;
  #endif
  vec4 viewPosition = modelViewMatrix * localPosition;
  vTexel = mix(uv, uv * atlasRect.zw, step(0.5, spriteSurface));
  if (spriteFlip > 0.5) vTexel.x = atlasRect.z - vTexel.x;
  vAtlasRect = atlasRect;
  vLightLevel = lightLevel;
  vLightOffset = lightOffset;
  vFullbright = fullbright;
  vFlatSurface = flatSurface;
  vRepeatTexture = repeatTexture;
  vDepth = -viewPosition.z;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const fragmentShader = `
uniform sampler2D uAtlas;
uniform sampler2D uPalette;
uniform sampler2D uColormap;
uniform vec2 uAtlasSize;
uniform float uPaletteIndex;
uniform float uFixedColormap;
uniform float uExtraLight;
uniform float uViewWidth;
uniform float uProjectionScale;
uniform float uWeaponSurface;
varying vec2 vTexel;
varying vec4 vAtlasRect;
varying float vLightLevel;
varying float vLightOffset;
varying float vFullbright;
varying float vFlatSurface;
varying float vRepeatTexture;
varying float vDepth;
void main() {
  vec2 size = vAtlasRect.zw;
  vec2 wrapped = fract(vTexel / size) * size;
  vec2 clipped = clamp(vTexel, vec2(0.0), size - vec2(0.001));
  vec2 localTexel = mix(clipped, wrapped, step(0.5, vRepeatTexture));
  vec2 atlasUV = (vAtlasRect.xy + floor(localTexel) + vec2(0.5)) / uAtlasSize;
  vec2 indexed = texture2D(uAtlas, atlasUV).rg;
  if (indexed.g < 0.5) discard;

  // Native r_main.c light tables use discrete COLORMAP rows, never RGB darkening.
  float bucket = clamp(floor(vLightLevel / 16.0) + vLightOffset + uExtraLight, 0.0, 15.0);
  float startMap = (15.0 - bucket) * 4.0;
  float depth = max(vDepth, 0.001);
  float scaleIndex = mix(min(47.0, floor(uProjectionScale * 16.0 / depth)), 47.0, step(0.5, uWeaponSurface));
  float wallMap = startMap - floor(scaleIndex * 160.0 / uViewWidth);
  float zIndex = min(127.0, floor(depth / 16.0));
  float flatMap = startMap - floor(floor(160.0 / (zIndex + 1.0)) / 2.0);
  float row = clamp(mix(wallMap, flatMap, step(0.5, vFlatSurface)), 0.0, 31.0);
  if (vFullbright > 0.5) row = 0.0;
  if (uFixedColormap > 0.0) row = clamp(uFixedColormap, 0.0, 33.0);

  float paletteIndex = floor(indexed.r * 255.0 + 0.5);
  float mapped = texture2D(uColormap, vec2((paletteIndex + 0.5) / 256.0, (row + 0.5) / 34.0)).r;
  float colorIndex = floor(mapped * 255.0 + 0.5);
  vec3 color = texture2D(uPalette, vec2((colorIndex + 0.5) / 256.0, (uPaletteIndex + 0.5) / 14.0)).rgb;
  // Offscreen alpha retains the post-COLORMAP palette index for native fuzz lookup.
  gl_FragColor = vec4(color, colorIndex / 255.0);
}
`;

function indexedTexture(bytes: Uint8Array, width: number, height: number, format: typeof RGFormat | typeof RGBAFormat | typeof RedFormat): DataTexture {
  const texture = new DataTexture(bytes, width, height, format, UnsignedByteType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function playerPalette(player: Player): number {
  const strength = player.powers[PowerType.pw_strength] ?? 0;
  const damage = Math.max(player.damageCount, strength !== 0 ? 12 - (strength >> 6) : 0);
  if (damage > 0) return 1 + Math.min(7, (damage + 7) >> 3);
  if (player.bonusCount > 0) return 9 + Math.min(3, (player.bonusCount + 7) >> 3);
  const radiation = player.powers[PowerType.pw_ironfeet] ?? 0;
  return radiation > 4 * 32 || (radiation & 8) !== 0 ? 13 : 0;
}

export function createNativeMaterials(atlas: IndexedAtlas, resources: Pick<DoomResources, 'palettes' | 'colormaps'>): NativeMaterials {
  const atlasTextures = atlas.pages.map(page => indexedTexture(page.pixels, page.width, page.height, RGFormat));
  // WebGL2 immutable storage requires a sized format. Three chooses RGBA8 for
  // these bytes; RGBFormat otherwise falls through to invalid unsized GL_RGB.
  const rgbaPalettes = new Uint8Array(14 * 256 * 4);
  for (let color = 0; color < 14 * 256; color++) {
    rgbaPalettes[color * 4] = resources.palettes[color * 3] ?? 0;
    rgbaPalettes[color * 4 + 1] = resources.palettes[color * 3 + 1] ?? 0;
    rgbaPalettes[color * 4 + 2] = resources.palettes[color * 3 + 2] ?? 0;
    rgbaPalettes[color * 4 + 3] = 255;
  }
  const paletteTexture = indexedTexture(rgbaPalettes, 256, 14, RGBAFormat);
  const colormapTexture = indexedTexture(resources.colormaps, 256, 34, RedFormat);
  const uniforms: NativeUniforms = {
    uPaletteIndex: { value: 0 }, uFixedColormap: { value: 0 }, uExtraLight: { value: 0 },
    uViewWidth: { value: 320 }, uProjectionScale: { value: 160 },
    uPalette: { value: paletteTexture }, uColormap: { value: colormapTexture },
  };
  const pages = atlasTextures.map((texture, index) => {
    const page = atlas.pages[index];
    if (!page) throw new Error('Native material has no atlas page');
    const material = new ShaderMaterial({
      name: `Doom indexed atlas ${index}`,
      uniforms: { ...uniforms, uAtlas: { value: texture }, uAtlasSize: { value: new Vector2(page.width, page.height) }, uWeaponSurface: { value: 0 } },
      vertexShader, fragmentShader, toneMapped: false,
    });
    // Three supports defaults for custom attributes; its declaration lists only built-ins.
    Object.assign(material.defaultAttributeValues, { lightLevel: [255], lightOffset: [0], fullbright: [0], flatSurface: [0], repeatTexture: [0], spriteSurface: [0], spriteFlip: [0] });
    return material;
  });
  let disposed = false;
  return {
    pages, atlasTextures, paletteTexture, colormapTexture, uniforms,
    updatePlayer(player): void {
      if (disposed) throw new Error('Native materials are disposed');
      uniforms.uPaletteIndex.value = playerPalette(player);
      uniforms.uFixedColormap.value = player.fixedColormap;
      uniforms.uExtraLight.value = player.extraLight;
    },
    setView(width, projectionScale = width / 2): void {
      if (disposed) throw new Error('Native materials are disposed');
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(projectionScale) || projectionScale <= 0) throw new Error('Invalid native material view dimensions');
      uniforms.uViewWidth.value = width;
      uniforms.uProjectionScale.value = projectionScale;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const material of pages) material.dispose();
      for (const texture of atlasTextures) texture.dispose();
      paletteTexture.dispose();
      colormapTexture.dispose();
    },
  };
}
