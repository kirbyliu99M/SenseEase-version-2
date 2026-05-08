// GazeTracker — Google MediaPipe FaceLandmarker (with iris) → screen-space gaze coords.
// MediaPipe is lazy-loaded from CDN on the first call to start() so it doesn't
// inflate the initial bundle (the WASM + JS package is ~3-5MB).
//
// Calibration: 3 corner dots (top-left, top-right, bottom-right). User looks at
// each in turn while we sample iris position. We then solve a 2D affine
// transform from iris-space to screen-space (3 corresponding points → 6
// unknowns → exactly determined system).
//
// All processing is on-device. The MediaPipe WASM module performs face
// landmark detection locally; no frame data leaves the machine.

const MEDIAPIPE_VERSION = '0.10.16';
const MEDIAPIPE_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MEDIAPIPE_WASM_BASE  = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Iris landmark indices in MediaPipe FaceLandmarker (refined landmarks output).
// Left iris: 468-472 (centre 468), Right iris: 473-477 (centre 473).
const LEFT_IRIS_CENTRE  = 468;
const RIGHT_IRIS_CENTRE = 473;

export class GazeTracker {
  constructor(webcamSource, onGaze) {
    this.webcam = webcamSource;
    this.onGaze = onGaze;
    this.faceLandmarker = null;
    this._unsubFrame = null;
    this._affine = null;       // 2x3 matrix [[ax, bx, cx], [ay, by, cy]] applied to iris (x, y)
    this._calibrating = false;
    this._lastFrameMs = 0;
    this._calibrationOverlay = null;
    this._isReady = false;
  }

