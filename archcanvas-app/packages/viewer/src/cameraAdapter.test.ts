import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  archMatrixToThreeMatrix,
  archPointToThree,
  buildArchLookAtMatrix,
  threeCameraToArchSnapshot,
  threeMatrixToArchMatrix,
  threePointToArch,
} from './cameraAdapter.js';

describe('@archcanvas/viewer cameraAdapter', () => {
  it('round-trips points between architecture Z-up and Three.js Y-up', () => {
    const pArch: [number, number, number] = [10, 6, 4.5];
    const pThree = archPointToThree(pArch);
    expect(pThree.x).toBeCloseTo(10, 6);
    expect(pThree.y).toBeCloseTo(4.5, 6);
    expect(pThree.z).toBeCloseTo(-6, 6);

    const back = threePointToArch(pThree);
    expect(back[0]).toBeCloseTo(10, 6);
    expect(back[1]).toBeCloseTo(6, 6);
    expect(back[2]).toBeCloseTo(4.5, 6);
  });

  it('converts Three.js perspective camera into exact architecture Z-up CameraSnapshot', () => {
    const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 300);
    cam.position.copy(archPointToThree([5, -10, 1.6]));
    cam.lookAt(archPointToThree([5, 3, 1.6]));
    cam.updateMatrixWorld(true);

    const snap = threeCameraToArchSnapshot({
      id: 'cam-1',
      name: '南侧人视',
      scene: { id: 'scene-1', version: '1', sha256: 'a'.repeat(64) },
      camera: cam,
      widthPx: 1920,
      heightPx: 1080,
    });

    expect(snap.coordinateConvention).toBe('architecture-z-up');
    expect(snap.matrixWorld).toHaveLength(16);
    // Position in column-major matrixWorld is indices 12, 13, 14
    expect(snap.matrixWorld[12]).toBeCloseTo(5, 4);
    expect(snap.matrixWorld[13]).toBeCloseTo(-10, 4);
    expect(snap.matrixWorld[14]).toBeCloseTo(1.6, 4);

    // Round-trip back to Three.js matrix
    const backThree = archMatrixToThreeMatrix(snap.matrixWorld);
    const backArch = threeMatrixToArchMatrix(backThree);
    for (let i = 0; i < 16; i++) {
      expect(backArch[i]).toBeCloseTo(snap.matrixWorld[i]!, 5);
    }
  });

  it('builds valid Z-up lookAt matrix for Blender rendering', () => {
    const m = buildArchLookAtMatrix([14, -8, 1.6], [5, 3, 2.0]);
    expect(m).toHaveLength(16);
    expect(m[12]).toBeCloseTo(14, 5);
    expect(m[13]).toBeCloseTo(-8, 5);
    expect(m[14]).toBeCloseTo(1.6, 5);
  });
});
