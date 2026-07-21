import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { AppState } from '../app/state.js';
import type { CbmNode } from './types.js';
import { parseKeyValue } from './cbmParser.js';
import { fitCameraToScene } from '../viewer/camera.js';
import { addModelToUI } from '../ui/modelList.js';

const ROOT_NAME = 'GIM_NATIVE_ROOT';
const NATIVE_MODEL_ID = 'GIM 原生电气设备';
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
  alignedToIfc: boolean;
}

export interface NativeGimRenderOptions {
  cbmFiles?: Set<string>;
  alignToIfc?: boolean;
  coordinateWithIfc?: boolean;
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

  const columnMajor = new THREE.Matrix4().set(
    nums[0], nums[4], nums[8], nums[12],
    nums[1], nums[5], nums[9], nums[13],
    nums[2], nums[6], nums[10], nums[14],
    nums[3], nums[7], nums[11], nums[15],
  );
  const rowMajor = new THREE.Matrix4().set(
    nums[0], nums[1], nums[2], nums[3],
    nums[4], nums[5], nums[6], nums[7],
    nums[8], nums[9], nums[10], nums[11],
    nums[12], nums[13], nums[14], nums[15],
  );

  // 同时兼容两类 GIM 导出：Unity/列向量矩阵的仿射最后一行在 3/7/11/15，
  // 行优先矩阵的仿射最后一行在 12/13/14/15。用仿射行误差优先判断，
  // 只有二者都像合法矩阵时再根据平移列/行是否非零决定，避免无平移旋转矩阵被误判导致个别部件漂移。
  const columnAffineError = Math.abs(nums[3]) + Math.abs(nums[7]) + Math.abs(nums[11]) + Math.abs(nums[15] - 1);
  const rowAffineError = Math.abs(nums[12]) + Math.abs(nums[13]) + Math.abs(nums[14]) + Math.abs(nums[15] - 1);
  if (columnAffineError + 1e-8 < rowAffineError) return columnMajor;
  if (rowAffineError + 1e-8 < columnAffineError) return rowMajor;

  const columnTranslation = Math.abs(nums[12]) + Math.abs(nums[13]) + Math.abs(nums[14]);
  const rowTranslation = Math.abs(nums[3]) + Math.abs(nums[7]) + Math.abs(nums[11]);
  return columnTranslation >= rowTranslation ? columnMajor : rowMajor;
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
  const rawPoints = (el.getAttribute('Array') || '')
    .split(';')
    .map((pair) => parseNumbers(pair))
    .filter((nums) => nums.length >= 2);
  if (rawPoints.length < 3) return new THREE.BoxGeometry(1, 1, 1);

  const length = Number(el.getAttribute('L') || 1);
  const safeLength = Number.isFinite(length) ? length : 1;
  const normalParts = parseNumbers(el.getAttribute('Normal') || '');

  // 实际 GIM 拉伸体的 Array 往往是三维截面点，Normal 指定拉伸方向。
  // 不能把它一律当 XY 平面沿 Z 轴挤出，否则薄板/筋板会竖起来并出现明显偏移。
  if (rawPoints.every((nums) => nums.length >= 3) && normalParts.length >= 3) {
    const base = rawPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const normal = new THREE.Vector3(normalParts[0], normalParts[1], normalParts[2]);
    if (normal.lengthSq() > 0) {
      normal.normalize().multiplyScalar(safeLength);
      return createPrismFrom3DPolygon(base, normal);
    }
  }

  const points = rawPoints.map(([x, y]) => new THREE.Vector2(x, y));
  const shape = new THREE.Shape(points);
  return new THREE.ExtrudeGeometry(shape, { depth: safeLength, bevelEnabled: false });
}

