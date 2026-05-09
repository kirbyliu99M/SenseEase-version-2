import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const requireDist = args.has('--require-dist');
const root = process.cwd();

const requiredPublicFiles = [
  'public/vendor/mediapipe/tasks-vision/vision_bundle.mjs',
  'public/vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
  'public/vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
  'public/vendor/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js',
  'public/vendor/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm',
  'public/vendor/mediapipe/models/face_landmarker.task',
  'src/core/GazeTracker.js',
  'src/core/OpenVinoBridgeTracker.js',
  'tools/openvino_bridge_server.py',
  'tools/requirements-openvino-bridge.txt',
];

const requiredDistFiles = [
  'dist/index.html',
  'dist/vendor/mediapipe/tasks-vision/vision_bundle.mjs',
  'dist/vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
  'dist/vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
  'dist/vendor/mediapipe/models/face_landmarker.task',
];

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const failures = [];
const warnings = [];

for (const rel of requiredPublicFiles) {
  if (!exists(rel)) failures.push(`Missing required file: ${rel}`);
}

if (requireDist) {
  for (const rel of requiredDistFiles) {
    if (!exists(rel)) failures.push(`Missing required built file: ${rel}`);
  }
}

if (exists('index.html')) {
  const index = read('index.html');
  if (!index.includes('id="main-backend-toggle"')) {
    failures.push('Missing backend toggle button #main-backend-toggle in index.html');
  }
  if (!index.includes('id="main-webcam-toggle"')) {
    failures.push('Missing webcam toggle button #main-webcam-toggle in index.html');
  }
}

if (exists('src/main.js')) {
  const main = read('src/main.js');
  if (!main.includes("import { OpenVinoBridgeTracker } from './core/OpenVinoBridgeTracker.js'")) {
    failures.push('main.js does not import OpenVinoBridgeTracker');
  }
  if (!main.includes("ws://127.0.0.1:8765")) {
    failures.push('main.js does not target local OpenVINO bridge ws://127.0.0.1:8765');
  }
  if (main.includes('webgazer')) {
    warnings.push('Found leftover "webgazer" reference in src/main.js');
  }
}

if (exists('src/core/GazeTracker.js')) {
  const gaze = read('src/core/GazeTracker.js');
  if (!gaze.includes('FilesetResolver.forVisionTasks')) {
    failures.push('GazeTracker.js missing FilesetResolver.forVisionTasks call');
  }
  if (!gaze.includes('vendor/mediapipe')) {
    warnings.push('GazeTracker.js vendor path check could not confirm /vendor/mediapipe usage');
  }
}

if (failures.length > 0) {
  console.error('Integrity check failed:\n- ' + failures.join('\n- '));
  if (warnings.length > 0) {
    console.error('\nWarnings:\n- ' + warnings.join('\n- '));
  }
  process.exit(1);
}

console.log('Integrity check passed.');
if (warnings.length > 0) {
  console.log('Warnings:\n- ' + warnings.join('\n- '));
}
