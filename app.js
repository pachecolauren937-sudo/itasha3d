import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { DRACOLoader } from './vendor/DRACOLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { DecalGeometry } from './vendor/DecalGeometry.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

// Swap this one path when the production Taycan GLB is ready.
const MODEL_PATH = './assets/taycan_f.glb';
// The four artwork pieces the client already supplied, one per face.
const PRESETS = {
  left:  './assets/livery/processed/left.png',
  right: './assets/livery/processed/right.png',
  hood:  './assets/livery/processed/hood.png?full-panel-scale-v3',
  rear:  './assets/livery/processed/rear.png?full-panel-scale-v3'
};
// Some mobile browsers mis-report 100dvh and collapse the layout to zero height.
// Measure the real viewport and feed it to CSS instead of trusting dvh.
function syncViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (h > 100) document.documentElement.style.setProperty('--app-h', h + 'px');
}
syncViewportHeight();
addEventListener('resize', syncViewportHeight);
addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 150));
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewportHeight);

const viewport = document.querySelector('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#111318');
scene.fog = new THREE.Fog('#111318', 10, 25);
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xc9d9ff, 0x24202a, 1.7));
const key = new THREE.DirectionalLight(0xffe4d2, 3.2); key.position.set(-4, 7, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.00015; scene.add(key);
const fill = new THREE.DirectionalLight(0x9cc6ff, 2.2); fill.position.set(5, 3, -4); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 2.7); rim.position.set(2, 5, 5); scene.add(rim);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.34, metalness: 0.18 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -0.015; floor.receiveShadow = true; scene.add(floor);
const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.2, 64), new THREE.ShadowMaterial({ opacity: 0.24 })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002; shadow.scale.set(1.25, .52, 1); scene.add(shadow);

const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true; orbit.dampingFactor = .06; orbit.minPolarAngle = Math.PI * .18; orbit.maxPolarAngle = Math.PI * .49; orbit.minDistance = 3.8; orbit.maxDistance = 12; orbit.target.set(0, .55, 0);
let carRoot, bodyMesh, carBounds, decalMesh, imageTexture, imageUrl, imageInfo = null;
let sourceBodyMaterial = null, projectedMaterial = null, projectedSide = null;
const projectedDecalMeshes = [];
const glassSourceMaterials = new Map();
let bodyZMin = -2.48, bodyZMax = 2.48;
let projectionCameras = null, projectedTexture = null, loadedPresetImage = null;
const requestedShot = new URLSearchParams(location.search).get('shot');
const shotSide = requestedShot === 'front' ? 'hood' : requestedShot;
const state = { side: ['left','right','hood','rear'].includes(shotSide) ? shotSide : 'right', x: 0, y: 0, z: 0, scale: 1.0, rotation: 0 };
if (shotSide) document.documentElement.classList.add('render-shot');
let shotModelReady=false, shotCameraReady=false, shotImageReady=false, resolveShotReady;
const shotReady=new Promise(resolve=>{resolveShotReady=resolve;});
function checkShotReady(){if(shotSide&&shotModelReady&&shotCameraReady&&shotImageReady){flyToSide(state.side);renderer.render(scene,camera);window.__liveryReady=true;resolveShotReady();}}
const up = new THREE.Vector3(0, 1, 0);