function createPrismFrom3DPolygon(base: THREE.Vector3[], offset: THREE.Vector3): THREE.BufferGeometry {
  const top = base.map((point) => point.clone().add(offset));
  const positions: number[] = [];
  for (const point of base) positions.push(point.x, point.y, point.z);
  for (const point of top) positions.push(point.x, point.y, point.z);

  const indices: number[] = [];
  for (let i = 1; i < base.length - 1; i++) indices.push(0, i, i + 1);
  const topOffset = base.length;
  for (let i = 1; i < top.length - 1; i++) indices.push(topOffset, topOffset + i + 1, topOffset + i);
  for (let i = 0; i < base.length; i++) {
    const next = (i + 1) % base.length;
    indices.push(i, next, topOffset + next, i, topOffset + next, topOffset + i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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


function parseVector(value = ''): THREE.Vector3 | null {
  const nums = parseNumbers(value);
  if (nums.length < 3) return null;
  return new THREE.Vector3(nums[0], nums[1], nums[2]);
}

function parseVectorList(value = ''): THREE.Vector3[] {
  const grouped = value
    .split(';')
    .map((part) => parseNumbers(part))
    .filter((nums) => nums.length >= 3)
    .map((nums) => new THREE.Vector3(nums[0], nums[1], nums[2]));
  if (grouped.length > 1) return grouped;

  const nums = parseNumbers(value);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < nums.length; i += 3) points.push(new THREE.Vector3(nums[i], nums[i + 1], nums[i + 2]));
  return points;
}

function pushUniquePoint(points: THREE.Vector3[], point: THREE.Vector3 | null): void {
  if (!point) return;
  if (points.some((existing) => existing.distanceToSquared(point) < 1e-6)) return;
  points.push(point);
}

function getIndexedWirePoints(el: Element): THREE.Vector3[] {
  const indexed: Array<{ index: number; point: THREE.Vector3 }> = [];
  for (const attr of Array.from(el.attributes)) {
    const match = attr.name.match(/^(?:P|Point|Coord|Coordinate|ControlPoint)(\d+)$/i);
    if (!match) continue;
    const point = parseVector(attr.value);
    if (point) indexed.push({ index: Number(match[1]), point });
  }
  return indexed.sort((a, b) => a.index - b.index).map((item) => item.point);
}

function collectWirePoints(el: Element): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  pushUniquePoint(points, parseVector(el.getAttribute('StartCoord') || el.getAttribute('Start') || el.getAttribute('BeginCoord') || ''));

  for (const attrName of ['Array', 'Points', 'PointArray', 'Path', 'Route', 'Coords', 'Coordinates', 'ControlPoints', 'MiddleCoords']) {
    for (const point of parseVectorList(el.getAttribute(attrName) || '')) pushUniquePoint(points, point);
  }

  for (const point of getIndexedWirePoints(el)) pushUniquePoint(points, point);
  pushUniquePoint(points, parseVector(el.getAttribute('MiddleCoord') || el.getAttribute('MidCoord') || ''));
  pushUniquePoint(points, parseVector(el.getAttribute('EndCoord') || el.getAttribute('End') || ''));
  return points;
}

function createTubeAlongPoints(points: THREE.Vector3[], radius: number): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  if (points.length === 2) {
    const [start, end] = points;
    const delta = end.clone().sub(start);
    const length = delta.length();
    if (length <= 0) return null;
    const geometry = makeZAxisCylinder(radius, radius, length, 12);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), delta.normalize());
    const center = start.clone().add(end).multiplyScalar(0.5);
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    geometry.translate(center.x, center.y, center.z);
    return geometry;
  }

  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.35);
  return new THREE.TubeGeometry(curve, Math.min(64, Math.max(8, points.length * 6)), radius, 6, false);
}

function createWireGeometry(el: Element): THREE.BufferGeometry | null {
  const radius = Math.max(Number(el.getAttribute('D') || el.getAttribute('R') || 1) / 2, 0.1);
  return createTubeAlongPoints(collectWirePoints(el), radius) || createFallbackGeometry(el);
}

function createCircularGasketGeometry(el: Element): THREE.BufferGeometry {
  const outer = Number(el.getAttribute('OR') || el.getAttribute('R') || 1);
  const inner = Number(el.getAttribute('IR') || Math.max(outer * 0.6, 0.1));
  const height = Number(el.getAttribute('H') || el.getAttribute('T') || 1);
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 48 });
}

