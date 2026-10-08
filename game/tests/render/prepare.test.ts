import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh } from 'three';
import type * as Three from 'three';
import type { Camera, Object3D, Texture, WebGLRenderTarget } from 'three';
import { createWorldRenderer } from '../../src/render/world';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';

const graphics = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof Three>();
  return { ...actual, WebGLRenderer: vi.fn(function () { return graphics.create(); }) };
});

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);
const world = () => createWorld(decodeMap(wad, 'E1M1'), { skill: 2 });

function backend() {
  let target: WebGLRenderTarget | null = null;
  const compiled: { camera: Camera; target: WebGLRenderTarget | null; materials: { name: string; instanced: boolean }[] }[] = [];
  const device = {
    info: { autoReset: true, render: { calls: 0 }, reset: vi.fn() },
    setPixelRatio: vi.fn(), setSize: vi.fn(), dispose: vi.fn(), render: vi.fn(),
    initTexture: vi.fn((_texture: Texture) => {}), initRenderTarget: vi.fn((_target: WebGLRenderTarget) => {}),
    getRenderTarget: () => target,
    setRenderTarget: (next: WebGLRenderTarget | null) => { target = next; },
    compileAsync: vi.fn(async (scene: Object3D, camera: Camera) => {
      const materials: { name: string; instanced: boolean }[] = [];
      scene.traverse(object => {
        if (!(object instanceof Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.push({ name: material.name, instanced: 'isInstancedMesh' in object });
        }
      });
      compiled.push({ camera, target, materials });
      return scene;
    }),
  };
  return { device, compiled };
}

beforeEach(() => graphics.create.mockReset());

describe('world renderer preparation', () => {
  it('uploads indexed textures and render targets and compiles every draw variant without rendering', async () => {
    const gpu = backend(); graphics.create.mockReturnValue(gpu.device);
    const renderer = createWorldRenderer({} as HTMLCanvasElement, resources);
    renderer.resize(640, 336); renderer.setWorld(world());
    await renderer.prepare();
    expect(gpu.device.render).not.toHaveBeenCalled();
    expect(gpu.device.initRenderTarget).toHaveBeenCalledTimes(2);
    expect(gpu.device.initRenderTarget.mock.calls.map(([target]) => [target.width, target.height])).toEqual([[640, 336], [640, 336]]);
    const textures = gpu.device.initTexture.mock.calls.map(([texture]) => texture);
    expect(new Set(textures).size).toBe(6); // Three atlas pages, palette, COLORMAP and fuzz pattern.
    const names = new Set<string>();
    let instancedFuzz = false, screenspaceFuzz = false;
    for (const pass of gpu.compiled) {
      for (const material of pass.materials) {
        names.add(material.name);
        if (material.name.startsWith('Doom native actor fuzz')) instancedFuzz ||= material.instanced;
        if (material.name.startsWith('Doom native weapon fuzz')) screenspaceFuzz ||= !material.instanced;
      }
    }
    for (let page = 0; page < 3; page++) {
      expect(names.has(`Doom indexed atlas ${page}`)).toBe(true);
      expect(names.has(`Doom indexed weapon atlas ${page}`)).toBe(true);
      expect(names.has(`Doom native actor fuzz ${page}`)).toBe(true);
      expect(names.has(`Doom native weapon fuzz ${page}`)).toBe(true);
      for (const instanced of [false, true]) {
        // A shared material has distinct batch/sprite programs. Each compile
        // must wait for only one variant before Three changes currentProgram.
        expect(gpu.compiled.some(pass => pass.materials.length === 1
          && pass.materials[0]?.name === `Doom indexed atlas ${page}`
          && pass.materials[0].instanced === instanced)).toBe(true);
      }
    }
    expect(names.has('Doom infinite sky')).toBe(true);
    expect(names.has('Doom sky opening mask')).toBe(true);
    expect(names.has('Doom frame copy')).toBe(true);
    expect(instancedFuzz).toBe(true); expect(screenspaceFuzz).toBe(true);
    expect(gpu.compiled.filter(pass => pass.target === null)).toHaveLength(1);
    expect(gpu.compiled.filter(pass => pass.target !== null).length).toBeGreaterThan(0);
    expect(gpu.device.getRenderTarget()).toBeNull();
    const allocations = [...textures, ...gpu.device.initRenderTarget.mock.calls.map(([target]) => target)];
    const released = allocations.map(allocation => {
      const listener = vi.fn(); allocation.addEventListener('dispose', listener); return listener;
    });
    renderer.dispose(); renderer.dispose();
    for (const listener of released) expect(listener).toHaveBeenCalledTimes(1);
    expect(gpu.device.dispose).toHaveBeenCalledTimes(1);
  });

  it('shares preparation for an unchanged world and initializes resized targets again', async () => {
    const gpu = backend(); graphics.create.mockReturnValue(gpu.device);
    const renderer = createWorldRenderer({} as HTMLCanvasElement, resources); renderer.setWorld(world());
    const first = renderer.prepare(), second = renderer.prepare();
    await Promise.all([first, second]);
    const compiled = gpu.device.compileAsync.mock.calls.length;
    await renderer.prepare();
    expect(gpu.device.compileAsync).toHaveBeenCalledTimes(compiled);
    renderer.resize(320, 168); await renderer.prepare();
    expect(gpu.device.initRenderTarget).toHaveBeenCalledTimes(4);
    renderer.dispose();
  });

  it.each(['replace', 'resize', 'dispose'] as const)('stops preparation after %s without touching the new renderer state', async change => {
    const gpu = backend(); graphics.create.mockReturnValue(gpu.device);
    let finish: (() => void) | undefined;
    gpu.device.compileAsync.mockImplementationOnce(scene => new Promise(resolve => { finish = () => resolve(scene); }));
    const renderer = createWorldRenderer({} as HTMLCanvasElement, resources); renderer.setWorld(world());
    const preparation = renderer.prepare(), rejected = expect(preparation).rejects.toThrow(/changed|disposed/i);
    if (change === 'replace') renderer.setWorld(world());
    else if (change === 'resize') renderer.resize(640, 336);
    else renderer.dispose();
    if (!finish) throw new Error('Shader compilation did not begin');
    finish(); await rejected;
    expect(gpu.device.compileAsync).toHaveBeenCalledTimes(1);
    expect(gpu.device.getRenderTarget()).toBeNull();
    if (change !== 'dispose') { await renderer.prepare(); renderer.dispose(); }
  });

  it('restores the render target on compilation failure and allows a retry', async () => {
    const gpu = backend(); graphics.create.mockReturnValue(gpu.device);
    gpu.device.compileAsync.mockImplementationOnce(() => { throw new Error('Shader compilation failed'); });
    const renderer = createWorldRenderer({} as HTMLCanvasElement, resources); renderer.setWorld(world());
    await expect(renderer.prepare()).rejects.toThrow('Shader compilation failed');
    expect(gpu.device.getRenderTarget()).toBeNull();
    await expect(renderer.prepare()).resolves.toBeUndefined();
    renderer.dispose();
  });

  it('requires an initialized, live world', async () => {
    const gpu = backend(); graphics.create.mockReturnValue(gpu.device);
    const renderer = createWorldRenderer({} as HTMLCanvasElement, resources);
    await expect(renderer.prepare()).rejects.toThrow(/world/i);
    renderer.dispose(); await expect(renderer.prepare()).rejects.toThrow(/disposed/i);
    expect(gpu.device.initTexture).not.toHaveBeenCalled();
  });
});