const draco = new DRACOLoader();
draco.setDecoderPath('./vendor/draco/');
const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
loader.load(MODEL_PATH, (gltf) => {
  carRoot = gltf.scene;
  // Keep source transforms intact; the GLB is already authored in its display orientation.
  carRoot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true;
    if (bodyMesh) return;
    if (o.name.toLowerCase() === 'body') { bodyMesh = o; return; }
    // Taycan GLB: the paint surface is the mesh whose material is named "corpus1".
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    if (mats.some(m => /corpus/i.test(m.name || ''))) bodyMesh = o;
  } });
  carRoot.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    if (mats.some(m => /^(glass2|Black_glass1)$/i.test(m.name || ''))) glassSourceMaterials.set(o, o.material);
  });
  scene.add(carRoot);
  if (!bodyMesh) bodyMesh = findLargestMesh(carRoot);
  sourceBodyMaterial = bodyMesh.material;
  window.__sourceBodyMaterial = sourceBodyMaterial;
  window.__glassMeshes = [...glassSourceMaterials.keys()];
  fetch('./assets/livery/processed/cameras.json').then(r => r.json()).then(data => { projectionCameras = data.cameras; shotCameraReady=true; if (presetMode && loadedPresetImage) applyProjectedPreset(state.side, loadedPresetImage); checkShotReady(); }).catch(err => console.warn('Camera metadata unavailable; using upload decal mode', err));
  carRoot.updateMatrixWorld(true);
  carBounds = new THREE.Box3().setFromObject(carRoot);
  const size = carBounds.getSize(new THREE.Vector3());
  const center = carBounds.getCenter(new THREE.Vector3());
  // Ground the model by its actual bounds and frame it with a little breathing room.
  carRoot.position.y -= carBounds.min.y;
  carRoot.updateMatrixWorld(true);
  carBounds.setFromObject(carRoot);
  const bodyBounds = new THREE.Box3().setFromObject(bodyMesh);
  bodyZMin = bodyBounds.min.z;
  bodyZMax = bodyBounds.max.z;
  installBodyGradient(sourceBodyMaterial);
  orbit.target.set(center.x, (carBounds.min.y + carBounds.max.y) * .5, center.z);
  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * .5))) * 1.12;
  camera.position.set(-distance * .78, distance * .48, distance * 1.0); camera.near = Math.max(.01, maxDim / 100); camera.far = maxDim * 25; camera.updateProjectionMatrix(); orbit.update();
  shadow.position.set(center.x, carBounds.min.y + .004, center.z);
  shadow.scale.set(size.x * .34, size.z * .31, 1);
  document.querySelector('#loadState').classList.add('hidden');
  window.__scene = scene; window.__body = bodyMesh; window.__car = carRoot; window.__cam = camera; window.__orbit = orbit; window.__renderer = renderer;
  // Show the client's own artwork straight away — no upload needed.
  loadPreset(state.side);
  buildDecal();
  shotModelReady=true; checkShotReady();
  setTimeout(() => { flyToSide(state.side); if (shotSide) renderer.render(scene, camera); }, 60);
}, undefined, (err) => { console.error('Model load failed', err); document.querySelector('#loadState').innerHTML = '<span>模型载入失败，请通过本地 HTTP 服务打开页面。</span>'; });