  async _ensureMediaPipe() {
    if (this.faceLandmarker) return;
    const { FaceLandmarker, FilesetResolver } = await import(/* @vite-ignore */ MEDIAPIPE_BUNDLE_URL);
    const wasmFileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
    this.faceLandmarker = await FaceLandmarker.createFromOptions(wasmFileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      runningMode: 'VIDEO',
      numFaces: 1,
    });
  }

  // Sample iris position once. Returns {x, y} in normalized image coords or null.
  _sampleIris(video) {
    if (!this.faceLandmarker || !video || video.videoWidth === 0) return null;
    const ts = performance.now();
    if (ts - this._lastFrameMs < 30) return null; // throttle to ~30Hz
    this._lastFrameMs = ts;

    const result = this.faceLandmarker.detectForVideo(video, ts);
    if (!result?.faceLandmarks?.[0]) return null;

    const lm = result.faceLandmarks[0];
    if (lm.length < RIGHT_IRIS_CENTRE + 1) return null; // iris not in this model output

    const left  = lm[LEFT_IRIS_CENTRE];
    const right = lm[RIGHT_IRIS_CENTRE];
    return {
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
    };
  }

  async start() {
    if (this._isReady) return;
    await this._ensureMediaPipe();
    this._isReady = true;

    // Live inference loop — emits gaze coords through onGaze() at ~30Hz.
    this._unsubFrame = this.webcam.onFrame((video) => {
      if (this._calibrating) return;       // pause emission during calibration
      if (!this._affine) return;            // waiting for first calibration
      const iris = this._sampleIris(video);
      if (!iris) return;
      const screen = this._applyAffine(iris);
      this.onGaze(screen.x, screen.y);
    }, 33);
  }

  stop() {
    if (this._unsubFrame) { this._unsubFrame(); this._unsubFrame = null; }
    if (this.faceLandmarker) {
      try { this.faceLandmarker.close(); } catch {}
      this.faceLandmarker = null;
    }
    this._isReady = false;
    this._affine = null;
    this._dismissCalibrationOverlay();
  }

  // 3-corner calibration — TL, TR, BR. ~1.5s per corner.
  async calibrate({ dwellMs = 1500, sampleCount = 30 } = {}) {
    if (!this._isReady) await this.start();
    this._calibrating = true;

    const corners = [
      { name: 'TL', sx: 0,                  sy: 0                   },
      { name: 'TR', sx: window.innerWidth,  sy: 0                   },
      { name: 'BR', sx: window.innerWidth,  sy: window.innerHeight  },
    ];

    const samplesByCorner = [];
    this._showCalibrationOverlay();

    for (const c of corners) {
      this._moveCalibrationDot(c.sx, c.sy, c.name);
      // Wait an initial 400ms for eye to settle on the dot
      await _sleep(400);

      // Sample iris over the dwell window
      const samples = [];
      const sampleInterval = Math.max(20, Math.floor((dwellMs - 400) / sampleCount));
      const start = performance.now();
      while (performance.now() - start < (dwellMs - 400)) {
        const iris = this._sampleIris(this.webcam.videoElement);
        if (iris) samples.push(iris);
        await _sleep(sampleInterval);
      }

      if (samples.length === 0) {
        this._dismissCalibrationOverlay();
        this._calibrating = false;
        throw new Error(`Calibration failed at ${c.name}: no face/iris detected`);
      }

      const avg = {
        x: samples.reduce((s, p) => s + p.x, 0) / samples.length,
        y: samples.reduce((s, p) => s + p.y, 0) / samples.length,
      };
      samplesByCorner.push({ ...avg, sx: c.sx, sy: c.sy });
    }

    this._dismissCalibrationOverlay();
    this._calibrating = false;

    // Solve 2D affine: iris (px, py) → screen (sx, sy)
    this._affine = solveAffine3pt(
      samplesByCorner[0], samplesByCorner[1], samplesByCorner[2]
    );
    return true;
  }

  _applyAffine(iris) {
    const A = this._affine;
    return {
      x: A[0][0] * iris.x + A[0][1] * iris.y + A[0][2],
      y: A[1][0] * iris.x + A[1][1] * iris.y + A[1][2],
    };
  }

  // ----- Calibration overlay (dom-only, no canvas) -----
  _showCalibrationOverlay() {
    if (this._calibrationOverlay) return;
    const o = document.createElement('div');
    o.id = 'gaze-calibration-overlay';
    Object.assign(o.style, {
      position: 'fixed', inset: '0', zIndex: '99999',
      background: 'rgba(8, 12, 24, 0.92)', color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
    });
    o.innerHTML = `
      <div style="text-align:center;max-width:480px;padding:32px;">
        <div style="font-size:14px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.7;margin-bottom:12px;">SenseEase Gaze Calibration</div>
        <div style="font-size:22px;font-weight:600;margin-bottom:6px;">Look at the dot — keep your head still.</div>
        <div id="gaze-calib-status" style="font-size:13px;opacity:0.6;">Initializing…</div>
      </div>
      <div id="gaze-calib-dot" style="position:absolute;width:32px;height:32px;border-radius:50%;background:#3aa6ff;box-shadow:0 0 24px 8px rgba(58,166,255,0.55);transform:translate(-50%,-50%);left:50%;top:50%;transition:left 0.4s ease, top 0.4s ease;"></div>
    `;
    document.body.appendChild(o);
    this._calibrationOverlay = o;
  }

  _moveCalibrationDot(x, y, label) {
    if (!this._calibrationOverlay) return;
    const dot = this._calibrationOverlay.querySelector('#gaze-calib-dot');
    const status = this._calibrationOverlay.querySelector('#gaze-calib-status');
    if (dot) {
      dot.style.left = `${x}px`;
      dot.style.top  = `${y}px`;
    }
    if (status) status.innerText = `Sampling ${label}…`;
  }

  _dismissCalibrationOverlay() {
    if (this._calibrationOverlay) {
      this._calibrationOverlay.remove();
      this._calibrationOverlay = null;
    }
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 2D affine fit from 3 point correspondences.
// p1,p2,p3 carry .x .y (iris-space) plus .sx .sy (screen-space).
// Returns matrix [[ax, bx, cx], [ay, by, cy]] s.t. screen = A @ [iris.x, iris.y, 1].
function solveAffine3pt(p1, p2, p3) {
  // S (2x3) = A (2x3) @ P (3x3) where P stacks [pi.x; pi.y; 1] as columns.
  // → A = S @ inv(P)
  const P = [
    [p1.x, p2.x, p3.x],
    [p1.y, p2.y, p3.y],
    [1, 1, 1],
  ];
  const Pinv = _invert3x3(P);
  const Sx = [p1.sx, p2.sx, p3.sx];
  const Sy = [p1.sy, p2.sy, p3.sy];
  const row = (S) => [
    S[0]*Pinv[0][0] + S[1]*Pinv[1][0] + S[2]*Pinv[2][0],
    S[0]*Pinv[0][1] + S[1]*Pinv[1][1] + S[2]*Pinv[2][1],
    S[0]*Pinv[0][2] + S[1]*Pinv[1][2] + S[2]*Pinv[2][2],
  ];
  return [row(Sx), row(Sy)];
}

function _invert3x3(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const det = a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
  if (Math.abs(det) < 1e-9) throw new Error('Calibration matrix singular — try recalibrating');
  const invDet = 1 / det;
  return [
    [(e*i - f*h)*invDet, (c*h - b*i)*invDet, (b*f - c*e)*invDet],
    [(f*g - d*i)*invDet, (a*i - c*g)*invDet, (c*d - a*f)*invDet],
    [(d*h - e*g)*invDet, (b*g - a*h)*invDet, (a*e - b*d)*invDet],
  ];
}
