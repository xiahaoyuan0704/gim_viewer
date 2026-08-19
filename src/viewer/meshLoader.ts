import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { addModelToUI } from '../ui/modelList.js';

/** Load an STL mesh. SVC is accepted when it uses STL-compatible mesh payloads. */
export function loadMeshBuffer(ctx: ViewerContext, state: AppState, name: string, buffer: ArrayBuffer): void {
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ color: 0x4d9dff, roughness: 0.64, metalness: 0.12 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  const root = new THREE.Group();
  root.name = name;
  root.add(mesh);
  ((ctx.world.scene as any).three as THREE.Scene).add(root);
  state.loadedMeshModels.set(name, { modelId: name, root, visible: true });
  addModelToUI(ctx, state, name);
  ctx.fragments.core.update(true);
}

/** Dispose all standalone mesh models when the scene is cleared. */
export function clearMeshModels(state: AppState): void {
  for (const entry of state.loadedMeshModels.values()) {
    entry.root.removeFromParent();
    entry.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  }
  state.loadedMeshModels.clear();
}