function findLargestMesh(root) {
  // Fallback for a future GLB without the documented `body` mesh: select the mesh with greatest surface area.
  let best = null, bestArea = -1;
  root.traverse(o => { if (!o.isMesh) return; const p = o.geometry.attributes.position; let area = 0; const idx = o.geometry.index;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < (idx ? idx.count : p.count); i += 3) { const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2; a.fromBufferAttribute(p, ia); b.fromBufferAttribute(p, ib); c.fromBufferAttribute(p, ic); area += b.clone().sub(a).cross(c.clone().sub(a)).length() * .5; }
    if (area > bestArea) { bestArea = area; best = o; }
  }); return best;
}
function installBodyGradient(material) {
  const mats = Array.isArray(material) ? material : [material];
  for (const mat of mats) {
    mat.onBeforeCompile = shader => {
      shader.uniforms.uBodyZ = { value: new THREE.Vector2(bodyZMin, bodyZMax) };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vBodyWorldPosition;`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nvBodyWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vBodyWorldPosition; uniform vec2 uBodyZ;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\nfloat bodyT = smoothstep((uBodyZ.y-uBodyZ.x)*0.25,(uBodyZ.y-uBodyZ.x)*0.70,uBodyZ.y-vBodyWorldPosition.z);\ndiffuseColor.rgb = mix(vec3(1.0,0.995,0.975),vec3(0.015,0.43,0.86),bodyT);`);
    };
    mat.customProgramCacheKey = () => 'corpus1-continuous-world-z-gradient-v1';
    mat.needsUpdate = true;
  }
}
function decalPose() {
  const b = new THREE.Box3().setFromObject(bodyMesh), c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
  // This GLB is authored with length along Z and width along X (car nose toward +Z).
  let normal, pos, horizontal, vertical, span;
  if (state.side === 'left' || state.side === 'right') {
    const sign = state.side === 'left' ? -1 : 1;
    normal = new THREE.Vector3(sign, 0, 0);
    pos = new THREE.Vector3(c.x + sign * s.x * .5, c.y - s.y * .13, c.z + s.z * .02);
    horizontal = new THREE.Vector3(0, 0, 1); vertical = up; span = s.z;
  } else if (state.side === 'hood') {
    normal = new THREE.Vector3(0, 0.62, 0.78).normalize();
    pos = new THREE.Vector3(c.x, c.y + s.y * .38, c.z + s.z * .40);
    horizontal = new THREE.Vector3(1, 0, 0); vertical = new THREE.Vector3(0, -0.78, 0.62).normalize(); span = s.x * 1.18;
  } else if (state.side === 'roof') {
    normal = new THREE.Vector3(0, 1, 0);
    pos = new THREE.Vector3(c.x, c.y + s.y * .5, c.z - s.z * .04);
    horizontal = new THREE.Vector3(1, 0, 0); vertical = new THREE.Vector3(0, 0, 1); span = s.x * 1.3;
  } else {
    normal = new THREE.Vector3(0, 0, -1);
    pos = new THREE.Vector3(c.x, c.y + s.y * .04, c.z - s.z * .46);
    horizontal = new THREE.Vector3(1, 0, 0); vertical = up; span = s.x * 1.5;
  }
  pos.addScaledVector(horizontal, state.x).addScaledVector(vertical, state.y).addScaledVector(normal, state.z);
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  const rot = new THREE.Quaternion().setFromAxisAngle(normal, THREE.MathUtils.degToRad(state.rotation));
  orientation.premultiply(rot);
  return { pos, orientation, size: s, span };
}
function buildDecal() {
  if (presetMode) { if (decalMesh) { scene.remove(decalMesh); decalMesh.geometry.dispose(); decalMesh.material.dispose(); decalMesh = null; } return; }
  if (decalMesh) { scene.remove(decalMesh); decalMesh.geometry.dispose(); decalMesh.material.dispose(); decalMesh = null; }
  if (!bodyMesh || !imageTexture) return;
  const { pos, orientation, size, span } = decalPose();
  const aspect = state.side === 'hood' ? 2.05 : state.side === 'rear' ? 2.25 : (state.side === 'left' || state.side === 'right') ? 4.0 : imageInfo.width / imageInfo.height;
  const width = Math.min(span, 4.6) * state.scale;
  const decalSize = new THREE.Vector3(width, width / aspect, 1.6);
  const euler = new THREE.Euler().setFromQuaternion(orientation, 'XYZ');
  try {
    const geometry = new DecalGeometry(bodyMesh, pos, euler, decalSize);
    // Mirror the artwork horizontally when it lands on the left flank, so the nose of the
    // livery lines up with the nose of the car instead of pointing backwards.
    const tex = imageTexture.clone();
    tex.needsUpdate = true;
    if (state.side === 'left') { tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = -1; tex.offset.x = 1; }
    const material = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: .46, metalness: .04, side: THREE.DoubleSide });
    decalMesh = new THREE.Mesh(geometry, material); decalMesh.renderOrder = 3; scene.add(decalMesh);
    window.__decalDebug = { ok: true, verts: geometry.attributes.position ? geometry.attributes.position.count : 0, pos: pos.toArray(), size: decalSize.toArray(), bodyName: bodyMesh.name, bodyMat: (Array.isArray(bodyMesh.material)?bodyMesh.material[0]:bodyMesh.material).name };
  } catch (e) { console.warn('Decal projection failed', e); window.__decalDebug = { ok: false, error: String(e) }; }
}

// Move the camera so the chosen face is actually in front of the user.
function loadPreset(side) {
  const url = PRESETS[side];
  if (!url) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const name = url.split('/').pop().split('?')[0];
    imageInfo = { name, width: img.naturalWidth, height: img.naturalHeight };
    if (imageTexture) imageTexture.dispose();
    imageTexture = new THREE.Texture(img);
    imageTexture.colorSpace = THREE.SRGBColorSpace;
    imageTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    imageTexture.needsUpdate = true;
    loadedPresetImage = img;
    document.querySelector('#decalName').textContent = name;
    document.querySelector('#decalDimensions').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
    document.querySelector('#decalInfo').classList.add('has-image');
    document.querySelector('.upload-zone').classList.add('has-image');
    applyProjectedPreset(side, img);
    shotImageReady=true; checkShotReady();
    if (shotSide) renderer.render(scene, camera);
  };
  img.src = url;
}
let presetMode = true;

