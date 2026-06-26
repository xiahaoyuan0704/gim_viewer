import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseKeyValueEntries, type KeyValueEntry } from '../gim/cbmParser.js';

const IDENTITY = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

type BuildContext = {
  files: Map<string, File>;
  pathIndex: Map<string, string>;
  modCache: Map<string, Promise<THREE.Object3D>>;
  phmCache: Map<string, Promise<THREE.Object3D>>;
  devCache: Map<string, Promise<THREE.Object3D>>;
  stlCache: Map<string, Promise<THREE.Object3D>>;
};

function normalizePath(path: string): string { return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase(); }

function makePathIndex(files: Map<string, File>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of files.keys()) index.set(normalizePath(path), path);
  return index;
}

function resolvePath(ctx: BuildContext, wanted: string): string | null {
  const exact = ctx.pathIndex.get(normalizePath(wanted));
  if (exact) return exact;
  const normalized = normalizePath(wanted);
  const parts = normalized.split('/');
  const folder = parts[parts.length - 2];
  const fileName = parts[parts.length - 1];
  if (!folder || !fileName) return null;
  for (const [key, original] of ctx.pathIndex) {
    const p = key.split('/');
    if (p[p.length - 2] === folder && p[p.length - 1] === fileName) return original;
  }
  for (const [key, original] of ctx.pathIndex) {
    if (key.endsWith(`/${folder}/${fileName}`) || key.endsWith(`/${fileName}`)) return original;
  }
  return null;
}

function refsInFolder(ctx: BuildContext, folder: string, ext: string): string[] {
  const result: string[] = [];
  const folderLower = folder.toLowerCase();
  const extLower = ext.toLowerCase();
  for (const [key, original] of ctx.pathIndex) {
    const parts = key.split('/');
    if (parts[parts.length - 2] === folderLower && key.endsWith(extLower)) result.push(original);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function fileNameOf(path: string): string { return normalizePath(path).split('/').pop() || ''; }

function entryKeyStartsWith(entry: KeyValueEntry | undefined, prefix: string): boolean {
  return !!entry && entry.key.toUpperCase().startsWith(prefix.toUpperCase());
}

async function collectRootDevPaths(ctx: BuildContext): Promise<string[]> {
  const devPaths = refsInFolder(ctx, 'DEV', '.dev');
  const referenced = new Set<string>();
  for (const devPath of devPaths) {
    const text = await loadText(ctx, devPath);
    if (!text) continue;
    for (const { ref } of modelsAfterCount(parseKeyValueEntries(text), 'SUBDEVICES.NUM', 'SUBDEVICE', 2)) referenced.add(fileNameOf(ref));
  }
  const roots = devPaths.filter((devPath) => !referenced.has(fileNameOf(devPath)));
  return roots.length > 0 ? roots : devPaths;
}

function childByTag(entity: Element, tagName: string): Element | null {
  const lower = tagName.toLowerCase();
  return Array.from(entity.children).find((child) => child.tagName.toLowerCase() === lower) ?? null;
}

function nums(value: string | null | undefined): number[] {
  return (value || '').split(/[;,\s]+/).map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function matrixFromValues(values: number[], columnMajor: boolean): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  if (columnMajor) {
    matrix.fromArray(values);
  } else {
    matrix.set(
      values[0], values[1], values[2], values[3],
      values[4], values[5], values[6], values[7],
      values[8], values[9], values[10], values[11],
      values[12], values[13], values[14], values[15],
    );
  }
  return matrix;
}

function decomposeGimMatrix(values: number[], columnMajor: boolean): { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null {
  const matrix = matrixFromValues(values, columnMajor);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  if (![position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, scale.x, scale.y, scale.z].every(Number.isFinite)) return null;
  return { position, quaternion, scale };
}

function applyGimTransform(object: THREE.Object3D, value: string | null | undefined): void {
  const n = nums(value || IDENTITY);
  const m = n.length >= 16 ? n.slice(0, 16) : nums(IDENTITY);
  const rowTranslation = new THREE.Vector3(m[3], m[7], m[11]);
  const columnTranslation = new THREE.Vector3(m[12], m[13], m[14]);
  const preferColumnMajor = columnTranslation.lengthSq() > 1e-12 && rowTranslation.lengthSq() <= 1e-12;
  const primary = decomposeGimMatrix(m, preferColumnMajor);
  const fallback = primary ?? decomposeGimMatrix(m, !preferColumnMajor);
  if (!fallback) {
    object.position.copy(preferColumnMajor ? columnTranslation : rowTranslation);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
    return;
  }
  object.position.copy(fallback.position);
  object.quaternion.copy(fallback.quaternion);
  object.scale.copy(fallback.scale);
}

function colorMaterial(colorEl?: Element | null, override?: string): THREE.Material {
  let r = 150; let g = 174; let b = 190; let a = 100;
  const overrideNums = nums(override || '');
  if (overrideNums.length >= 3) {
    [r, g, b] = overrideNums;
    if (overrideNums.length >= 4) a = overrideNums[3];
  } else if (colorEl) {
    r = Number(colorEl.getAttribute('R') ?? r);
    g = Number(colorEl.getAttribute('G') ?? g);
    b = Number(colorEl.getAttribute('B') ?? b);
    a = Number(colorEl.getAttribute('A') ?? a);
  }
  // Many native GIM packages encode untextured equipment as pure white, which
  // disappears on the viewer's light background. Keep real colors, but remap
  // near-white defaults to a blue-gray engineering material.
  if (r > 235 && g > 235 && b > 235) { r = 175; g = 205; b = 222; }
  const opacity = Math.max(0, Math.min(1, a / 100));
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(r / 255, g / 255, b / 255),
    opacity,
    transparent: opacity < 1,
    roughness: 0.75,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
}


function decorateMesh(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const position = mesh.geometry.getAttribute('position');
  if (position && position.count <= 200000) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 25),
      new THREE.LineBasicMaterial({ color: 0x4f6573, transparent: true, opacity: 0.35 }),
    );
    edges.name = `${mesh.name || 'mesh'}#edges`;
    mesh.add(edges);
  }
  return mesh;
}


