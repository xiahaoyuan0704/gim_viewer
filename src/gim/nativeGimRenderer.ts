import * as THREE from 'three';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { AppState } from '../app/state.js';
import { parseKeyValue } from './cbmParser.js';
import { fitCameraToScene } from '../viewer/camera.js';

const ROOT_NAME = 'GIM_NATIVE_ROOT';
const UNIT_SCALE = 0.001; // GIM MOD/PHM/DEV 坐标通常为 mm，Three 场景中按 m 显示。

interface NativeStats {
  cbmCount: number;
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


function parseKeyValueLines(text: string): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    result.push({ key: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() });
  }
  return result;
}

interface OrderedRef {
  ref: string;
  matrix?: string;
  color?: string;
}

function parseOrderedRefs(text: string, sectionKey: string, refPattern: RegExp, tupleSize: 2 | 3): OrderedRef[] {
  const lines = parseKeyValueLines(text);
  const start = lines.findIndex((line) => line.key.toUpperCase() === sectionKey.toUpperCase());
  if (start < 0) return [];
  const count = Number(lines[start].value || 0);
  if (!Number.isFinite(count) || count <= 0) return [];
  const refs: OrderedRef[] = [];
  let cursor = start + 1;
  for (let i = 0; i < count && cursor < lines.length; i++) {
    const refLine = lines[cursor++];
    if (!refLine || !refPattern.test(refLine.key)) break;
    const item: OrderedRef = { ref: refLine.value };
    for (let step = 1; step < tupleSize && cursor < lines.length; step++) {
      const line = lines[cursor++];
      if (/^TRANSFORMMATRIX/i.test(line.key)) item.matrix = line.value;
      else if (/^COLOR/i.test(line.key)) item.color = line.value;
    }
    refs.push(item);
  }
  return refs;
}

function parseIndexedRefs(kv: Record<string, string>, sectionKey: string, refKey: string, includeColor = false): OrderedRef[] {
  const count = Number(kv[sectionKey] || 0);
  if (!Number.isFinite(count) || count <= 0) return [];
  const refs: OrderedRef[] = [];
  for (let i = 0; i < count; i++) {
    const ref = kv[`${refKey}${i}`] || kv[`${refKey}S${i}`];
    if (!ref) continue;
    refs.push({ ref, matrix: kv[`TRANSFORMMATRIX${i}`], color: includeColor ? kv[`COLOR${i}`] : undefined });
  }
  return refs;
}

function parseMatrix(value?: string): THREE.Matrix4 {
  const nums = parseNumbers(value || '');
  if (nums.length !== 16) return new THREE.Matrix4();

  // GIM 工具链里常见的矩阵写法与 Unity Matrix4x4 构造保持一致：
  // 16 个数字按“列向量”传入，平移位于 12/13/14。也兼容部分文档/样例里的行优先 3/7/11 平移。
  const hasColumnTranslation = Math.abs(nums[12]) + Math.abs(nums[13]) + Math.abs(nums[14]) > 1e-8;
  const hasRowTranslation = Math.abs(nums[3]) + Math.abs(nums[7]) + Math.abs(nums[11]) > 1e-8;
  if (hasColumnTranslation || !hasRowTranslation) {
    return new THREE.Matrix4().set(
      nums[0], nums[4], nums[8], nums[12],
      nums[1], nums[5], nums[9], nums[13],
      nums[2], nums[6], nums[10], nums[14],
      nums[3], nums[7], nums[11], nums[15],
    );
  }
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

function makeZAxisCylinder(radiusTop: number, radiusBottom: number, height: number, segments = 32): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, height / 2);
  return geometry;
}

function makeZAxisBox(length: number, width: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(length, width, height);
  geometry.translate(0, 0, height / 2);
  return geometry;
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
  const geometry = new THREE.LatheGeometry(points, 24);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}


function getNumericAttr(el: Element, names: string[], fallback = 0): number {
  for (const name of names) {
    const value = Number(el.getAttribute(name));
    if (Number.isFinite(value) && value !== 0) return value;
  }
  return fallback;
}

