import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const BASE_URL = import.meta.env.BASE_URL || '/';
const VENDOR_BASE = `${BASE_URL}vendor/mediapipe`;
const MEDIAPIPE_WASM_BASE = `${VENDOR_BASE}/tasks-vision/wasm`;
const MODEL_URL = `${VENDOR_BASE}/models/face_landmarker.task`;

const LEFT_IRIS_CENTRE = 468;
const RIGHT_IRIS_CENTRE = 473;

export class GazeTracker {
  constructor(webcamSource, onGaze) {
    this.webcam = webcamSource;
    this.onGaze = onGaze;
    this.faceLandmarker = null;
    this._unsubFrame = null;
    this._calibrating = false;
    this._lastFrameMs = 0;
    this._calibrationOverlay = null;
    this._isReady = false;
    this._mapping = null;
    this._lastCalibration = null;
    this._loadState = 'idle';
    this._lastError = '';
    this._fallbackCenter = { x: 0, y: 0, ready: false };
    this._fallbackAmp = { x: 0.09, y: 0.07 };
  }

  async _ensureMediaPipe() {
    if (this.faceLandmarker) return;
    this._loadState = 'loading';
    this._lastError = '';
    try {
      const wasmFileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      this.faceLandmarker = await FaceLandmarker.createFromOptions(wasmFileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.65,
        minFacePresenceConfidence: 0.65,
        minTrackingConfidence: 0.65,
      });
      this._loadState = 'ready';
    } catch (e) {
      this._loadState = 'error';
      this._lastError = e?.message || String(e);
      throw e;
    }
  }

  _sampleIris(video) {
    if (!this.faceLandmarker || !video || video.videoWidth === 0) return null;

    const ts = performance.now();
    if (ts - this._lastFrameMs < 28) return null;
    this._lastFrameMs = ts;

    const result = this.faceLandmarker.detectForVideo(video, ts);
    if (!result?.faceLandmarks?.[0]) return null;

    if (result.faceBlendshapes?.[0]) {
      const shapes = result.faceBlendshapes[0].categories;
      const getScore = (name) => {
        const s = shapes.find((c) => c.categoryName === name);
        return s ? s.score : 0;
      };

      const lOut = getScore('eyeLookOutLeft');
      const lIn = getScore('eyeLookInLeft');
      const rOut = getScore('eyeLookOutRight');
      const rIn = getScore('eyeLookInRight');
      const gazeX = ((rOut - rIn) + (lIn - lOut)) / 2.0;

      const lUp = getScore('eyeLookUpLeft');
      const lDn = getScore('eyeLookDownLeft');
      const rUp = getScore('eyeLookUpRight');
      const rDn = getScore('eyeLookDownRight');
      const gazeY = ((lDn - lUp) + (rDn - rUp)) / 2.0;

      const blink = Math.max(getScore('eyeBlinkLeft'), getScore('eyeBlinkRight'));
      const lookMagnitude = Math.hypot(gazeX, gazeY);
      const quality = _clamp((1 - blink * 0.9) + Math.min(0.16, lookMagnitude * 0.35), 0.08, 1.0);

      return { x: gazeX, y: gazeY, quality };
    }

    const lm = result.faceLandmarks[0];
    if (lm.length < RIGHT_IRIS_CENTRE + 1) return null;

    const lIris = lm[LEFT_IRIS_CENTRE];
    const rIris = lm[RIGHT_IRIS_CENTRE];
    const lInner = lm[133];
    const rInner = lm[362];

    const faceCenter = {
      x: (lInner.x + rInner.x) / 2,
      y: (lInner.y + rInner.y) / 2,
    };
    const iod = Math.hypot(lInner.x - rInner.x, lInner.y - rInner.y) || 0.001;
    const avgIris = {
      x: (lIris.x + rIris.x) / 2,
      y: (lIris.y + rIris.y) / 2,
    };

    return {
      x: (avgIris.x - faceCenter.x) / iod,
      y: (avgIris.y - faceCenter.y) / iod,
      quality: 0.55,
    };
  }

  async start() {
    if (this._isReady) return;
    await this._ensureMediaPipe();
    this._isReady = true;

    this._unsubFrame = this.webcam.onFrame((video) => {
      if (this._calibrating) return;

      const sample = this._sampleIris(video);
      if (!sample) return;

      const screen = this._applyMapping(sample);
      if (!screen) return;

      this.onGaze(screen.x, screen.y, {
        quality: this._mapping ? sample.quality : Math.max(0.18, sample.quality * 0.82),
        source: 'mediapipe',
        ts: performance.now(),
      });
    }, 24);
  }

  stop() {
    if (this._unsubFrame) {
      this._unsubFrame();
      this._unsubFrame = null;
    }

    if (this.faceLandmarker) {
      try { this.faceLandmarker.close(); } catch {}
      this.faceLandmarker = null;
    }

    this._isReady = false;
    this._mapping = null;
    this._dismissCalibrationOverlay();
  }

  async calibrate({
    profile = 'quick',          // quick | full
    dwellMs = 700,
    sampleCount = 10,
    preCenterMs = 2200,
  } = {}) {
    if (!this._isReady) await this.start();
    this._calibrating = true;

    const positions = _buildCalibrationGrid(window.innerWidth, window.innerHeight);
    const samples = [];

    this._showCalibrationOverlay();
    const preCenter = await this._collectCenterBaseline(preCenterMs);
    if (!preCenter) {
      this._dismissCalibrationOverlay();
      this._calibrating = false;
      throw new Error('Pre-calibration failed: keep looking at center in stable lighting');
    }

    if (profile !== 'full') {
      const quickMapping = _buildQuickMappingFromBaseline(
        preCenter,
        window.innerWidth,
        window.innerHeight,
      );
      if (!quickMapping) {
        this._dismissCalibrationOverlay();
        this._calibrating = false;
        throw new Error('Quick calibration failed: baseline mapping solve failed');
      }
      this._dismissCalibrationOverlay();
      this._calibrating = false;
      this._mapping = quickMapping;
      this._lastCalibration = {
        passed: true,
        grade: 'quick',
        mode: 'quick',
        rmsePx: NaN,
        samples: preCenter.samples,
      };
      return true;
    }

    for (let i = 0; i < positions.length; i += 1) {
      const p = positions[i];
      this._moveCalibrationDot(p.sx, p.sy, `Point ${i + 1}/${positions.length}`);
      await _sleep(260);

      const gazeSamples = [];
      const interval = Math.max(18, Math.floor((dwellMs - 260) / sampleCount));
      const start = performance.now();

      while (performance.now() - start < (dwellMs - 260)) {
        const s = this._sampleIris(this.webcam.videoElement);
        if (s && s.quality >= 0.14) gazeSamples.push(s);
        await _sleep(interval);
      }

      if (gazeSamples.length < Math.max(4, Math.floor(sampleCount * 0.22))) continue;

      const avg = {
        x: gazeSamples.reduce((acc, v) => acc + v.x, 0) / gazeSamples.length,
        y: gazeSamples.reduce((acc, v) => acc + v.y, 0) / gazeSamples.length,
      };
      samples.push({ ...avg, sx: p.sx, sy: p.sy });
    }

    this._dismissCalibrationOverlay();
    this._calibrating = false;

    const mapping = _fitQuadraticMapping(samples, 0.0025);
    if (!mapping) throw new Error('Calibration failed: insufficient valid points');

    const report = await this._validateCalibration(mapping);
    if (!report.passed) {
      const rmseFinite = Number.isFinite(report.rmsePx);
      const weakButUsable = rmseFinite && report.rmsePx <= 360;
      if (!weakButUsable) {
        this._lastCalibration = report;
        throw new Error(`Calibration quality too low (${report.rmsePx.toFixed(0)}px RMSE). Please retry in better lighting.`);
      }
      report.grade = 'weak';
      report.warning = `Using weak calibration (${report.rmsePx.toFixed(0)}px RMSE)`;
    }

    this._mapping = mapping;
    this._lastCalibration = { ...report, mode: 'full' };
    return true;
  }

  getDiagnostics() {
    return {
      backend: 'mediapipe',
      calibration: this._lastCalibration,
      loadState: this._loadState,
      lastError: this._lastError,
      mappingMode: this._mapping ? 'calibrated' : 'fallback',
    };
  }

  _applyMapping(sample) {
    if (!this._mapping) return this._applyFallbackMapping(sample);

    const f = _basis(sample.x, sample.y);
    const x = _dot(this._mapping.wx, f);
    const y = _dot(this._mapping.wy, f);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    return {
      x: _clamp(x, -window.innerWidth * 0.25, window.innerWidth * 1.25),
      y: _clamp(y, -window.innerHeight * 0.25, window.innerHeight * 1.25),
    };
  }

  _applyFallbackMapping(sample) {
    if (!this._fallbackCenter.ready) {
      this._fallbackCenter = { x: sample.x, y: sample.y, ready: true };
      return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }

    const cx = this._fallbackCenter.x;
    const cy = this._fallbackCenter.y;
    const dx = sample.x - cx;
    const dy = sample.y - cy;
    const motion = Math.hypot(dx, dy);

    const centerAlpha = motion < 0.035 ? 0.052 : 0.009;
    this._fallbackCenter.x = _lerp(this._fallbackCenter.x, sample.x, centerAlpha);
    this._fallbackCenter.y = _lerp(this._fallbackCenter.y, sample.y, centerAlpha);

    this._fallbackAmp.x = _clamp(_lerp(this._fallbackAmp.x, Math.abs(dx), 0.04), 0.03, 0.28);
    this._fallbackAmp.y = _clamp(_lerp(this._fallbackAmp.y, Math.abs(dy), 0.04), 0.025, 0.24);

    const nx = _clamp(dx / Math.max(0.05, this._fallbackAmp.x * 2.05), -1, 1);
    const ny = _clamp(dy / Math.max(0.045, this._fallbackAmp.y * 2.05), -1, 1);

    const sx = window.innerWidth * (0.5 + nx * 0.46);
    const sy = window.innerHeight * (0.5 + ny * 0.41);
    return {
      x: _clamp(sx, 0, window.innerWidth),
      y: _clamp(sy, 0, window.innerHeight),
    };
  }

  _showCalibrationOverlay() {
    if (this._calibrationOverlay) return;

    const o = document.createElement('div');
    o.id = 'gaze-calibration-overlay';
    Object.assign(o.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '99999',
      background: 'rgba(8, 12, 24, 0.92)',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
    });

    o.innerHTML = `
      <div style="text-align:center;max-width:560px;padding:32px;">
        <div style="font-size:14px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.7;margin-bottom:12px;">SenseEase Gaze Calibration</div>
        <div style="font-size:21px;font-weight:600;margin-bottom:6px;">Look at the dot and hold your gaze steady.</div>
        <div id="gaze-calib-status" style="font-size:13px;opacity:0.65;">Initializing...</div>
      </div>
      <div id="gaze-calib-dot" style="position:absolute;width:30px;height:30px;border-radius:50%;background:#3aa6ff;box-shadow:0 0 24px 8px rgba(58,166,255,0.55);transform:translate(-50%,-50%);left:50%;top:50%;transition:left 0.32s ease, top 0.32s ease;"></div>
    `;

    document.body.appendChild(o);
    this._calibrationOverlay = o;
  }

  _moveCalibrationDot(x, y, statusLabel) {
    if (!this._calibrationOverlay) return;
    const dot = this._calibrationOverlay.querySelector('#gaze-calib-dot');
    const status = this._calibrationOverlay.querySelector('#gaze-calib-status');
    if (dot) {
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
    }
    if (status) status.innerText = `Sampling ${statusLabel}`;
  }

  _dismissCalibrationOverlay() {
    if (this._calibrationOverlay) {
      this._calibrationOverlay.remove();
      this._calibrationOverlay = null;
    }
  }

  async _collectCenterBaseline(preCenterMs) {
    const sx = window.innerWidth * 0.5;
    const sy = window.innerHeight * 0.5;
    this._moveCalibrationDot(sx, sy, 'Center lock');
    await _sleep(220);

    const windowMs = Math.max(1800, preCenterMs | 0);
    const sampleStep = 26;
    const samples = [];
    const t0 = performance.now();

    while (performance.now() - t0 < windowMs) {
      const remain = Math.max(0, windowMs - (performance.now() - t0));
      this._moveCalibrationDot(sx, sy, `Center lock ${Math.ceil(remain / 1000)}s`);
      const s = this._sampleIris(this.webcam.videoElement);
      if (s && s.quality >= 0.14) samples.push(s);
      await _sleep(sampleStep);
    }

    if (samples.length < Math.max(18, Math.floor(windowMs / 200))) return null;

    const cx = samples.reduce((acc, v) => acc + v.x, 0) / samples.length;
    const cy = samples.reduce((acc, v) => acc + v.y, 0) / samples.length;
    const ax = samples.reduce((acc, v) => acc + Math.abs(v.x - cx), 0) / samples.length;
    const ay = samples.reduce((acc, v) => acc + Math.abs(v.y - cy), 0) / samples.length;

    // Establish a stable fallback anchor before multi-point solve.
    this._fallbackCenter = { x: cx, y: cy, ready: true };
    this._fallbackAmp = {
      x: _clamp(Math.max(0.06, ax * 2.4), 0.05, 0.28),
      y: _clamp(Math.max(0.05, ay * 2.4), 0.045, 0.24),
    };
    return { cx, cy, ax, ay, samples: samples.length };
  }

  async _validateCalibration(mapping) {
    const validationPoints = _buildValidationPoints(window.innerWidth, window.innerHeight);
    let totalSq = 0;
    let n = 0;

    this._showCalibrationOverlay();
    for (let i = 0; i < validationPoints.length; i += 1) {
      const p = validationPoints[i];
      this._moveCalibrationDot(p.sx, p.sy, `Validation ${i + 1}/${validationPoints.length}`);
      await _sleep(260);

      const samples = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 420) {
        const s = this._sampleIris(this.webcam.videoElement);
        if (s && s.quality >= 0.15) {
          const pred = _applyMappingFor(mapping, s);
          if (pred) samples.push(pred);
        }
        await _sleep(28);
      }

      if (samples.length === 0) continue;
      const avgX = samples.reduce((acc, s) => acc + s.x, 0) / samples.length;
      const avgY = samples.reduce((acc, s) => acc + s.y, 0) / samples.length;
      const err = Math.hypot(avgX - p.sx, avgY - p.sy);
      totalSq += err * err;
      n += 1;
    }
    this._dismissCalibrationOverlay();

    if (n === 0) {
      return { passed: false, rmsePx: Infinity, samples: 0, grade: 'poor' };
    }

    const rmsePx = Math.sqrt(totalSq / n);
    const passed = rmsePx <= 230;
    const grade = rmsePx <= 120 ? 'excellent' : rmsePx <= 180 ? 'good' : rmsePx <= 230 ? 'usable' : 'poor';
    return { passed, rmsePx, samples: n, grade };
  }
}