function createInsulatorGeometry(el: Element): THREE.BufferGeometry {
  const n1 = Math.max(1, Number(el.getAttribute('N1') || el.getAttribute('N') || 4));
  const h1 = Number(el.getAttribute('H1') || 20);
  const fl = Number(el.getAttribute('FL') || 0);
  const al = Number(el.getAttribute('AL') || 0);
  const r = Number(el.getAttribute('R') || 10);
  const r1 = Number(el.getAttribute('R1') || r * 1.35);
  const r2 = Number(el.getAttribute('R2') || r * 1.1);
  const total = fl + n1 * h1 + al;
  const group = new THREE.Group();
  const core = new THREE.Mesh(makeZAxisCylinder(r, r, Math.max(total, 1)));
  group.add(core);
  for (let i = 0; i < n1; i++) {
    const skirt = new THREE.Mesh(makeZAxisCylinder(i % 2 === 0 ? r2 : r1, r, h1 * 0.45, 24));
    skirt.position.z = fl + i * h1 + h1 * 0.25;
    group.add(skirt);
  }
  group.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const geometry = obj.geometry.clone();
      geometry.applyMatrix4(obj.matrixWorld);
      geometries.push(geometry);
    }
  });
  const merged = mergeBufferGeometries(geometries);
  for (const geometry of geometries) geometry.dispose();
  return merged || makeZAxisCylinder(r, r, Math.max(total, 1));
}

