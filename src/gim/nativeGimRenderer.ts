import * as THREE from 'three';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { AppState } from '../app/state.js';
import { parseKeyValue } from './cbmParser.js';
import { fitCameraToScene } from '../viewer/camera.js';

const ROOT_NAME = 'GIM_NATIVE_ROOT';
const UNIT_SCALE = 0.001; // GIM MOD/PHM/DEV 坐标通常为 mm，Three 场景中按 m 显示。

interface NativeStats {
  devCount: number;
  phmCount: number;
  modCount: number;
  meshCount: number;
}

interface RenderContext {
  files: Map<string, File>;
  byLowerPath: Map<string, string>;
  root: THREE.Group;
  stats: NativeStats;
  visitingDev: Set<string>;
  visitingPhm: Set<string>;
}

export interface NativeGimRenderResult extends NativeStats {
  group: THREE.Group;
}

function buildPathIndex(files: Map<string, File>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of files.keys()) index.set(path.toLowerCase(), path);
  return index;
}

function normalizeRef(ref: string): string {
  return ref.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function resolveFilePath(ctx: RenderContext, ref: string, preferredDirs: string[]): string | null {
  const normalized = normalizeRef(ref);
  const candidates = [normalized];
  if (!normalized.includes('/')) {
    for (const dir of preferredDirs) candidates.push(`${dir}/${normalized}`);
  }
  for (const candidate of candidates) {
    const hit = ctx.byLowerPath.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  const fileName = normalized.split('/').pop()?.toLowerCase();
  if (!fileName) return null;
  for (const path of ctx.files.keys()) {
    if (path.split('/').pop()?.toLowerCase() === fileName) return path;
  }
  return null;
}

function parseNumbers(value = ''): number[] {
  return value.split(/[,;\s]+/).map((part) => Number(part.trim())).filter((num) => Number.isFinite(num));
}

function parseMatrix(value?: string): THREE.Matrix4 {
  const nums = parseNumbers(value || '');
  if (nums.length !== 16) return new THREE.Matrix4();
  return new THREE.Matrix4().set(
    nums[0], nums[1], nums[2], nums[3],
    nums[4], nums[5], nums[6], nums[7],
    nums[8], nums[9], nums[10], nums[11],
    nums[12], nums[13], nums[14], nums[15],
  );
}

function parseColor(el: Element | null, override?: string): THREE.Color {
  const overrideNums = parseNumbers(override || '');
  if (overrideNums.length >= 3) return new THREE.Color(overrideNums[0] / 255, overrideNums[1] / 255, overrideNums[2] / 255);
  if (!el) return new THREE.Color(0x8fa3b7);
  return new THREE.Color(
    Number(el.getAttribute('R') || 143) / 255,
    Number(el.getAttribute('G') || 163) / 255,
    Number(el.getAttribute('B') || 183) / 255,
  );
}

function parseOpacity(el: Element | null): number {
  if (!el) return 1;
  const a = Number(el.getAttribute('A') || 100);
  return Number.isFinite(a) ? THREE.MathUtils.clamp(a / 100, 0.05, 1) : 1;
}

function makeMaterial(color: THREE.Color, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.08,
    transparent: opacity < 0.999,
    opacity,
    side: THREE.DoubleSide,
  });
}

function createStretchedBody(el: Element): THREE.BufferGeometry {
  const points = (el.getAttribute('Array') || '')
    .split(';')
    .map((pair) => parseNumbers(pair))
    .filter((nums) => nums.length >= 2)
    .map(([x, y]) => new THREE.Vector2(x, y));
  if (points.length < 3) return new THREE.BoxGeometry(1, 1, 1);
  const length = Number(el.getAttribute('L') || 1);
  const shape = new THREE.Shape(points);
  return new THREE.ExtrudeGeometry(shape, { depth: Number.isFinite(length) ? length : 1, bevelEnabled: false });
}

function createPorcelainBushing(el: Element): THREE.BufferGeometry {
  const bottom = Number(el.getAttribute('R') || 20);
  const middle = Number(el.getAttribute('R1') || bottom * 1.25);
  const top = Number(el.getAttribute('R2') || bottom);
  const count = Math.max(1, Number(el.getAttribute('N') || 6));
  const height = Number(el.getAttribute('H') || 100);
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= count; i++) {
    const y = (height / count) * i;
    const t = i / count;
    const core = THREE.MathUtils.lerp(bottom, top, t);
    points.push(new THREE.Vector2(core, y));
    if (i < count) points.push(new THREE.Vector2(middle, y + height / count * 0.45));
  }
  return new THREE.LatheGeometry(points, 24);
}

function createGeometry(entity: Element): THREE.BufferGeometry | null {
  const cuboid = entity.querySelector('Cuboid');
  if (cuboid) return new THREE.BoxGeometry(Number(cuboid.getAttribute('L') || 1), Number(cuboid.getAttribute('H') || 1), Number(cuboid.getAttribute('W') || 1));
  const cylinder = entity.querySelector('Cylinder');
  if (cylinder) return new THREE.CylinderGeometry(Number(cylinder.getAttribute('R') || 1), Number(cylinder.getAttribute('R') || 1), Number(cylinder.getAttribute('H') || 1), 32);
  const porcelain = entity.querySelector('PorcelainBushing');
  if (porcelain) return createPorcelainBushing(porcelain);
  const stretched = entity.querySelector('StretchedBody');
  if (stretched) return createStretchedBody(stretched);
  return null;
}