function _buildCalibrationGrid(width, height) {
  const xs = [0.06, 0.5, 0.94].map((r) => width * r);
  const ys = [0.06, 0.5, 0.94].map((r) => height * r);
  const out = [];
  for (const y of ys) {
    for (const x of xs) out.push({ sx: x, sy: y });
  }
  return out;
}

function _buildValidationPoints(width, height) {
  return [
    { sx: width * 0.1, sy: height * 0.1 },
    { sx: width * 0.9, sy: height * 0.1 },
    { sx: width * 0.5, sy: height * 0.5 },
    { sx: width * 0.1, sy: height * 0.9 },
    { sx: width * 0.9, sy: height * 0.9 },
  ];
}

function _buildQuickMappingFromBaseline(baseline, width, height) {
  if (!baseline) return null;
  const cx = baseline.cx;
  const cy = baseline.cy;
  const ax = Math.max(0.025, baseline.ax || 0.05);
  const ay = Math.max(0.02, baseline.ay || 0.045);

  const ux = _clamp(ax * 4.2, 0.05, 0.24);
  const uy = _clamp(ay * 4.2, 0.045, 0.21);
  const rx = width * 0.4;   // target ~80% span (10%..90%)
  const ry = height * 0.4;

  const points = [
    { x: cx, y: cy, sx: width * 0.5, sy: height * 0.5 },
    { x: cx + ux, y: cy, sx: width * 0.5 + rx, sy: height * 0.5 },
    { x: cx - ux, y: cy, sx: width * 0.5 - rx, sy: height * 0.5 },
    { x: cx, y: cy + uy, sx: width * 0.5, sy: height * 0.5 + ry },
    { x: cx, y: cy - uy, sx: width * 0.5, sy: height * 0.5 - ry },
    { x: cx + ux * 0.75, y: cy + uy * 0.75, sx: width * 0.5 + rx * 0.8, sy: height * 0.5 + ry * 0.8 },
    { x: cx - ux * 0.75, y: cy + uy * 0.75, sx: width * 0.5 - rx * 0.8, sy: height * 0.5 + ry * 0.8 },
    { x: cx + ux * 0.75, y: cy - uy * 0.75, sx: width * 0.5 + rx * 0.8, sy: height * 0.5 - ry * 0.8 },
    { x: cx - ux * 0.75, y: cy - uy * 0.75, sx: width * 0.5 - rx * 0.8, sy: height * 0.5 - ry * 0.8 },
  ];

  return _fitQuadraticMapping(points, 0.0032);
}