function makeProjectedMaterial(texture, side) {
  const params = projectionCameras?.[side];
  if (!params || !sourceBodyMaterial) return null;
  const base = Array.isArray(sourceBodyMaterial) ? sourceBodyMaterial.map(m => m.clone()) : sourceBodyMaterial.clone();
  const mat = Array.isArray(base) ? base[0] : base;
  // `corpus1` is the continuous painted shell. Use the source photo only as
  // an alpha-masked artwork overlay; its photographed paint/hardware never
  // replaces the model's own parts or the procedural base coat.
  mat.map = texture; mat.color.set(0xffffff); mat.transparent = false; mat.depthWrite = true;
  const K = params.intrinsics_px, R = params.rotation_matrix_world_to_camera, t = params.translation_camera;
  const uniforms = {
    uCamR: { value: new THREE.Matrix3().set(R[0][0],R[0][1],R[0][2],R[1][0],R[1][1],R[1][2],R[2][0],R[2][1],R[2][2]) },
    // The viewer grounds the GLB by moving its lowest bound to y=0. Convert the
    // recovered camera translation into that runtime coordinate frame.
    uCamT: { value: new THREE.Vector3(t[0]-R[0][1]*Math.max(0,-carBounds?.min.y||0),t[1]-R[1][1]*Math.max(0,-carBounds?.min.y||0),t[2]-R[2][1]*Math.max(0,-carBounds?.min.y||0)) },
    uIntrinsics: { value: new THREE.Vector4(K[0][0],K[1][1],K[0][2],K[1][2]) },
    uImageSize: { value: new THREE.Vector2(params.source_dimensions_px[0],params.source_dimensions_px[1]) },
    uLiveryTransform: { value: new THREE.Vector4(1,0,0,0) },
    uBodyZ: { value: new THREE.Vector2(bodyZMin, bodyZMax) }
  };
  const transformUniform = uniforms.uLiveryTransform;
  const updateTransform = () => {
    const radians = THREE.MathUtils.degToRad(state.rotation), s = Math.max(.05,state.scale);
    transformUniform.value.set(s, state.x * .035, state.y * .035, radians);
  };
  updateTransform();
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vLiveryCameraPosition; varying vec3 vLiveryWorldPosition;\nuniform mat3 uCamR; uniform vec3 uCamT;`);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nvec4 liveryWorldPosition = modelMatrix * vec4(transformed, 1.0);\nvLiveryWorldPosition = liveryWorldPosition.xyz;\nvLiveryCameraPosition = uCamR * liveryWorldPosition.xyz + uCamT;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vLiveryCameraPosition; varying vec3 vLiveryWorldPosition;\nuniform vec4 uIntrinsics; uniform vec2 uImageSize; uniform vec4 uLiveryTransform; uniform vec2 uBodyZ;`);
    const leftUvFlip = side === 'left' ? 'puv.x = 1.0 - puv.x;' : '';
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        // White stays through the nose/front third, transitions over the
        // middle, and reaches the final saturated blue before the tail.
        float bodyT = smoothstep((uBodyZ.y-uBodyZ.x)*0.25,
                                (uBodyZ.y-uBodyZ.x)*0.70,
                                uBodyZ.y - vLiveryWorldPosition.z);
        vec3 bodyBase = mix(vec3(1.0, 0.995, 0.975), vec3(0.015, 0.43, 0.86), bodyT);
        diffuseColor.rgb = bodyBase;
        float pz = vLiveryCameraPosition.z;
        vec2 pixel = vec2(uIntrinsics.x*vLiveryCameraPosition.x + uIntrinsics.z*pz, uIntrinsics.y*vLiveryCameraPosition.y + uIntrinsics.w*pz) / max(pz, 0.0001);
        ${side === 'hood' ? 'pixel.y += 90.0 * clamp((vLiveryWorldPosition.y - 0.87) / 0.23, 0.0, 1.0);' : ''}
        vec2 puv = pixel / uImageSize;
        // Projection coordinates use top-left image pixels; WebGL textures use bottom-left UVs.
        puv.y = 1.0 - puv.y;
        // The left shell's lateral projection has the opposite U handedness.
        // Compensate only the sampled artwork; the body and gradient stay in
        // their calibrated world coordinates.
        ${leftUvFlip}
        float cs = cos(uLiveryTransform.w), sn = sin(uLiveryTransform.w);
        puv = (mat2(cs,-sn,sn,cs) * (puv - 0.5) / uLiveryTransform.x) + 0.5 - uLiveryTransform.yz;
        if (pz > 0.0 && puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0) {
          vec4 projectedColor = texture2D(map, puv);
          diffuseColor.rgb = mix(diffuseColor.rgb, projectedColor.rgb, projectedColor.a);
        }
      #endif
    `);
  };
  mat.customProgramCacheKey = () => `ground-truth-projection-${side}`;
  mat.needsUpdate = true;
  mat.userData.liveryProjectionUniforms = uniforms;
  mat.userData.updateLiveryTransform = updateTransform;
  return base;
}

function clearProjectedDecals(restoreGlass = true) {
  for (const mesh of projectedDecalMeshes) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material.map && mesh.material.map !== projectedTexture) mesh.material.map.dispose();
    mesh.material.dispose();
  }
  projectedDecalMeshes.length = 0;
  if (restoreGlass) for (const [mesh, material] of glassSourceMaterials) mesh.material = material;
}

function applyProjectedPreset(side, img) {
  clearProjectedDecals(true);
  if (projectedTexture) projectedTexture.dispose();
  projectedTexture = new THREE.Texture(img); projectedTexture.colorSpace = THREE.SRGBColorSpace;
  projectedTexture.anisotropy = renderer.capabilities.getMaxAnisotropy(); projectedTexture.needsUpdate = true;
  projectedSide = side;
  if (side === 'left' || side === 'right') {
    if (projectedMaterial) { bodyMesh.material = sourceBodyMaterial; projectedMaterial = null; }
    // Side artwork is projected onto the painted body shell only. The two
    // glazing meshes are deliberately excluded from the target set.
    const glassNames = new Set(['mesh_2', 'mesh_2_2']);
    const targetNames = [bodyMesh.name];
    const targets = [];
    carRoot.traverse(mesh => {
      if (mesh.isMesh && targetNames.includes(mesh.name) && !glassNames.has(mesh.name)) targets.push(mesh);
    });
    const material = targets.includes(bodyMesh) ? makeProjectedMaterial(projectedTexture, side) : null;
    if (material) {
      bodyMesh.material = material; projectedMaterial = material;
      window.__projectDebug = { side, params: projectionCameras?.[side], body: bodyMesh.name,
        method: 'calibrated-camera-on-painted-shell', targets: targets.map(mesh => mesh.name),
        excludedGlazing: ['mesh_2', 'mesh_2_2'], sourceAspect: img.naturalWidth / img.naturalHeight };
    }
    if (decalMesh) { scene.remove(decalMesh); decalMesh.geometry.dispose(); decalMesh.material.dispose(); decalMesh = null; }
    buildDecal();
    return;
  }
  if (side === 'hood' || side === 'rear') {
    if (projectedMaterial) { bodyMesh.material = sourceBodyMaterial; projectedMaterial = null; }
    // The end-on source photos are perspective views of curved panels. Sample
    // them through their calibrated camera on the painted shell so every
    // visible point keeps its correct source-image position across the hood,
    // bumper and tailgate. Alpha is the structural artwork mask; glass remains
    // on its independent materials and is never a projection target.
    const material = makeProjectedMaterial(projectedTexture, side);
    if (material) {
      bodyMesh.material = material; projectedMaterial = material;
      window.__projectDebug = { side, params: projectionCameras?.[side], body: bodyMesh.name,
        method: 'calibrated-camera-on-painted-shell', targets: [bodyMesh.name], rearGlassTargetCount: 0,
        sourceAspect: img.naturalWidth / img.naturalHeight };
    }
    if (decalMesh) { scene.remove(decalMesh); decalMesh.geometry.dispose(); decalMesh.material.dispose(); decalMesh = null; }
    buildDecal();
    return;
  }
  const material = makeProjectedMaterial(projectedTexture, side);
  if (material) {
    bodyMesh.material = material; projectedMaterial = material;
    window.__projectDebug = { side, params: projectionCameras?.[side], body: bodyMesh.name, material: Array.isArray(material) ? material.map(m => ({ map: !!m.map, compile: !!m.onBeforeCompile })) : { map: !!material.map, compile: !!material.onBeforeCompile } };
    if (decalMesh) { scene.remove(decalMesh); decalMesh.geometry.dispose(); decalMesh.material.dispose(); decalMesh = null; }
  }
  buildDecal();
}

function flyToSide(side) {
  if (!carBounds) return;
  if (shotSide === side && projectionCameras?.[side]?.focal_px && (side === 'left' || side === 'right')) {
    const params = projectionCameras[side];
    const groundOffset = Math.max(0, -carBounds.min.y || 0);
    const p = params.camera_position_world;
    const target = new THREE.Vector3(0, p[1] + groundOffset, 0);
    orbit.target.copy(target);
    camera.position.set(p[0], p[1] + groundOffset, p[2]);
    camera.up.set(0, 1, 0);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(params.source_dimensions_px[1] / (2 * params.intrinsics_px[1][1])));
    camera.aspect = params.source_dimensions_px[0] / params.source_dimensions_px[1];
    camera.updateProjectionMatrix(); orbit.update();
    return;
  }
  const size = carBounds.getSize(new THREE.Vector3());
  const cy = (carBounds.min.y + carBounds.max.y) / 2;
  const d = Math.max(size.x, size.z) * 2.05 * (shotSide && side === 'hood' ? .68 : shotSide && side === 'rear' ? .42 : 1);
  orbit.target.set(0, cy * (side === 'rear' ? 0.72 : 0.92), 0);
  if (side === 'left') camera.position.set(-d, cy + size.y * 0.55, 0);
  else if (side === 'right') camera.position.set(d, cy + size.y * 0.55, 0);
  else if (side === 'hood') camera.position.set(0, cy + size.y * 3.0, d * 0.9);
  else if (side === 'rear') camera.position.set(0, cy + size.y * 0.75, -d * 1.35);
  else camera.position.set(d * 0.7, cy + size.y * 1.2, d * 0.7);
  orbit.update();
}

document.querySelector('#imageInput').addEventListener('change', e => {
  const file = e.target.files?.[0]; if (!file) return; presetMode = false;
  if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = URL.createObjectURL(file);
  const img = new Image(); img.onload = () => {
    imageInfo = { name: file.name, width: img.naturalWidth, height: img.naturalHeight };
    presetMode = false;
    clearProjectedDecals(true);
    if (projectedMaterial) { bodyMesh.material = sourceBodyMaterial; projectedMaterial = null; }
    if (imageTexture) imageTexture.dispose(); imageTexture = new THREE.Texture(img); imageTexture.colorSpace = THREE.SRGBColorSpace; imageTexture.anisotropy = renderer.capabilities.getMaxAnisotropy(); imageTexture.needsUpdate = true;
    document.querySelector('#decalName').textContent = file.name; document.querySelector('#decalDimensions').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
    document.querySelector('#decalInfo').classList.add('has-image'); document.querySelector('.upload-zone').classList.add('has-image'); buildDecal();
    // Jump to the face the artwork was just applied to, so the result is visible immediately.
    flyToSide(state.side);
  }; img.src = imageUrl;
});
document.querySelector('#removeDecal').addEventListener('click', () => { imageInfo = null; clearProjectedDecals(true); if (imageTexture) imageTexture.dispose(); imageTexture = null; if (projectedTexture) projectedTexture.dispose(); projectedTexture = null; projectedMaterial = null; if (bodyMesh && sourceBodyMaterial) bodyMesh.material = sourceBodyMaterial; presetMode = false; document.querySelector('#imageInput').value = ''; document.querySelector('#decalName').textContent = '尚未选择图案'; document.querySelector('#decalDimensions').textContent = '透明背景图片效果更佳'; document.querySelector('#decalInfo').classList.remove('has-image'); document.querySelector('.upload-zone').classList.remove('has-image'); buildDecal(); });
document.querySelectorAll('[data-side]').forEach(button => button.addEventListener('click', () => { document.querySelector('[data-side].active')?.classList.remove('active'); button.classList.add('active'); state.side = button.dataset.side; if (presetMode) loadPreset(state.side); buildDecal(); flyToSide(state.side); }));
const sliderDefs = [['offsetX','x',v=>Number(v).toFixed(2)],['offsetY','y',v=>Number(v).toFixed(2)],['offsetZ','z',v=>Number(v).toFixed(2)],['decalScale','scale',v=>`${Number(v).toFixed(2)}×`],['decalRotation','rotation',v=>`${Math.round(v)}°`]];
for (const [id,key,format] of sliderDefs) document.getElementById(id).addEventListener('input', e => { state[key] = Number(e.target.value); document.getElementById(`${id}Val`).value = format(state[key]); if (projectedMaterial) { const mats=Array.isArray(projectedMaterial)?projectedMaterial:[projectedMaterial]; mats.forEach(m=>m.userData.updateLiveryTransform?.()); } projectedDecalMeshes.forEach(m=>m.material.userData.updateLiveryTransform?.()); buildDecal(); });
function reset() { for (const [id,key,format] of sliderDefs) { const input = document.getElementById(id); input.value = key === 'scale' ? 1.0 : 0; state[key] = Number(input.value); document.getElementById(`${id}Val`).value = format(state[key]); } state.side = 'left'; document.querySelector('[data-side].active')?.classList.remove('active'); document.querySelector('[data-side="left"]').classList.add('active'); buildDecal(); if (carBounds) { orbit.target.set(0, (carBounds.min.y + carBounds.max.y) / 2, 0); camera.position.set(-6.2, 2.4, 4.6); orbit.update(); } }
document.querySelector('#resetAll').addEventListener('click', reset); document.querySelector('#resetTop').addEventListener('click', reset);
document.querySelector('#viewFront').addEventListener('click', () => { camera.position.set(0, 1.6, 11); orbit.update(); }); document.querySelector('#viewSide').addEventListener('click', () => { camera.position.set(-11, 1.9, 0); orbit.update(); }); document.querySelector('#viewReset').addEventListener('click', reset);
document.querySelector('#exportBtn').addEventListener('click', () => {
  const w = viewport.clientWidth, h = viewport.clientHeight, ratio = 2;
  renderer.setSize(w * ratio, h * ratio, false); renderer.setPixelRatio(1); renderer.render(scene, camera);
  const a = document.createElement('a'); a.download = 'itasha-preview.png'; a.href = renderer.domElement.toDataURL('image/png'); a.click();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); resize();
});
document.querySelector('#mobileToggle').addEventListener('click', () => document.querySelector('#controlPanel').classList.toggle('open'));
document.querySelector('#closePanel').addEventListener('click', () => document.querySelector('#controlPanel').classList.remove('open'));
function resize() { const w = viewport.clientWidth, h = viewport.clientHeight; if (!w || !h) return; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); }
new ResizeObserver(resize).observe(viewport); resize();
if (!shotSide) renderer.setAnimationLoop(() => { orbit.update(); renderer.render(scene, camera); });
if (shotSide) {
  await shotReady;
  const query = new URLSearchParams(location.search);
  const outWidth = Number(query.get('width')) || projectionCameras?.[state.side]?.source_dimensions_px?.[0];
  const outHeight = Number(query.get('height')) || projectionCameras?.[state.side]?.source_dimensions_px?.[1];
  if (outWidth && outHeight) {
    renderer.setPixelRatio(1); camera.aspect = outWidth / outHeight;
    camera.updateProjectionMatrix(); renderer.setSize(outWidth, outHeight, false);
    if (query.get('mode') === 'base') bodyMesh.material = sourceBodyMaterial;
    renderer.render(scene, camera);
    if (query.has('capture')) renderer.domElement.toBlob(blob => {
      const a = document.createElement('a'); a.download = query.get('capture');
      a.href = URL.createObjectURL(blob); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }
}