function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const geometry of geometries) {
    const pos = geometry.getAttribute('position');
    if (!pos) continue;
    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (normal) normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(index.getX(i) + vertexOffset);
    else for (let i = 0; i < pos.count; i++) indices.push(i + vertexOffset);
    vertexOffset += pos.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setIndex(indices);
  if (normals.length !== positions.length) merged.computeVertexNormals();
  return merged;
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
  if (ring) {
    const geometry = new THREE.TorusGeometry(Number(ring.getAttribute('R') || 1) + Number(ring.getAttribute('DR') || 0.2), Number(ring.getAttribute('DR') || 0.2), 16, 48, Number(ring.getAttribute('Rad') || Math.PI * 2));
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  const sphere = entity.querySelector('Sphere');
  if (sphere) return new THREE.SphereGeometry(Number(sphere.getAttribute('R') || sphere.getAttribute('Radius') || 1), 32, 16);
  const gasket = entity.querySelector('CircularGasket');
  if (gasket) return createCircularGasketGeometry(gasket);
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
  if (wire) return createWireGeometry(wire);
  const insulator = entity.querySelector('Insulator');
  if (insulator) return createInsulatorGeometry(insulator);
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


interface PendingBooleanEntity {
  id: string;
  visible: boolean;
  element: Element;
}

function cloneMesh(mesh: THREE.Mesh, name: string): THREE.Mesh {
  const clone = mesh.clone();
  clone.geometry = mesh.geometry.clone();
  clone.material = mesh.material;
  clone.name = name;
  return clone;
}

function mergeMeshesForBooleanUnion(a: THREE.Mesh, b: THREE.Mesh, name: string): THREE.Mesh {
  const geometryA = a.geometry.clone();
  geometryA.applyMatrix4(a.matrix);
  const geometryB = b.geometry.clone();
  geometryB.applyMatrix4(b.matrix);
  const merged = mergeBufferGeometries([geometryA, geometryB]) || geometryA;
  geometryA.dispose();
  geometryB.dispose();
  const mesh = new THREE.Mesh(merged, a.material);
  mesh.name = name;
  return mesh;
}

function resolveBooleanMesh(item: PendingBooleanEntity, meshByEntityId: Map<string, THREE.Mesh>, name: string): THREE.Mesh | null {
  const boolean = item.element.querySelector('Boolean');
  if (!boolean) return null;
  const entity1 = boolean.getAttribute('Entity1') || '';
  const entity2 = boolean.getAttribute('Entity2') || '';
  const type = (boolean.getAttribute('Type') || 'Difference').toLowerCase();
  const source1 = meshByEntityId.get(entity1);
  if (!source1) return null;
  const source2 = meshByEntityId.get(entity2);
  if (type === 'union' && source2) return mergeMeshesForBooleanUnion(source1, source2, name);

  // Difference/Intersection 没有轻量 CSG 时，优先保留主实体，避免整件消失；这与原 Unity 解析器禁用 CSG 时的稳定策略一致。
  return cloneMesh(source1, name);
}

async function renderMod(ctx: RenderContext, path: string, parent: THREE.Object3D, inheritedColor?: string): Promise<void> {
  const file = ctx.files.get(path);
  if (!file) return;
  const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
  const entities = Array.from(doc.querySelectorAll('Entity'));
  const meshByEntityId = new Map<string, THREE.Mesh>();
  const pendingBooleans: PendingBooleanEntity[] = [];
  ctx.stats.modCount += 1;

  for (const entity of entities) {
    const id = entity.getAttribute('ID') || `${ctx.stats.meshCount}`;
    const visible = (entity.getAttribute('Visible') || 'True').toLowerCase() !== 'false';
    if (entity.querySelector('Boolean')) {
      pendingBooleans.push({ id, visible, element: entity });
      continue;
    }

    const geometry = createGeometry(entity);
    if (!geometry) continue;
    const colorEl = entity.querySelector('Color');
    const material = makeMaterial(parseColor(colorEl, inheritedColor), parseOpacity(colorEl));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${path}#${id}`;
    // Wire 的端点坐标由导出器以工程绝对坐标写入；再应用实体矩阵会导致线缆整体二次偏移。
    if (!entity.querySelector('Wire')) mesh.applyMatrix4(parseMatrix(entity.querySelector('TransformMatrix')?.getAttribute('Value') || ''));
    meshByEntityId.set(id, mesh);
    if (!visible) continue;
    parent.add(mesh);
    ctx.stats.meshCount += 1;
  }

  const unresolved = new Set(pendingBooleans.map((item) => item.id));
  let progressed = true;
  while (progressed && unresolved.size > 0) {
    progressed = false;
    for (const item of pendingBooleans) {
      if (!unresolved.has(item.id)) continue;
      const mesh = resolveBooleanMesh(item, meshByEntityId, `${path}#${item.id}`);
      if (!mesh) continue;
      meshByEntityId.set(item.id, mesh);
      unresolved.delete(item.id);
      progressed = true;
      if (item.visible) {
        parent.add(mesh);
        ctx.stats.meshCount += 1;
      }
    }
  }
}


async function renderStl(ctx: RenderContext, path: string, parent: THREE.Object3D, color?: string): Promise<void> {
  const file = ctx.files.get(path);
  if (!file) return;
  try {
    const geometry = new STLLoader().parse(await file.arrayBuffer());
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, makeMaterial(parseColor(null, color)));
    mesh.name = path;
    parent.add(mesh);
    ctx.stats.meshCount += 1;
  } catch (error) {
    console.warn(`STL 解析失败 (${path}):`, error);
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
    const childPath = resolveFilePath(ctx, ref, ['MOD', 'PHM', 'DEV']);
    if (!childPath) continue;
    const child = new THREE.Group();
    child.name = ref;
    child.applyMatrix4(parseMatrix(item.matrix));
    group.add(child);
    if (/\.mod$/i.test(childPath)) await renderMod(ctx, childPath, child, item.color);
    else if (/\.phm$/i.test(childPath)) await renderPhm(ctx, childPath, child);
    else if (/\.stl$/i.test(childPath)) await renderStl(ctx, childPath, child, item.color);
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
    const phmPath = resolveFilePath(ctx, ref, ['PHM', 'MOD', 'DEV']);
    if (!phmPath) continue;
    const child = new THREE.Group();
    child.name = ref;
    child.applyMatrix4(parseMatrix(item.matrix));
    group.add(child);
    if (/\.phm$/i.test(phmPath)) await renderPhm(ctx, phmPath, child);
    else if (/\.mod$/i.test(phmPath)) await renderMod(ctx, phmPath, child);
    else if (/\.stl$/i.test(phmPath)) await renderStl(ctx, phmPath, child);
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
  group.userData.cbmPath = path;
  group.userData.ifcFile = kv.IFCFILE || '';
  group.userData.ifcGuid = (kv.IFCGUID || '').replace(/\$+$/, '').trim();
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

async function renderFromCbmIfPossible(ctx: RenderContext, parent: THREE.Object3D, options: NativeGimRenderOptions = {}): Promise<boolean> {
  const before = ctx.stats.meshCount;
  if (options.cbmFiles && options.cbmFiles.size > 0) {
    for (const ref of options.cbmFiles) {
      const cbmPath = resolveFilePath(ctx, ref, ['CBM']);
      if (cbmPath) await renderCbm(ctx, cbmPath, parent, new Set<string>());
    }
    return ctx.stats.meshCount > before;
  }

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


function getMaterialKey(material: THREE.Material): string {
  const mat = material as THREE.MeshStandardMaterial;
  return [material.type, mat.color?.getHexString() || 'none', mat.opacity ?? 1, mat.transparent ? 1 : 0, mat.side].join('|');
}

/** 合并同一 CBM 节点的非层级网格，保留 cbmPath 供设备拾取和属性查询。 */
function optimizeCbmGroup(group: THREE.Object3D): void {
  for (const child of group.children) if (child.userData.cbmPath) optimizeCbmGroup(child);
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  const disposable: THREE.BufferGeometry[] = [];
  for (const child of [...group.children]) {
    if (child.userData.cbmPath) continue;
    child.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      const key = getMaterialKey(material);
      if (!buckets.has(key)) buckets.set(key, { material, geometries: [] });
      const geometry = object.geometry.clone();
      geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld));
      buckets.get(key)!.geometries.push(geometry);
      disposable.push(object.geometry);
    });
    group.remove(child);
  }
  for (const geometry of disposable) geometry.dispose();
  for (const { material, geometries } of buckets.values()) {
    const merged = mergeBufferGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    merged.computeBoundingBox(); merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = 'GIM_NATIVE_CBM_MERGED';
    mesh.frustumCulled = false;
    group.add(mesh);
  }
}

