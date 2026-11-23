import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CameraSnapshot, Ref, Vec3 } from '@archcanvas/contracts';
import {
  archPointToThree,
  threeCameraToArchSnapshot,
  threePointToArch,
} from './cameraAdapter.js';

export interface Viewport3DProps {
  glbBuffer: ArrayBuffer | null;
  sceneRef: Ref;
  defaultWidthPx?: number;
  defaultHeightPx?: number;
  onSaveCamera: (snapshot: CameraSnapshot) => void;
}

type PresetId = 'human_se' | 'aerial_nw' | 'top_plan' | 'south_elev' | 'east_elev';

export const Viewport3D: React.FC<Viewport3DProps> = ({
  glbBuffer,
  sceneRef,
  defaultWidthPx = 1280,
  defaultHeightPx = 720,
  onSaveCamera,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRootRef = useRef<THREE.Object3D | null>(null);
  const modelCenterArchRef = useRef<Vec3>([5, 3, 2.25]);
  const modelRadiusRef = useRef<number>(8);

  const [cameraName, setCameraName] = useState('南东人视 1.6m');
  const [hideRoofCap, setHideRoofCap] = useState(false);
  const [eyeReadout, setEyeReadout] = useState<Vec3>([14, -8, 1.6]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 520;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#141921');

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 500);
    camera.position.copy(archPointToThree([14, -8, 1.6]));
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(archPointToThree([5, 3, 2.0]));
    controls.update();
    controlsRef.current = controls;

    // 地面网格与坐标轴
    const grid = new THREE.GridHelper(40, 40, '#3b4a5e', '#222b37');
    scene.add(grid);
    const axes = new THREE.AxesHelper(3);
    scene.add(axes);

    // 建筑工作室灯光
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(18, 26, 14);
    scene.add(dir);

    let disposed = false;
    let rafId = 0;

    const animate = () => {
      if (disposed) return;
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    controls.addEventListener('change', () => {
      const archEye = threePointToArch(camera.position);
      setEyeReadout([
        Number(archEye[0].toFixed(2)),
        Number(archEye[1].toFixed(2)),
        Number(archEye[2].toFixed(2)),
      ]);
    });

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 520;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    if (glbBuffer) {
      const loader = new GLTFLoader();
      loader.parse(
        glbBuffer,
        '',
        (gltf) => {
          if (disposed) return;
          setLoadError(null);
          modelRootRef.current = gltf.scene;
          scene.add(gltf.scene);

          const box = new THREE.Box3().setFromObject(gltf.scene);
          if (!box.isEmpty()) {
            const centerThree = box.getCenter(new THREE.Vector3());
            const sizeThree = box.getSize(new THREE.Vector3());
            const radius = Math.max(sizeThree.length() * 0.5, 4);
            modelCenterArchRef.current = threePointToArch(centerThree);
            modelRadiusRef.current = radius;

            const c = modelCenterArchRef.current;
            camera.position.copy(archPointToThree([c[0] + radius * 1.15, c[1] - radius * 1.35, 1.6]));
            controls.target.copy(archPointToThree([c[0], c[1], Math.min(c[2], 2.0)]));
            controls.update();
          }
        },
        (err) => {
          setLoadError(`无法加载 GLB 预览模型：${String(err)}`);
        }
      );
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      controls.dispose();
      renderer.dispose();
    };
  }, [glbBuffer]);

  useEffect(() => {
    const root = modelRootRef.current;
    if (!root) return;
    root.traverse((obj) => {
      if (obj.name.toLowerCase().includes('roof_cap')) {
        obj.visible = !hideRoofCap;
      }
    });
  }, [hideRoofCap]);

  const applyPreset = (preset: PresetId) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const c = modelCenterArchRef.current;
    const r = modelRadiusRef.current;

    if (preset === 'human_se') {
      camera.position.copy(archPointToThree([c[0] + r * 1.15, c[1] - r * 1.35, 1.6]));
      controls.target.copy(archPointToThree([c[0], c[1], 1.8]));
      setCameraName('南东人视 1.6m');
    } else if (preset === 'aerial_nw') {
      camera.position.copy(archPointToThree([c[0] - r * 1.4, c[1] + r * 1.4, r * 1.25]));
      controls.target.copy(archPointToThree([c[0], c[1], c[2]]));
      setCameraName('西北 45° 鸟瞰');
    } else if (preset === 'top_plan') {
      camera.position.copy(archPointToThree([c[0], c[1] - 0.01, r * 2.4]));
      controls.target.copy(archPointToThree([c[0], c[1], 0]));
      setCameraName('平面俯视');
    } else if (preset === 'south_elev') {
      camera.position.copy(archPointToThree([c[0], c[1] - r * 1.8, c[2]]));
      controls.target.copy(archPointToThree([c[0], c[1], c[2]]));
      setCameraName('南立面正视');
    } else if (preset === 'east_elev') {
      camera.position.copy(archPointToThree([c[0] + r * 1.8, c[1], c[2]]));
      controls.target.copy(archPointToThree([c[0], c[1], c[2]]));
      setCameraName('东立面正视');
    }
    controls.update();
  };

  const handleSaveSnapshot = () => {
    const camera = cameraRef.current;
    if (!camera) return;
    const snapshot = threeCameraToArchSnapshot({
      id: `cam-${Date.now().toString(36)}`,
      name: cameraName.trim() || '未命名视角',
      scene: sceneRef,
      camera,
      widthPx: defaultWidthPx,
      heightPx: defaultHeightPx,
    });
    onSaveCamera(snapshot);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => applyPreset('human_se')}>南东人视 (1.6m)</button>
          <button onClick={() => applyPreset('aerial_nw')}>西北鸟瞰</button>
          <button onClick={() => applyPreset('top_plan')}>平面俯视</button>
          <button onClick={() => applyPreset('south_elev')}>南立面</button>
          <button onClick={() => applyPreset('east_elev')}>东立面</button>
          <button onClick={() => setHideRoofCap((v) => !v)}>
            {hideRoofCap ? '恢复顶板' : '揭顶显示'}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            value={cameraName}
            onChange={(e) => setCameraName(e.target.value)}
            placeholder="相机名称"
            style={{
              width: 140,
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid #2d3748',
              background: '#0f1216',
              color: '#eef2f7',
              fontSize: 12,
            }}
          />
          <button className="primary" onClick={handleSaveSnapshot}>
            保存当前视角为画框
          </button>
        </div>
      </div>

      <div style={{ fontSize: 11, color: '#9aa7b8' }}>
        当前相机眼位（建筑 Z-up 米）：X={eyeReadout[0]}m, Y={eyeReadout[1]}m, Z={eyeReadout[2]}m · 左键环绕 / 右键平移 / 滚轮缩放
      </div>

      {loadError && <div style={{ color: '#fca5a5', fontSize: 12 }}>{loadError}</div>}

      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 420,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid #2d3748',
        }}
      />
    </div>
  );
};
