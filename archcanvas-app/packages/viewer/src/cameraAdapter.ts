import * as THREE from 'three';
import type { CameraSnapshot, Mat4, Ref, Vec3 } from '@archcanvas/contracts';
import { SCHEMA_VERSION } from '@archcanvas/contracts';

export const PROJECTION_ADAPTER_VERSION = 'arch-zup-three-yup-v1';

/**
 * 旋转矩阵：Three.js / glTF (Y-up) -> 建筑域 / Blender (Z-up)
 * (x, y, z)_three -> (x, -z, y)_arch，即绕 X 轴旋转 +90°
 */
const RX_POS_90 = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/**
 * 旋转矩阵：建筑域 / Blender (Z-up) -> Three.js / glTF (Y-up)
 * (x, y, z)_arch -> (x, z, -y)_three，即绕 X 轴旋转 -90°
 */
const RX_NEG_90 = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

export function archPointToThree(pt: Vec3): THREE.Vector3 {
  return new THREE.Vector3(pt[0], pt[2], -pt[1]);
}

export function threePointToArch(v: THREE.Vector3): Vec3 {
  return [v.x, -v.z, v.y];
}

export function threeMatrixToArchMatrix(matrixWorld: THREE.Matrix4): Mat4 {
  const archMat = new THREE.Matrix4().multiplyMatrices(RX_POS_90, matrixWorld);
  return Array.from(archMat.elements);
}

export function archMatrixToThreeMatrix(elementsColMajor: Mat4): THREE.Matrix4 {
  const archMat = new THREE.Matrix4().fromArray(elementsColMajor);
  return new THREE.Matrix4().multiplyMatrices(RX_NEG_90, archMat);
}

/**
 * 在建筑 Z-up 坐标系下构造标准的右手相机世界矩阵（局部 -Z 朝向目标，局部 +Y 为上）
 */
export function buildArchLookAtMatrix(
  eyeArch: Vec3,
  targetArch: Vec3,
  upArch: Vec3 = [0, 0, 1]
): Mat4 {
  const eye = new THREE.Vector3(...eyeArch);
  const target = new THREE.Vector3(...targetArch);
  const up = new THREE.Vector3(...upArch).normalize();

  const zAxis = new THREE.Vector3().subVectors(eye, target).normalize(); // camera +Z (backward)
  let xAxis = new THREE.Vector3().crossVectors(up, zAxis);
  if (xAxis.lengthSq() < 1e-8) {
    // 俯视或仰视与 Z 轴共线时，改用 +Y（北向）作为参考上方向
    xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis);
  }
  xAxis.normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

  const mat = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  mat.setPosition(eye);
  return Array.from(mat.elements);
}

/**
 * 从 Three.js 透视或正交相机提取标准 CameraSnapshot（建筑 Z-up 域，可直接送入 Blender 渲染）
 */
export function threeCameraToArchSnapshot(opts: {
  id: string;
  name: string;
  scene: Ref;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  widthPx: number;
  heightPx: number;
  sensorWidthMm?: number;
}): CameraSnapshot {
  const { id, name, scene, camera, widthPx, heightPx, sensorWidthMm = 36 } = opts;
  camera.updateMatrixWorld(true);
  const matrixWorld = threeMatrixToArchMatrix(camera.matrixWorld);

  if (camera instanceof THREE.PerspectiveCamera) {
    const aspect = widthPx / heightPx;
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    // 按水平传感器宽度（36mm 全画幅默认）换算 Blender 焦距
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
    const focalLengthMm = sensorWidthMm / (2 * Math.tan(hFovRad / 2));

    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      name,
      scene,
      projection: 'perspective',
      matrixWorld,
      coordinateConvention: 'architecture-z-up',
      projectionAdapterVersion: PROJECTION_ADAPTER_VERSION,
      perspective: {
        focalLengthMm: Number(focalLengthMm.toFixed(4)),
        sensorWidthMm,
        sensorFit: 'horizontal',
        shiftX: 0,
        shiftY: 0,
      },
      nearM: camera.near,
      farM: camera.far,
      widthPx,
      heightPx,
    };
  }

  const widthM = Math.abs(camera.right - camera.left) / camera.zoom;
  const heightM = Math.abs(camera.top - camera.bottom) / camera.zoom;
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    scene,
    projection: 'orthographic',
    matrixWorld,
    coordinateConvention: 'architecture-z-up',
    projectionAdapterVersion: PROJECTION_ADAPTER_VERSION,
    orthographic: {
      widthM: Number(widthM.toFixed(4)),
      heightM: Number(heightM.toFixed(4)),
    },
    nearM: camera.near,
    farM: camera.far,
    widthPx,
    heightPx,
  };
}