function isLikelySitePlane(box: THREE.Box3): boolean {
  const size = box.getSize(new THREE.Vector3());
  const horizontal = Math.max(size.x, size.y);
  const vertical = Math.max(size.z, 1e-6);
  return horizontal > 20 && horizontal / vertical > 80;
}

function getObjectStructuralBox(object: THREE.Object3D): THREE.Box3 | null {
  const structuralBox = new THREE.Box3();
  const fallbackBox = new THREE.Box3();
  let hasStructural = false;
  let hasFallback = false;

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const childBox = new THREE.Box3().setFromObject(child);
    if (childBox.isEmpty()) return;
    fallbackBox.union(childBox);
    hasFallback = true;
    if (isLikelySitePlane(childBox)) return;
    structuralBox.union(childBox);
    hasStructural = true;
  });

  if (hasStructural) return structuralBox;
  return hasFallback ? fallbackBox : null;
}

function getLoadedIfcBox(ctx: ViewerContext, state: AppState): THREE.Box3 | null {
  const box = new THREE.Box3();
  let hasBox = false;
  for (const [modelId] of state.loadedModels) {
    const model = ctx.fragments.list.get(modelId);
    if (!model?.object) continue;
    const modelBox = getObjectStructuralBox(model.object);
    if (!modelBox) continue;
    box.union(modelBox);
    hasBox = true;
  }
  return hasBox ? box : null;
}

function collectCbmIfcRefs(state: AppState, cbmFiles?: Set<string>): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  if (!cbmFiles || cbmFiles.size === 0) return refs;

  const addNodeRefs = (node: CbmNode | null | undefined): void => {
    if (!node) return;
    if (node.ifcFile && node.ifcGuid) {
      const modelId = node.ifcFile.replace(/\.ifc$/i, '');
      if (!refs.has(modelId)) refs.set(modelId, new Set<string>());
      refs.get(modelId)!.add(node.ifcGuid);
    }
    for (const child of node.children) addNodeRefs(child);
  };

  for (const cbmFile of cbmFiles) {
    const fileName = normalizeRef(cbmFile).split('/').pop() || cbmFile;
    addNodeRefs(state.cbmNodeIndex.get(fileName));
  }

  return refs;
}

async function getIfcBoxForCbmRefs(ctx: ViewerContext, state: AppState, cbmFiles?: Set<string>): Promise<THREE.Box3 | null> {
  const refs = collectCbmIfcRefs(state, cbmFiles);
  if (refs.size === 0) return null;

  const box = new THREE.Box3();
  let hasBox = false;
  for (const [modelId, guids] of refs) {
    const model = ctx.fragments.list.get(modelId);
    if (!model || guids.size === 0) continue;
    const localIds = (await model.getLocalIdsByGuids(Array.from(guids))).filter((id): id is number => id !== null);
    if (localIds.length === 0) continue;
    const modelBox = await model.getMergedBox(localIds);
    if (modelBox.isEmpty()) continue;
    box.union(modelBox);
    hasBox = true;
  }
  return hasBox ? box : null;
}