function _basis(x, y) {
  return [x, y, x * x, y * y, x * y, 1];
}

function _fitQuadraticMapping(samples, lambda = 0.001) {
  if (!Array.isArray(samples) || samples.length < 6) return null;

  const dim = 6;
  const A = Array.from({ length: dim }, () => Array(dim).fill(0));
  const bx = Array(dim).fill(0);
  const by = Array(dim).fill(0);

  for (const s of samples) {
    const f = _basis(s.x, s.y);

    for (let i = 0; i < dim; i += 1) {
      bx[i] += f[i] * s.sx;
      by[i] += f[i] * s.sy;
      for (let j = 0; j < dim; j += 1) {
        A[i][j] += f[i] * f[j];
      }
    }
  }

  for (let i = 0; i < dim; i += 1) A[i][i] += lambda;

  const wx = _solveLinearSystem(A, bx);
  const wy = _solveLinearSystem(A, by);

  if (!wx || !wy) return null;
  return { wx, wy };
}

function _solveLinearSystem(matrix, rhs) {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  const b = rhs.slice();

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(a[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }

    if (best < 1e-10) return null;

    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }

    const diag = a[col][col];
    for (let j = col; j < n; j += 1) a[col][j] /= diag;
    b[col] /= diag;

    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = a[r][col];
      if (Math.abs(f) < 1e-12) continue;
      for (let j = col; j < n; j += 1) a[r][j] -= f * a[col][j];
      b[r] -= f * b[col];
    }
  }

  return b;
}

function _dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function _applyMappingFor(mapping, sample) {
  const f = _basis(sample.x, sample.y);
  const x = _dot(mapping.wx, f);
  const y = _dot(mapping.wy, f);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
