import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseKeyValue } from '../gim/cbmParser.js';

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

function childByTag(entity: Element, tagName: string): Element | null {
  const lower = tagName.toLowerCase();
  return Array.from(entity.children).find((child) => child.tagName.toLowerCase() === lower) ?? null;
}

function nums(value: string | null | undefined): number[] {
  return (value || '').split(/[;,\s]+/).map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function signedScale(axis: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const sign = Math.sign(new THREE.Vector3().crossVectors(a, b).dot(axis)) || 1;
  return axis.length() * sign;
}

function applyGimTransform(object: THREE.Object3D, value: string | null | undefined): void {
  const n = nums(value || IDENTITY);
  const m = n.length >= 16 ? n.slice(0, 16) : nums(IDENTITY);

  const rightRaw = new THREE.Vector3(m[0], m[4], m[8]);
  const upRaw = new THREE.Vector3(m[1], m[5], m[9]);
  const forwardRaw = new THREE.Vector3(m[2], m[6], m[10]);

  const sx = signedScale(rightRaw, upRaw, forwardRaw);
  const sy = signedScale(upRaw, forwardRaw, rightRaw);
  const sz = signedScale(forwardRaw, rightRaw, upRaw);

  if (Math.abs(sx) < 1e-6 || Math.abs(sy) < 1e-6 || Math.abs(sz) < 1e-6) {
    object.position.set(m[3], m[7], m[11]);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
    return;
  }

  const forward = forwardRaw.clone().divideScalar(sz).normalize();
  const up = upRaw.clone().divideScalar(sy);
  up.addScaledVector(forward, -up.dot(forward)).normalize();
  const right = new THREE.Vector3().crossVectors(up, forward).normalize();

  const rot = new THREE.Matrix4().makeBasis(right, up, forward);
  object.position.set(m[3], m[7], m[11]);
  object.quaternion.setFromRotationMatrix(rot);
  object.scale.set(sx, sy, sz);
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
    const r = Number(bushing.getAttribute('R') || 20);
    const r1 = Number(bushing.getAttribute('R1') || r * 1.3);
    const h = Number(bushing.getAttribute('H') || 100);
    const geo = new THREE.CylinderGeometry(r1, r, h, 32);
    geo.rotateX(Math.PI / 2);
    return geo;
  }

  const stretched = childByTag(entity, 'StretchedBody');
  if (stretched) {
    const points = (stretched.getAttribute('Array') || '').split(';')
      .map((p) => nums(p)).filter((p) => p.length >= 2)
      .map((p) => new THREE.Vector2(p[0], p[1]));
    if (points.length >= 3) {
      const shape = new THREE.Shape(points);
      return new THREE.ExtrudeGeometry(shape, { depth: Number(stretched.getAttribute('L') || 1), bevelEnabled: false });
    }
  }

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
    for (const entity of entities) {
      if ((entity.getAttribute('Visible') || 'True').toLowerCase() === 'false') continue;
      const geo = geometryFromEntity(entity);
      if (!geo) continue;
      const mat = colorMaterial(childByTag(entity, 'Color'), overrideColor);
      const mesh = decorateMesh(new THREE.Mesh(geo, mat));
      mesh.name = `${path}#${entity.getAttribute('ID') || ''}`;
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

    const kv = parseKeyValue(text);
    const count = Number(kv['SOLIDMODELS.NUM'] || 0);
    for (let i = 0; i < count; i++) {
      const ref = kv[`SOLIDMODEL${i}`];
      if (!ref) continue;
      const child = await buildSolidRef(ref, ctx, kv[`COLOR${i}`]);
      if (!child) continue;
      applyGimTransform(child, kv[`TRANSFORMMATRIX${i}`]);
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

    const kv = parseKeyValue(text);
    const solidCount = Number(kv['SOLIDMODELS.NUM'] || 0);
    for (let i = 0; i < solidCount; i++) {
      const ref = kv[`SOLIDMODEL${i}`];
      if (!ref) continue;
      const child = await buildSolidRef(ref, ctx);
      if (!child) continue;
      applyGimTransform(child, kv[`TRANSFORMMATRIX${i}`]);
      group.add(child);
    }

    const subCount = Number(kv['SUBDEVICES.NUM'] || 0);
    for (let i = 0; i < subCount; i++) {
      const ref = kv[`SUBDEVICES${i}`] || kv[`SUBDEVICE${i}`];
      if (!ref) continue;
      group.add(await buildDev(`DEV/${ref}`, ctx));
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

function collectDeviceNodes(node: CbmNode | null, out: CbmNode[] = []): CbmNode[] {
  if (!node) return out;
  if (node.devPath) out.push(node);
  for (const child of node.children) collectDeviceNodes(child, out);
  return out;
}

export async function loadGimGeometryModel(ctx: ViewerContext, state: AppState, files: Map<string, File>): Promise<string | null> {
  let root = new THREE.Group();
  root.name = 'GIM 几何模型';
  const buildCtx: BuildContext = { files, pathIndex: makePathIndex(files), modCache: new Map(), phmCache: new Map(), devCache: new Map(), stlCache: new Map() };
  const nodes = collectDeviceNodes(state.currentCbmTree);

  if (nodes.length > 0) {
    for (const node of nodes) {
      const dev = await buildDev(`DEV/${node.devPath}`, buildCtx);
      if (dev.children.length === 0) continue;
      dev.name = node.name;
      applyGimTransform(dev, node.transformMatrix);
      root.add(dev);
    }
  }

  // Some GIM variants, especially line projects, use CBM hierarchy keys that are not
  // part of the common substation subset. If the CBM walk did not produce renderable
  // device nodes, fall back to rendering every DEV model found in the package.
  if (root.children.length === 0) {
    for (const devPath of refsInFolder(buildCtx, 'DEV', '.dev')) {
      const dev = await buildDev(devPath, buildCtx);
      if (dev.children.length === 0) continue;
      dev.name = devPath.split('/').pop() || devPath;
      root.add(dev);
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