function createFallbackGeometry(el: Element): THREE.BufferGeometry | null {
  const radius = getNumericAttr(el, ['R', 'Radius', 'BR', 'TR', 'DR'], 0);
  const height = getNumericAttr(el, ['H', 'L', 'Length', 'FL'], 0);
  if (radius > 0 && height > 0) return makeZAxisCylinder(radius, radius, height);

  const length = getNumericAttr(el, ['L', 'Length', 'FL', 'AL'], 0);
  const width = getNumericAttr(el, ['W', 'Width', 'BL'], 0);
  const thickness = getNumericAttr(el, ['T', 'H', 'Thickness'], 0);
  if (length > 0 || width > 0 || thickness > 0) {
    return makeZAxisBox(Math.max(length, 1), Math.max(width || thickness, 1), Math.max(thickness || width, 1));
  }

  const numericAttrs = Array.from(el.attributes).map((attr) => Number(attr.value)).filter((value) => Number.isFinite(value) && value > 0);
  if (numericAttrs.length === 0) return null;
  const size = Math.max(...numericAttrs, 1);
  return makeZAxisBox(size, size, size);
}

function createGeometry(entity: Element): THREE.BufferGeometry | null {
  const cuboid = entity.querySelector('Cuboid');
  if (cuboid) return makeZAxisBox(Number(cuboid.getAttribute('L') || 1), Number(cuboid.getAttribute('W') || 1), Number(cuboid.getAttribute('H') || 1));
  const cylinder = entity.querySelector('Cylinder');
  if (cylinder) return makeZAxisCylinder(Number(cylinder.getAttribute('R') || 1), Number(cylinder.getAttribute('R') || 1), Number(cylinder.getAttribute('H') || 1));
  const truncatedCone = entity.querySelector('TruncatedCone');
  if (truncatedCone) return makeZAxisCylinder(Number(truncatedCone.getAttribute('TR') || 1), Number(truncatedCone.getAttribute('BR') || 1), Number(truncatedCone.getAttribute('H') || 1));
  const porcelain = entity.querySelector('PorcelainBushing');
  if (porcelain) return createPorcelainBushing(porcelain);
  const stretched = entity.querySelector('StretchedBody');
  if (stretched) return createStretchedBody(stretched);
  const ring = entity.querySelector('Ring');
  if (ring) return new THREE.TorusGeometry(Number(ring.getAttribute('R') || 1) + Number(ring.getAttribute('DR') || 0.2), Number(ring.getAttribute('DR') || 0.2), 16, 48, Number(ring.getAttribute('Rad') || Math.PI * 2));
  const sphere = entity.querySelector('Sphere');
  if (sphere) return new THREE.SphereGeometry(Number(sphere.getAttribute('R') || sphere.getAttribute('Radius') || 1), 32, 16);
  const gasket = entity.querySelector('CircularGasket');
  if (gasket) return new THREE.TorusGeometry(Number(gasket.getAttribute('R') || 1), Number(gasket.getAttribute('DR') || gasket.getAttribute('T') || 0.2), 12, 40);
  const ellipsoid = entity.querySelector('RotationalEllipsoid');
  if (ellipsoid) {
    const geometry = new THREE.SphereGeometry(1, 32, 16);
    geometry.scale(Number(ellipsoid.getAttribute('LR') || ellipsoid.getAttribute('R') || 1), Number(ellipsoid.getAttribute('WR') || ellipsoid.getAttribute('R') || 1), Number(ellipsoid.getAttribute('H') || ellipsoid.getAttribute('HR') || 1));
    return geometry;
  }
  const tube = entity.querySelector('RoundSteelTube');
  if (tube) return makeZAxisCylinder(Number(tube.getAttribute('R') || tube.getAttribute('BR') || 1), Number(tube.getAttribute('R') || tube.getAttribute('BR') || 1), Number(tube.getAttribute('H') || tube.getAttribute('L') || 1));
  const flat = entity.querySelector('FlatSteel');
  if (flat) return makeZAxisBox(Number(flat.getAttribute('L') || 1), Number(flat.getAttribute('W') || 1), Number(flat.getAttribute('T') || flat.getAttribute('H') || 1));
  const terminal = entity.querySelector('TerminalBlock');
  if (terminal) return makeZAxisBox(Number(terminal.getAttribute('L') || 1), Number(terminal.getAttribute('W') || 1), Number(terminal.getAttribute('T') || 1));
  const offsetTable = entity.querySelector('OffsetRectangularTable');
  if (offsetTable) return makeZAxisBox(Number(offsetTable.getAttribute('L') || 1), Number(offsetTable.getAttribute('W') || 1), Number(offsetTable.getAttribute('H') || offsetTable.getAttribute('T') || 1));
  const wire = entity.querySelector('Wire');
  if (wire) return makeZAxisCylinder(Number(wire.getAttribute('R') || wire.getAttribute('DR') || 1), Number(wire.getAttribute('R') || wire.getAttribute('DR') || 1), Number(wire.getAttribute('L') || wire.getAttribute('H') || 1), 12);
  const angle = entity.querySelector('EquilateralAngleSteel');
  if (angle) {
    const length = Number(angle.getAttribute('L') || 1);
    const width = Number(angle.getAttribute('W') || 1);
    const thickness = Number(angle.getAttribute('T') || width * 0.1 || 1);
    const shape = new THREE.Shape([
      new THREE.Vector2(0, 0), new THREE.Vector2(width, 0), new THREE.Vector2(width, thickness),
      new THREE.Vector2(thickness, thickness), new THREE.Vector2(thickness, width), new THREE.Vector2(0, width),
    ]);
    return new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  }
  const primitive = Array.from(entity.children).find((child) => !['TransformMatrix', 'Color'].includes(child.tagName));
  return primitive ? createFallbackGeometry(primitive) : null;
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
  const text = await file.text();
  const kv = parseKeyValue(text);
  const group = new THREE.Group();
  group.name = path;
  parent.add(group);
  ctx.stats.phmCount += 1;
  const refs = parseOrderedRefs(text, 'SOLIDMODELS.NUM', /^SOLIDMODEL/i, 3);
  const modelRefs = refs.length > 0 ? refs : parseIndexedRefs(kv, 'SOLIDMODELS.NUM', 'SOLIDMODEL', true);
  for (const item of modelRefs) {
    const ref = item.ref;
    const childPath = resolveFilePath(ctx, ref, ['MOD', 'PHM']);
    if (!childPath) continue;
    const child = new THREE.Group();
    child.name = ref;
    child.applyMatrix4(parseMatrix(item.matrix));
    group.add(child);
    if (/\.mod$/i.test(childPath)) await renderMod(ctx, childPath, child, item.color);
    else if (/\.phm$/i.test(childPath)) await renderPhm(ctx, childPath, child);
  }
  ctx.visitingPhm.delete(path);
}