async function getIfcBoxForCbmGroup(ctx: ViewerContext, group: THREE.Object3D): Promise<THREE.Box3 | null> {
  const ifcFile = typeof group.userData.ifcFile === 'string' ? group.userData.ifcFile : '';
  const ifcGuid = typeof group.userData.ifcGuid === 'string' ? group.userData.ifcGuid : '';
  if (!ifcFile || !ifcGuid) return null;
  const modelId = ifcFile.replace(/\.ifc$/i, '');
  const model = ctx.fragments.list.get(modelId);
  if (!model) return null;
  const [localId] = await model.getLocalIdsByGuids([ifcGuid]);
  if (localId === null) return null;
  const box = await model.getMergedBox([localId]);
  return box.isEmpty() ? null : box;
}

function selectedCbmKeys(cbmFiles?: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const ref of cbmFiles || []) {
    const normalized = normalizeRef(ref).toLowerCase();
    keys.add(normalized);
    const fileName = normalized.split('/').pop();
    if (fileName) keys.add(fileName);
  }
  return keys;
}

function isSelectedCbmGroup(group: THREE.Object3D, keys: Set<string>): boolean {
  const cbmPath = typeof group.userData.cbmPath === 'string' ? normalizeRef(group.userData.cbmPath).toLowerCase() : '';
  if (!cbmPath) return false;
  return keys.has(cbmPath) || keys.has(cbmPath.split('/').pop() || cbmPath);
}

function worldDeltaToParentLocal(parent: THREE.Object3D, delta: THREE.Vector3): THREE.Vector3 {
  parent.updateMatrixWorld(true);
  const origin = new THREE.Vector3();
  const target = delta.clone();
  return parent.worldToLocal(target).sub(parent.worldToLocal(origin));
}

async function alignNativeCbmGroupsToIfc(ctx: ViewerContext, root: THREE.Group, cbmFiles?: Set<string>): Promise<boolean> {
  const keys = selectedCbmKeys(cbmFiles);
  if (keys.size === 0) return false;
  root.updateMatrixWorld(true);
  let aligned = 0;
  const candidates: THREE.Object3D[] = [];
  const hasIfcLink = (obj: THREE.Object3D) => Boolean(obj.userData.ifcFile && obj.userData.ifcGuid);
  const collectCandidates = (obj: THREE.Object3D, insideSelected: boolean): void => {
    const selected = isSelectedCbmGroup(obj, keys);
    if ((selected || insideSelected) && hasIfcLink(obj)) {
      candidates.push(obj);
      return;
    }
    for (const child of obj.children) collectCandidates(child, insideSelected || selected);
  };
  collectCandidates(root, false);

  for (const group of candidates) {
    const ifcBox = await getIfcBoxForCbmGroup(ctx, group);
    if (!ifcBox) continue;
    group.updateMatrixWorld(true);
    const nativeBox = new THREE.Box3().setFromObject(group);
    if (nativeBox.isEmpty()) continue;
    const delta = ifcBox.getCenter(new THREE.Vector3()).sub(nativeBox.getCenter(new THREE.Vector3()));
    delta.z = ifcBox.min.z - nativeBox.min.z;
    const parent = group.parent || root;
    group.position.add(worldDeltaToParentLocal(parent, delta));
    group.updateMatrixWorld(true);
    aligned += 1;
  }

  return aligned > 0;
}

function applyIfcBaseCoordinateTransform(ctx: ViewerContext, root: THREE.Group): boolean {
  const baseMatrix = ctx.fragments.baseCoordinationMatrix;
  if (!baseMatrix) return false;
  root.applyMatrix4(baseMatrix.clone());
  root.updateMatrixWorld(true);
  return true;
}