function modelsAfterCount(entries: KeyValueEntry[], countKey: string, valuePrefix: string, stride = 2): Array<{ ref: string; transform: string; color?: string }> {
  const out: Array<{ ref: string; transform: string; color?: string }> = [];
  const upperPrefix = valuePrefix.toUpperCase();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].key !== countKey) continue;
    const count = Number.parseInt(entries[i].value || '0', 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    let j = i + 1;
    for (let item = 0; item < count && j < entries.length; item++) {
      while (j < entries.length && !entries[j].key.toUpperCase().startsWith(upperPrefix)) j++;
      const ref = entries[j]?.value;
      const transform = entryKeyStartsWith(entries[j + 1], 'TRANSFORMMATRIX') ? entries[j + 1].value : IDENTITY;
      const color = stride >= 3 && entryKeyStartsWith(entries[j + 2], 'COLOR') ? entries[j + 2].value : undefined;
      if (ref) out.push({ ref, transform, color });
      j += stride;
    }
  }
  return out;
}

function attrNum(el: Element, name: string, fallback: number): number {
  const value = Number(el.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
}

function pipeGeometry(outerRadius: number, innerRadius: number, height: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
  if (innerRadius > 0 && innerRadius < outerRadius) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 48 });
}

function ribbedInsulatorGeometry(radius: number, skirtRadius: number, height: number, count: number): THREE.BufferGeometry {
  const n = Math.max(1, Math.floor(count));
  const points: THREE.Vector2[] = [];
  points.push(new THREE.Vector2(radius, -height / 2));
  for (let i = 0; i < n; i++) {
    const y0 = -height / 2 + (height * i) / n;
    const y1 = -height / 2 + (height * (i + 0.35)) / n;
    const y2 = -height / 2 + (height * (i + 0.65)) / n;
    const y3 = -height / 2 + (height * (i + 1)) / n;
    points.push(new THREE.Vector2(radius, y0));
    points.push(new THREE.Vector2(skirtRadius, y1));
    points.push(new THREE.Vector2(skirtRadius, y2));
    points.push(new THREE.Vector2(radius, y3));
  }
  points.push(new THREE.Vector2(radius, height / 2));
  const geo = new THREE.LatheGeometry(points, 32);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function wireGeometry(wire: Element): THREE.BufferGeometry | null {
  const start = nums(wire.getAttribute('StartCoord'));
  const end = nums(wire.getAttribute('EndCoord'));
  if (start.length < 3 || end.length < 3) return null;
  const a = new THREE.Vector3(start[0], start[1], start[2]);
  const b = new THREE.Vector3(end[0], end[1], end[2]);
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length();
  if (length <= 1e-6) return null;
  const radius = attrNum(wire, 'D', 2) / 2;
  const geo = new THREE.CylinderGeometry(radius, radius, length, 8);
  geo.rotateX(Math.PI / 2);
  const center = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
  geo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  geo.translate(center.x, center.y, center.z);
  return geo;
}

function parsePointList(value: string | null): THREE.Vector3[] {
  return (value || '').split(';')
    .map((part) => nums(part))
    .filter((part) => part.length >= 3)
    .map((part) => new THREE.Vector3(part[0], part[1], part[2]));
}

function polygonNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  return normal.lengthSq() > 1e-12 ? normal.normalize() : new THREE.Vector3(0, 0, 1);
}

