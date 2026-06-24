import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { parseKeyValue } from '../gim/cbmParser.js';

const IDENTITY = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

type BuildContext = {
  files: Map<string, File>;
  modCache: Map<string, Promise<THREE.Object3D>>;
  phmCache: Map<string, Promise<THREE.Object3D>>;
  devCache: Map<string, Promise<THREE.Object3D>>;
};

function nums(value: string | null | undefined): number[] {
  return (value || '').split(/[;,\s]+/).map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function matrixFromString(value: string | null | undefined): THREE.Matrix4 {
  const n = nums(value || IDENTITY);
  const m = n.length >= 16 ? n.slice(0, 16) : nums(IDENTITY);
  return new THREE.Matrix4().set(
    m[0], m[1], m[2], m[3],
    m[4], m[5], m[6], m[7],
    m[8], m[9], m[10], m[11],
    m[12], m[13], m[14], m[15],
  );
}

function colorMaterial(colorEl?: Element | null, override?: string): THREE.Material {
  let r = 170; let g = 170; let b = 170; let a = 100;
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

function geometryFromEntity(entity: Element): THREE.BufferGeometry | null {
  const cuboid = entity.querySelector('Cuboid');
  if (cuboid) {
    return new THREE.BoxGeometry(
      Number(cuboid.getAttribute('L') || 1),
      Number(cuboid.getAttribute('W') || 1),
      Number(cuboid.getAttribute('H') || 1),
    );
  }

  const cylinder = entity.querySelector('Cylinder');
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

  const bushing = entity.querySelector('PorcelainBushing');
  if (bushing) {
    const r = Number(bushing.getAttribute('R') || 20);
    const r1 = Number(bushing.getAttribute('R1') || r * 1.3);
    const h = Number(bushing.getAttribute('H') || 100);
    const geo = new THREE.CylinderGeometry(r1, r, h, 32);
    geo.rotateX(Math.PI / 2);
    return geo;
  }

  const stretched = entity.querySelector('StretchedBody');
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

async function loadText(files: Map<string, File>, path: string): Promise<string | null> {
  const file = files.get(path);
  return file ? file.text() : null;
}

async function buildMod(path: string, ctx: BuildContext, overrideColor?: string): Promise<THREE.Object3D> {
  const cached = ctx.modCache.get(`${path}|${overrideColor || ''}`);
  if (cached) return (await cached).clone(true);

  const promise = (async () => {
    const text = await loadText(ctx.files, path);
    const group = new THREE.Group();
    group.name = path;
    if (!text) return group;

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    for (const entity of Array.from(doc.querySelectorAll('Entity'))) {
      if ((entity.getAttribute('Visible') || 'True').toLowerCase() === 'false') continue;
      const geo = geometryFromEntity(entity);
      if (!geo) continue;
      const mat = colorMaterial(entity.querySelector('Color'), overrideColor);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${path}#${entity.getAttribute('ID') || ''}`;
      mesh.applyMatrix4(matrixFromString(entity.querySelector('TransformMatrix')?.getAttribute('Value')));
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
    const text = await loadText(ctx.files, path);
    const group = new THREE.Group();
    group.name = path;
    if (!text) return group;

    const kv = parseKeyValue(text);
    const count = Number(kv['SOLIDMODELS.NUM'] || 0);
    for (let i = 0; i < count; i++) {
      const ref = kv[`SOLIDMODEL${i}`];
      if (!ref) continue;
      let child: THREE.Object3D | null = null;
      if (/\.mod$/i.test(ref)) child = await buildMod(`MOD/${ref}`, ctx, kv[`COLOR${i}`]);
      else if (/\.phm$/i.test(ref)) child = await buildPhm(`PHM/${ref}`, ctx);
      if (!child) continue;
      child.applyMatrix4(matrixFromString(kv[`TRANSFORMMATRIX${i}`]));
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
    const text = await loadText(ctx.files, path);
    const group = new THREE.Group();
    group.name = path;
    if (!text) return group;

    const kv = parseKeyValue(text);
    const solidCount = Number(kv['SOLIDMODELS.NUM'] || 0);
    for (let i = 0; i < solidCount; i++) {
      const ref = kv[`SOLIDMODEL${i}`];
      if (!ref) continue;
      const child = await buildPhm(`PHM/${ref}`, ctx);
      child.applyMatrix4(matrixFromString(kv[`TRANSFORMMATRIX${i}`]));
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

function collectDeviceNodes(node: CbmNode | null, out: CbmNode[] = []): CbmNode[] {
  if (!node) return out;
  if (node.devPath) out.push(node);
  for (const child of node.children) collectDeviceNodes(child, out);
  return out;
}

export async function loadGimGeometryModel(ctx: ViewerContext, state: AppState, files: Map<string, File>): Promise<string | null> {
  const root = new THREE.Group();
  root.name = 'GIM 几何模型';
  const buildCtx: BuildContext = { files, modCache: new Map(), phmCache: new Map(), devCache: new Map() };
  const nodes = collectDeviceNodes(state.currentCbmTree);

  for (const node of nodes) {
    const dev = await buildDev(`DEV/${node.devPath}`, buildCtx);
    if (dev.children.length === 0) continue;
    dev.name = node.name;
    dev.applyMatrix4(matrixFromString(node.transformMatrix));
    root.add(dev);
  }

  if (root.children.length === 0) return null;
  const modelId = 'GIM 几何模型';
  ctx.gimModels.set(modelId, root);
  (ctx.world.scene as any).three.add(root);
  state.loadedModels.set(modelId, { modelId, visible: true });
  return modelId;
}