export async function alignNativeRootToLoadedIfc(ctx: ViewerContext, state: AppState, root: THREE.Group, cbmFiles?: Set<string>): Promise<boolean> {
  const ifcBox = (await getIfcBoxForCbmRefs(ctx, state, cbmFiles)) || getLoadedIfcBox(ctx, state);
  if (!ifcBox) return false;
  root.updateMatrixWorld(true);
  const nativeBox = new THREE.Box3().setFromObject(root);
  if (nativeBox.isEmpty()) return false;

  const ifcCenter = ifcBox.getCenter(new THREE.Vector3());
  const nativeCenter = nativeBox.getCenter(new THREE.Vector3());
  const delta = ifcCenter.sub(nativeCenter);
  // 优先对齐到 CBM/IFCGUID 对应的 IFC 构件包围盒；没有映射时才退回到结构主体包围盒。
  // Z 方向按底部贴齐，避免把设备细节整体抬高/压低。
  delta.z = ifcBox.min.z - nativeBox.min.z;
  root.position.add(delta);
  root.updateMatrixWorld(true);
  return true;
}

function applyNativeRuntimeHints(root: THREE.Group): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.frustumCulled = false;
    if (obj.geometry instanceof THREE.BufferGeometry) {
      obj.geometry.computeBoundingBox();
      obj.geometry.computeBoundingSphere();
    }
  });
}

export function removePreviousNativeRoot(ctx: ViewerContext): void {
  const scene = (ctx.world.scene as any).three as THREE.Scene;
  const previous = scene.getObjectByName(ROOT_NAME);
  if (!previous) return;
  previous.removeFromParent();
  document.getElementById(`model-${NATIVE_MODEL_ID}`)?.remove();
  previous.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) material.dispose();
    }
  });
}

export async function renderNativeGimModel(ctx: ViewerContext, state: AppState, files: Map<string, File>, options: NativeGimRenderOptions = {}): Promise<NativeGimRenderResult | null> {
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
  const stlFiles = listFiles(files, '.stl');

  const renderedFromCbm = await renderFromCbmIfPossible(renderCtx, root, options);

  if (renderedFromCbm) {
    // CBM carries project hierarchy and placement, so prefer it whenever it yields geometry.
  } else if (!options.cbmFiles && devFiles.length > 0) {
    for (const path of devFiles) await renderDev(renderCtx, path, root);
  } else if (!options.cbmFiles && phmFiles.length > 0) {
    for (const path of phmFiles) await renderPhm(renderCtx, path, root);
  } else if (!options.cbmFiles) {
    let offset = 0;
    for (const path of modFiles) {
      const group = new THREE.Group();
      group.position.x = offset;
      root.add(group);
      await renderMod(renderCtx, path, group);
      offset += 2000;
    }
    for (const path of stlFiles) {
      const group = new THREE.Group();
      group.position.x = offset;
      root.add(group);
      await renderStl(renderCtx, path, group);
      offset += 2000;
    }
  }

  if (renderCtx.stats.meshCount === 0) return null;
  const coordinatedToIfc = options.coordinateWithIfc ? applyIfcBaseCoordinateTransform(ctx, root) : false;
  let alignedToIfc = coordinatedToIfc;
  if (!coordinatedToIfc && options.alignToIfc !== false) {
    alignedToIfc = await alignNativeCbmGroupsToIfc(ctx, root, options.cbmFiles);
    // 完整工程没有指定 CBM 子集时，退回到 IFC 场景整体包围盒对齐，避免原生一次设备整体飘离站区。
    if (!alignedToIfc) alignedToIfc = await alignNativeRootToLoadedIfc(ctx, state, root, options.cbmFiles);
  }
  // 合并每个 CBM 节点内的几何以降低 draw call，同时保留 CBM 层级和 cbmPath。
  optimizeCbmGroup(root);
  applyNativeRuntimeHints(root);
  ((ctx.world.scene as any).three as THREE.Scene).add(root);
  state.loadedMeshModels.set(NATIVE_MODEL_ID, { modelId: NATIVE_MODEL_ID, root, visible: true });
  addModelToUI(ctx, state, NATIVE_MODEL_ID);
  state.hasFittedCamera = false;
  fitCameraToScene(ctx, state);
  return { group: root, alignedToIfc, ...renderCtx.stats };
}