function stretchedBodyGeometry(stretched: Element): THREE.BufferGeometry | null {
  const points = parsePointList(stretched.getAttribute('Array'));
  if (points.length < 3) return null;
  const normalValues = nums(stretched.getAttribute('Normal'));
  const normal = normalValues.length >= 3 ? new THREE.Vector3(normalValues[0], normalValues[1], normalValues[2]) : polygonNormal(points);
  if (normal.lengthSq() <= 1e-12) normal.copy(polygonNormal(points));
  normal.normalize();
  const length = attrNum(stretched, 'L', 1);
  const extrusion = normal.clone().multiplyScalar(length);

  const basisX = new THREE.Vector3().subVectors(points[1], points[0]);
  if (basisX.lengthSq() <= 1e-12) return null;
  basisX.normalize();
  const basisY = new THREE.Vector3().crossVectors(normal, basisX).normalize();
  if (basisY.lengthSq() <= 1e-12) return null;
  const points2d = points.map((point) => new THREE.Vector2(point.dot(basisX), point.dot(basisY)));
  const triangles = THREE.ShapeUtils.triangulateShape(points2d, []);
  if (triangles.length === 0) return null;

  const vertices: number[] = [];
  const indices: number[] = [];
  for (const point of points) vertices.push(point.x, point.y, point.z);
  for (const point of points) {
    const back = point.clone().add(extrusion);
    vertices.push(back.x, back.y, back.z);
  }

  for (const tri of triangles) indices.push(tri[0], tri[1], tri[2]);
  const offset = points.length;
  for (const tri of triangles) indices.push(offset + tri[2], offset + tri[1], offset + tri[0]);
  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;
    indices.push(i, next, offset + next, i, offset + next, offset + i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function geometryFromEntity(entity: Element): THREE.BufferGeometry | null {
  const cuboid = childByTag(entity, 'Cuboid');
  if (cuboid) {
    return new THREE.BoxGeometry(
      Number(cuboid.getAttribute('L') || 1),
      Number(cuboid.getAttribute('W') || 1),
      Number(cuboid.getAttribute('H') || 1),
    );
  }

  const cylinder = childByTag(entity, 'Cylinder');
  if (cylinder) {
    const geo = new THREE.CylinderGeometry(
      Number(cylinder.getAttribute('R') || 1),
      Number(cylinder.getAttribute('R') || 1),
      Number(cylinder.getAttribute('H') || 1),
      32,
    );
    geo.rotateX(Math.PI / 2);
    return geo;
  }

  const bushing = childByTag(entity, 'PorcelainBushing');
  if (bushing) {
    const r = attrNum(bushing, 'R', 20);
    const r1 = Math.max(attrNum(bushing, 'R1', r * 1.3), attrNum(bushing, 'R2', r));
    return ribbedInsulatorGeometry(r, r1, attrNum(bushing, 'H', 100), attrNum(bushing, 'N', 8));
  }

  const ring = childByTag(entity, 'Ring');
  if (ring) {
    const major = attrNum(ring, 'R', 1) + attrNum(ring, 'DR', 0.2);
    const tube = Math.max(attrNum(ring, 'DR', 0.2), 0.001);
    const arc = attrNum(ring, 'Rad', Math.PI * 2);
    const geo = new THREE.TorusGeometry(major, tube, 12, 48, arc > 0 ? arc : Math.PI * 2);
    geo.rotateX(Math.PI / 2);
    return geo;
  }

  const cone = childByTag(entity, 'TruncatedCone');
  if (cone) {
    const geo = new THREE.CylinderGeometry(attrNum(cone, 'TR', 1), attrNum(cone, 'BR', 1), attrNum(cone, 'H', 1), 48);
    geo.rotateX(Math.PI / 2);
    return geo;
  }

  const sphere = childByTag(entity, 'Sphere');
  if (sphere) return new THREE.SphereGeometry(attrNum(sphere, 'R', 1), 32, 16);

  const gasket = childByTag(entity, 'CircularGasket');
  if (gasket) {
    return pipeGeometry(attrNum(gasket, 'OR', 1), attrNum(gasket, 'IR', 0.5), attrNum(gasket, 'H', 0.1));
  }

  const ellipsoid = childByTag(entity, 'RotationalEllipsoid');
  if (ellipsoid) {
    const geo = new THREE.SphereGeometry(1, 32, 16);
    geo.scale(attrNum(ellipsoid, 'LR', 1), attrNum(ellipsoid, 'WR', 1), attrNum(ellipsoid, 'H', 1));
    return geo;
  }

  const wire = childByTag(entity, 'Wire');
  if (wire) return wireGeometry(wire);

  const insulator = childByTag(entity, 'Insulator');
  if (insulator) {
    const core = Math.max(attrNum(insulator, 'R', 1), attrNum(insulator, 'R2', 1));
    const skirt = Math.max(core, attrNum(insulator, 'R1', core * 1.4));
    const height = Math.max(attrNum(insulator, 'H1', 1) * Math.max(attrNum(insulator, 'N1', 1), 1), attrNum(insulator, 'D', 1));
    return ribbedInsulatorGeometry(core, skirt, height, attrNum(insulator, 'N1', attrNum(insulator, 'N', 8)));
  }

  const terminal = childByTag(entity, 'TerminalBlock');
  if (terminal) {
    return new THREE.BoxGeometry(attrNum(terminal, 'L', 1), attrNum(terminal, 'W', 1), attrNum(terminal, 'T', attrNum(terminal, 'H', 1)));
  }

  const offsetTable = childByTag(entity, 'OffsetRectangularTable');
  if (offsetTable) {
    return new THREE.BoxGeometry(attrNum(offsetTable, 'LL', attrNum(offsetTable, 'TL', 1)), attrNum(offsetTable, 'LW', attrNum(offsetTable, 'TW', 1)), attrNum(offsetTable, 'H', 1));
  }

  const roundTube = childByTag(entity, 'RoundSteelTube');
  if (roundTube) {
    const r = attrNum(roundTube, 'R', attrNum(roundTube, 'OR', attrNum(roundTube, 'D', 2) / 2));
    const inner = attrNum(roundTube, 'IR', Math.max(0, r - attrNum(roundTube, 'T', r * 0.2)));
    return pipeGeometry(r, inner, attrNum(roundTube, 'L', attrNum(roundTube, 'H', 1)));
  }

  const angleSteel = childByTag(entity, 'EquilateralAngleSteel');
  if (angleSteel) {
    const l = attrNum(angleSteel, 'L', 1);
    const w = attrNum(angleSteel, 'W', attrNum(angleSteel, 'B', 1));
    const t = attrNum(angleSteel, 'T', w * 0.1);
    return new THREE.BoxGeometry(l, w, t);
  }

  const flatSteel = childByTag(entity, 'FlatSteel');
  if (flatSteel) return new THREE.BoxGeometry(attrNum(flatSteel, 'L', 1), attrNum(flatSteel, 'W', 1), attrNum(flatSteel, 'T', 1));

  const stretched = childByTag(entity, 'StretchedBody');
  if (stretched) return stretchedBodyGeometry(stretched);

  return null;
}

async function loadText(ctx: BuildContext, path: string): Promise<string | null> {
  const resolved = resolvePath(ctx, path);
  const file = resolved ? ctx.files.get(resolved) : null;
  return file ? file.text() : null;
}

async function loadBuffer(ctx: BuildContext, path: string): Promise<ArrayBuffer | null> {
  const resolved = resolvePath(ctx, path);
  const file = resolved ? ctx.files.get(resolved) : null;
  return file ? file.arrayBuffer() : null;
}

function parseAsciiStl(text: string): THREE.BufferGeometry | null {
  const vertices: number[] = [];
  for (const match of text.matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)) {
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (vertices.length < 9) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

function parseBinaryStl(buffer: ArrayBuffer): THREE.BufferGeometry | null {
  if (buffer.byteLength < 84) return null;
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  if (84 + triangles * 50 > buffer.byteLength) return null;
  const vertices = new Float32Array(triangles * 9);
  let offset = 84;
  let out = 0;
  for (let i = 0; i < triangles; i++) {
    offset += 12; // normal
    for (let v = 0; v < 3; v++) {
      vertices[out++] = view.getFloat32(offset, true); offset += 4;
      vertices[out++] = view.getFloat32(offset, true); offset += 4;
      vertices[out++] = view.getFloat32(offset, true); offset += 4;
    }
    offset += 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

async function buildStl(path: string, ctx: BuildContext, overrideColor?: string): Promise<THREE.Object3D> {
  const cached = ctx.stlCache.get(`${path}|${overrideColor || ''}`);
  if (cached) return (await cached).clone(true);

  const promise = (async () => {
    const group = new THREE.Group();
    group.name = path;
    const buffer = await loadBuffer(ctx, path);
    if (!buffer) return group;
    const header = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 256)));
    const geo = header.trimStart().startsWith('solid') ? parseAsciiStl(new TextDecoder().decode(buffer)) ?? parseBinaryStl(buffer) : parseBinaryStl(buffer);
    if (!geo) return group;
    group.add(decorateMesh(new THREE.Mesh(geo, colorMaterial(null, overrideColor))));
    return group;
  })();

  ctx.stlCache.set(`${path}|${overrideColor || ''}`, promise);
  return (await promise).clone(true);
}

async function buildSolidRef(ref: string, ctx: BuildContext, overrideColor?: string): Promise<THREE.Object3D | null> {
  if (/\.mod$/i.test(ref)) return buildMod(`MOD/${ref}`, ctx, overrideColor);
  if (/\.phm$/i.test(ref)) return buildPhm(`PHM/${ref}`, ctx);
  if (/\.stl$/i.test(ref)) return buildStl(`MOD/${ref}`, ctx, overrideColor);
  return null;
}

async function buildMod(path: string, ctx: BuildContext, overrideColor?: string): Promise<THREE.Object3D> {
  const cached = ctx.modCache.get(`${path}|${overrideColor || ''}`);
  if (cached) return (await cached).clone(true);

  const promise = (async () => {
    const text = await loadText(ctx, path);
    const group = new THREE.Group();
    group.name = path;
    if (!text) return group;

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const entities = Array.from(doc.getElementsByTagName('*')).filter((el) => el.tagName.toLowerCase() === 'entity');
    const geometryById = new Map<string, THREE.BufferGeometry>();
    for (const entity of entities) {
      const id = entity.getAttribute('ID') || '';
      const visible = (entity.getAttribute('Visible') || 'True').toLowerCase() !== 'false';
      let geo = geometryFromEntity(entity);

      // Several MOD files use Boolean entities as the final visible shape. The
      // Unity reference parser keeps Boolean CSG disabled by default and simply
      // aliases the Boolean result to Entity1. Doing the same here prevents
      // Boolean-heavy models from becoming blank while avoiding fragile CSG in
      // the browser.
      const boolean = childByTag(entity, 'Boolean');
      if (!geo && boolean) {
        const sourceId = boolean.getAttribute('Entity1') || '';
        const source = geometryById.get(sourceId);
        if (source) geo = source.clone();
      }

      if (!geo) continue;
      if (id) geometryById.set(id, geo.clone());
      if (!visible) continue;
      const mat = colorMaterial(childByTag(entity, 'Color'), overrideColor);
      const mesh = decorateMesh(new THREE.Mesh(geo, mat));
      mesh.name = `${path}#${id}`;
      applyGimTransform(mesh, childByTag(entity, 'TransformMatrix')?.getAttribute('Value'));
      group.add(mesh);
    }
    return group;
  })();

  ctx.modCache.set(`${path}|${overrideColor || ''}`, promise);
  return (await promise).clone(true);
}

async function buildPhm(path: string, ctx: BuildContext): Promise<THREE.Object3D> {
  const cached = ctx.phmCache.get(path);
  if (cached) return (await cached).clone(true);

  const promise = (async () => {
    const text = await loadText(ctx, path);
    const group = new THREE.Group();
    group.name = path;
    if (!text) return group;

    const entries = parseKeyValueEntries(text);
    for (const { ref, transform, color } of modelsAfterCount(entries, 'SOLIDMODELS.NUM', 'SOLIDMODEL', 3)) {
      const child = await buildSolidRef(ref, ctx, color);
      if (!child) continue;
      applyGimTransform(child, transform);
      group.add(child);
    }
    return group;
  })();

  ctx.phmCache.set(path, promise);
  return (await promise).clone(true);
}

async function buildDev(path: string, ctx: BuildContext): Promise<THREE.Object3D> {
  const cached = ctx.devCache.get(path);
  if (cached) return (await cached).clone(true);

  const promise = (async () => {
    const text = await loadText(ctx, path);
    const group = new THREE.Group();
    group.name = path;
    if (!text) return group;

    const entries = parseKeyValueEntries(text);
    for (const { ref, transform } of modelsAfterCount(entries, 'SOLIDMODELS.NUM', 'SOLIDMODEL', 2)) {
      const child = await buildSolidRef(ref, ctx);
      if (!child) continue;
      applyGimTransform(child, transform);
      group.add(child);
    }

    for (const { ref, transform } of modelsAfterCount(entries, 'SUBDEVICES.NUM', 'SUBDEVICE', 2)) {
      const child = await buildDev(`DEV/${ref}`, ctx);
      applyGimTransform(child, transform);
      group.add(child);
    }
    return group;
  })();

  ctx.devCache.set(path, promise);
  return (await promise).clone(true);
}


function normalizeForViewing(group: THREE.Group): THREE.Group {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return group;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 10000 ? 0.001 : 1;

  const wrapper = new THREE.Group();
  wrapper.name = group.name;
  group.position.sub(center);
  wrapper.scale.setScalar(scale);
  wrapper.add(group);
  console.info(`GIM 原生几何: 已居中显示，原始包围盒尺寸 ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}，显示缩放 ${scale}`);
  return wrapper;
}

async function addRenderableCbmNode(node: CbmNode | null, root: THREE.Group, buildCtx: BuildContext): Promise<boolean> {
  if (!node) return false;

  // Prefer the node's OBJECTMODELPOINTER as the complete device model. If it
  // really contains renderable geometry, do not render SUBDEVICES again; those
  // children are often engineering/property children and double-rendering them
  // is the main cause of severe part drift. If the pointed DEV is only a shell
  // or metadata file, recurse into children so single-device packages whose
  // actual geometry lives in child nodes do not become blank.
  if (node.devPath) {
    const dev = await buildDev(`DEV/${node.devPath}`, buildCtx);
    if (dev.children.length > 0) {
      dev.name = node.name;
      applyGimTransform(dev, node.transformMatrix);
      root.add(dev);
      return true;
    }
  }

  let added = false;
  for (const child of node.children) {
    added = (await addRenderableCbmNode(child, root, buildCtx)) || added;
  }
  return added;
}

export async function loadGimGeometryModel(ctx: ViewerContext, state: AppState, files: Map<string, File>): Promise<string | null> {
  let root = new THREE.Group();
  root.name = 'GIM 几何模型';
  const buildCtx: BuildContext = { files, pathIndex: makePathIndex(files), modCache: new Map(), phmCache: new Map(), devCache: new Map(), stlCache: new Map() };
  await addRenderableCbmNode(state.currentCbmTree, root, buildCtx);

  // Some GIM variants, especially line projects, use CBM hierarchy keys that are not
  // part of the common substation subset. If the CBM walk did not produce renderable
  // device nodes, fall back to top-level DEV models instead of every nested DEV,
  // avoiding duplicate child devices that drift the assembled model.
  if (root.children.length === 0) {
    for (const devPath of await collectRootDevPaths(buildCtx)) {
      const dev = await buildDev(devPath, buildCtx);
      if (dev.children.length === 0) continue;
      dev.name = devPath.split('/').pop() || devPath;
      root.add(dev);
    }
  }

  if (root.children.length === 0) {
    for (const phmPath of refsInFolder(buildCtx, 'PHM', '.phm')) {
      const phm = await buildPhm(phmPath, buildCtx);
      if (phm.children.length === 0) continue;
      phm.name = phmPath.split('/').pop() || phmPath;
      root.add(phm);
    }
  }

  if (root.children.length === 0) {
    for (const modPath of refsInFolder(buildCtx, 'MOD', '.mod')) {
      const mod = await buildMod(modPath, buildCtx);
      if (mod.children.length === 0) continue;
      mod.name = modPath.split('/').pop() || modPath;
      root.add(mod);
    }
  }

  if (root.children.length === 0) return null;
  root = normalizeForViewing(root);
  const modelId = 'GIM 几何模型';
  ctx.gimModels.set(modelId, root);
  (ctx.world.scene as any).three.add(root);
  state.loadedModels.set(modelId, { modelId, visible: true });
  return modelId;
}