async function renderDev(ctx: RenderContext, path: string, parent: THREE.Object3D, matrix?: THREE.Matrix4): Promise<void> {
  if (ctx.visitingDev.has(path)) return;
  ctx.visitingDev.add(path);
  const file = ctx.files.get(path);
  if (!file) return;
  const text = await file.text();
  const kv = parseKeyValue(text);
  const group = new THREE.Group();
  group.name = kv.SYMBOLNAME || path;
  if (matrix) group.applyMatrix4(matrix);
  parent.add(group);
  ctx.stats.devCount += 1;

  const orderedSolidRefs = parseOrderedRefs(text, 'SOLIDMODELS.NUM', /^SOLIDMODEL/i, 2);
  const solidRefs = orderedSolidRefs.length > 0 ? orderedSolidRefs : parseIndexedRefs(kv, 'SOLIDMODELS.NUM', 'SOLIDMODEL');
  for (const item of solidRefs) {
    const ref = item.ref;
    const phmPath = resolveFilePath(ctx, ref, ['PHM', 'MOD']);
    if (!phmPath) continue;
    const child = new THREE.Group();
    child.name = ref;
    child.applyMatrix4(parseMatrix(item.matrix));
    group.add(child);
    if (/\.phm$/i.test(phmPath)) await renderPhm(ctx, phmPath, child);
    else if (/\.mod$/i.test(phmPath)) await renderMod(ctx, phmPath, child);
  }

  const orderedSubRefs = parseOrderedRefs(text, 'SUBDEVICES.NUM', /^SUBDEVICES?/i, 2);
  const subRefs = orderedSubRefs.length > 0 ? orderedSubRefs : parseIndexedRefs(kv, 'SUBDEVICES.NUM', 'SUBDEVICE');
  for (const item of subRefs) {
    const ref = item.ref;
    const devPath = resolveFilePath(ctx, ref, ['DEV']);
    if (devPath) await renderDev(ctx, devPath, group, parseMatrix(item.matrix));
  }
  ctx.visitingDev.delete(path);
}


