import {
  AlwaysStencilFunc, BufferAttribute, BufferGeometry, Camera, EqualStencilFunc,
  Mesh, ReplaceStencilOp, Scene, ShaderMaterial, Vector2,
} from 'three';
import { angleToRadians } from '../simulation/angle';
import type { IndexedAtlas } from './atlas';
import type { NativeMaterials } from './materials';

export interface SkyPass {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly maskMaterial: ShaderMaterial;
  setView(width: number, height: number, angle: number, projectionScale: number): void;
  dispose(): void;
}

export function createSkyPass(atlas: IndexedAtlas, materials: NativeMaterials, episode: number): SkyPass {
  const region = atlas.regions.get(`wall:SKY${episode}`);
  if (!region) throw new Error(`Missing native sky texture SKY${episode}`);
  const texture = materials.atlasTextures[region.page];
  const page = atlas.pages[region.page];
  if (!texture || !page) throw new Error('Sky atlas page missing');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  const uniforms = {
    uAtlas: { value: texture }, uAtlasSize: { value: new Vector2(page.width, page.height) },
    uRect: { value: [region.x, region.y, region.width, region.height] },
    uResolution: { value: new Vector2(320, 200) }, uAngle: { value: 0 }, uProjectionScale: { value: 160 },
    uPalette: materials.uniforms.uPalette, uColormap: materials.uniforms.uColormap, uPaletteIndex: materials.uniforms.uPaletteIndex,
  };
  const material = new ShaderMaterial({
    name: 'Doom infinite sky', uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: EqualStencilFunc,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: `
uniform sampler2D uAtlas;
uniform sampler2D uPalette;
uniform sampler2D uColormap;
uniform vec2 uAtlasSize;
uniform vec4 uRect;
uniform vec2 uResolution;
uniform float uAngle;
uniform float uProjectionScale;
uniform float uPaletteIndex;
void main() {
  float offset = atan((uResolution.x * 0.5 - gl_FragCoord.x) / uProjectionScale);
  // ANGLETOSKYSHIFT=22: 1024 columns per turn; a SKY256 repeats four times.
  float column = floor((uAngle + offset) * (1024.0 / 6.283185307179586));
  float screenY = uResolution.y - gl_FragCoord.y;
  float row = floor(100.0 + (screenY - uResolution.y * 0.5) * 320.0 / uResolution.x);
  vec2 texel = mod(vec2(column, row), uRect.zw);
  float index = floor(texture2D(uAtlas, (uRect.xy + texel + vec2(0.5)) / uAtlasSize).r * 255.0 + 0.5);
  // Native sky always uses row zero, including during inverse invulnerability.
  float mapped = floor(texture2D(uColormap, vec2((index + 0.5) / 256.0, 0.5 / 34.0)).r * 255.0 + 0.5);
  vec3 color = texture2D(uPalette, vec2((mapped + 0.5) / 256.0, (uPaletteIndex + 0.5) / 14.0)).rgb;
  gl_FragColor = vec4(color, mapped / 255.0);
}
`,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  const maskMaterial = new ShaderMaterial({
    name: 'Doom sky opening mask', colorWrite: false, depthTest: true, depthWrite: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: AlwaysStencilFunc, stencilZPass: ReplaceStencilOp,
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
  });
  let disposed = false;
  return {
    scene, camera: new Camera(), maskMaterial,
    setView(width, height, angle, projectionScale): void {
      uniforms.uResolution.value.set(width, height);
      uniforms.uAngle.value = angleToRadians(angle);
      uniforms.uProjectionScale.value = projectionScale;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      geometry.dispose(); material.dispose(); maskMaterial.dispose();
    },
  };
}