async function renderMod(ctx: RenderContext, path: string, parent: THREE.Object3D, inheritedColor?: string): Promise<void> {
  const file = ctx.files.get(path);
  if (!file) return;
  const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
  const entities = Array.from(doc.querySelectorAll('Entity'));
  ctx.stats.modCount += 1;
  for (const entity of entities) {
    if ((entity.getAttribute('Visible') || 'True').toLowerCase() === 'false') continue;
    const geometry = createGeometry(entity);
    if (!geometry) continue;
    const colorEl = entity.querySelector('Color');
    const material = makeMaterial(parseColor(colorEl, inheritedColor), parseOpacity(colorEl));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${path}#${entity.getAttribute('ID') || ctx.stats.meshCount}`;
    mesh.applyMatrix4(parseMatrix(entity.querySelector('TransformMatrix')?.getAttribute('Value') || ''));
    parent.add(mesh);
    ctx.stats.meshCount += 1;
  }
}

async function renderPhm(ctx: RenderContext, path: string, parent: THREE.Object3D): Promise<void> {
  if (ctx.visitingPhm.has(path)) return;
  ctx.visitingPhm.add(path);
  const file = ctx.files.get(path);
  if (!file) return;
  const kv = parseKeyValue(await file.text());
  const count = Number(kv['SOLIDMODELS.NUM'] || 0);
  const group = new THREE.Group();
  group.name = path;
  parent.add(group);
  ctx.stats.phmCount += 1;
  for (let i = 0; i < count; i++) {
    const ref = kv[`SOLIDMODEL${i}`];
    if (!ref) continue;
    const childPath = resolveFilePath(ctx, ref, ['MOD', 'PHM']);
    if (!childPath) continue;
    const child = new THREE.Group();
    child.name = ref;
    child.applyMatrix4(parseMatrix(kv[`TRANSFORMMATRIX${i}`]));
    group.add(child);
    if (/\.mod$/i.test(childPath)) await renderMod(ctx, childPath, child, kv[`COLOR${i}`]);
    else if (/\.phm$/i.test(childPath)) await renderPhm(ctx, childPath, child);
  }
  ctx.visitingPhm.delete(path);
}

async function renderDev(ctx: RenderContext, path: string, parent: THREE.Object3D): Promise<void> {
  if (ctx.visitingDev.has(path)) return;
  ctx.visitingDev.add(path);
  const file = ctx.files.get(path);
  if (!file) return;
  const kv = parseKeyValue(await file.text());
  const group = new THREE.Group();
  group.name = kv.SYMBOLNAME || path;
  parent.add(group);
  ctx.stats.devCount += 1;

  const solidCount = Number(kv['SOLIDMODELS.NUM'] || 0);
  for (let i = 0; i < solidCount; i++) {
    const ref = kv[`SOLIDMODEL${i}`];
    if (!ref) continue;
    const phmPath = resolveFilePath(ctx, ref, ['PHM', 'MOD']);
    if (!phmPath) continue;
    const child = new THREE.Group();
    child.name = ref;
    child.applyMatrix4(parseMatrix(kv[`TRANSFORMMATRIX${i}`]));
    group.add(child);
    if (/\.phm$/i.test(phmPath)) await renderPhm(ctx, phmPath, child);
    else if (/\.mod$/i.test(phmPath)) await renderMod(ctx, phmPath, child);
  }

  const subCount = Number(kv['SUBDEVICES.NUM'] || 0);
  for (let i = 0; i < subCount; i++) {
    const ref = kv[`SUBDEVICES${i}`] || kv[`SUBDEVICE${i}`];
    if (!ref) continue;
    const devPath = resolveFilePath(ctx, ref, ['DEV']);
    if (devPath) await renderDev(ctx, devPath, group);
  }
  ctx.visitingDev.delete(path);
}

function listFiles(files: Map<string, File>, ext: string): string[] {
  return Array.from(files.keys()).filter((path) => path.toLowerCase().endsWith(ext));
}

export function removePreviousNativeRoot(ctx: ViewerContext): void {
  const scene = (ctx.world.scene as any).three as THREE.Scene;
  const previous = scene.getObjectByName(ROOT_NAME);
  if (!previous) return;
  previous.removeFromParent();
  previous.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) material.dispose();
    }
  });
}

export async function renderNativeGimModel(ctx: ViewerContext, state: AppState, files: Map<string, File>): Promise<NativeGimRenderResult | null> {
  removePreviousNativeRoot(ctx);
  const root = new THREE.Group();
  root.name = ROOT_NAME;
  root.scale.setScalar(UNIT_SCALE);

  const renderCtx: RenderContext = {
    files,
    byLowerPath: buildPathIndex(files),
    root,
    stats: { devCount: 0, phmCount: 0, modCount: 0, meshCount: 0 },
    visitingDev: new Set<string>(),
    visitingPhm: new Set<string>(),
  };

  const devFiles = listFiles(files, '.dev');
  const phmFiles = listFiles(files, '.phm');
  const modFiles = listFiles(files, '.mod');

  if (devFiles.length > 0) {
    for (const path of devFiles) await renderDev(renderCtx, path, root);
  } else if (phmFiles.length > 0) {
    for (const path of phmFiles) await renderPhm(renderCtx, path, root);
  } else {
    let offset = 0;
    for (const path of modFiles) {
      const group = new THREE.Group();
      group.position.x = offset;
      root.add(group);
      await renderMod(renderCtx, path, group);
      offset += 2000;
    }
  }

  if (renderCtx.stats.meshCount === 0) return null;
  ((ctx.world.scene as any).three as THREE.Scene).add(root);
  state.hasFittedCamera = false;
  fitCameraToScene(ctx, state);
  return { group: root, ...renderCtx.stats };
}