async function renderCbm(ctx: RenderContext, path: string, parent: THREE.Object3D, visited = new Set<string>()): Promise<void> {
  if (visited.has(path)) return;
  visited.add(path);
  const file = ctx.files.get(path);
  if (!file) return;
  const kv = parseKeyValue(await file.text());
  const group = new THREE.Group();
  group.name = kv.PARTNAME || kv.SYSCLASSIFYNAME || kv.ENTITYNAME || path;
  group.applyMatrix4(parseMatrix(kv.TRANSFORMMATRIX));
  parent.add(group);
  ctx.stats.cbmCount += 1;

  const devRef = kv.OBJECTMODELPOINTER;
  const devPath = devRef ? resolveFilePath(ctx, devRef, ['DEV']) : null;
  if (devPath) await renderDev(ctx, devPath, group);

  const singleSubsystem = kv.SUBSYSTEM ? resolveFilePath(ctx, kv.SUBSYSTEM, ['CBM']) : null;
  if (singleSubsystem) await renderCbm(ctx, singleSubsystem, group, visited);

  const subsystemCount = Number(kv['SUBSYSTEMS.NUM'] || 0);
  for (let i = 0; i < subsystemCount; i++) {
    const ref = kv[`SUBSYSTEM${i}`];
    const childPath = ref ? resolveFilePath(ctx, ref, ['CBM']) : null;
    if (childPath) await renderCbm(ctx, childPath, group, visited);
  }

  const subdeviceCount = Number(kv['SUBDEVICES.NUM'] || 0);
  for (let i = 0; i < subdeviceCount; i++) {
    const ref = kv[`SUBDEVICE${i}`] || kv[`SUBDEVICES${i}`];
    const childPath = ref ? resolveFilePath(ctx, ref, ['CBM']) : null;
    if (childPath) await renderCbm(ctx, childPath, group, visited);
  }
}

async function renderFromCbmIfPossible(ctx: RenderContext, parent: THREE.Object3D): Promise<boolean> {
  const before = ctx.stats.meshCount;
  const project = resolveFilePath(ctx, 'project.cbm', ['CBM']);
  if (project) await renderCbm(ctx, project, parent);
  else {
    const cbmFiles = listFiles(ctx.files, '.cbm');
    if (cbmFiles.length === 1) await renderCbm(ctx, cbmFiles[0], parent);
  }
  return ctx.stats.meshCount > before;
}

function listFiles(files: Map<string, File>, ext: string): string[] {
  return Array.from(files.keys()).filter((path) => path.toLowerCase().endsWith(ext));
}

async function pickRootDevFiles(files: Map<string, File>, devFiles: string[]): Promise<string[]> {
  if (devFiles.length <= 1) return devFiles;
  const referenced = new Set<string>();
  for (const path of devFiles) {
    const kv = parseKeyValue(await files.get(path)!.text());
    const count = Number(kv['SUBDEVICES.NUM'] || 0);
    for (let i = 0; i < count; i++) {
      const ref = normalizeRef(kv[`SUBDEVICES${i}`] || kv[`SUBDEVICE${i}`] || '');
      if (ref) referenced.add(ref.split('/').pop()!.toLowerCase());
    }
  }
  const roots = devFiles.filter((path) => !referenced.has(path.split('/').pop()!.toLowerCase()));
  return roots.length > 0 ? roots : devFiles;
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
  root.rotation.x = -Math.PI / 2;

  const renderCtx: RenderContext = {
    files,
    byLowerPath: buildPathIndex(files),
    root,
    stats: { cbmCount: 0, devCount: 0, phmCount: 0, modCount: 0, meshCount: 0 },
    visitingDev: new Set<string>(),
    visitingPhm: new Set<string>(),
  };

  const allDevFiles = listFiles(files, '.dev');
  const devFiles = await pickRootDevFiles(files, allDevFiles);
  const phmFiles = listFiles(files, '.phm');
  const modFiles = listFiles(files, '.mod');

  const renderedFromCbm = await renderFromCbmIfPossible(renderCtx, root);

  if (renderedFromCbm) {
    // CBM carries project hierarchy and placement, so prefer it whenever it yields geometry.
  } else if (devFiles.length > 0) {
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
