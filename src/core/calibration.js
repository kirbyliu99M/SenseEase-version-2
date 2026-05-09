// Shared calibration utilities used by both GazeTracker (MediaPipe) and
// OpenVinoBridgeTracker. Pure math + DOM overlay helpers — no tracker-
// specific logic so both backends can fit a quadratic mapping the same way.

const _CALIB_OVERLAY_ID = 'gaze-calibration-overlay';
const _CALIB_DOT_ID = 'gaze-calib-dot';
const _CALIB_STATUS_ID = 'gaze-calib-status';

export function showCalibrationOverlay() {
  let o = document.getElementById(_CALIB_OVERLAY_ID);
  if (o) return o;

  o = document.createElement('div');
  o.id = _CALIB_OVERLAY_ID;
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
      <div id="${_CALIB_STATUS_ID}" style="font-size:13px;opacity:0.65;">Initializing...</div>
    </div>
    <div id="${_CALIB_DOT_ID}" style="position:absolute;width:30px;height:30px;border-radius:50%;background:#3aa6ff;box-shadow:0 0 24px 8px rgba(58,166,255,0.55);transform:translate(-50%,-50%);left:50%;top:50%;transition:left 0.32s ease, top 0.32s ease;"></div>
  `;

  document.body.appendChild(o);
  return o;
}

export function moveCalibrationDot(overlay, x, y, statusLabel) {
  if (!overlay) return;
  const dot = overlay.querySelector(`#${_CALIB_DOT_ID}`);
  const status = overlay.querySelector(`#${_CALIB_STATUS_ID}`);
  if (dot) {
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
  }
  if (status) status.innerText = statusLabel;
}

export function dismissCalibrationOverlay(overlay) {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  const stale = document.getElementById(_CALIB_OVERLAY_ID);
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
}

export function buildCalibrationGrid(width, height) {
  const xs = [0.06, 0.5, 0.94].map((r) => width * r);
  const ys = [0.06, 0.5, 0.94].map((r) => height * r);
  const out = [];
  for (const y of ys) {
    for (const x of xs) out.push({ sx: x, sy: y });
  }
  return out;
}

export function buildValidationPoints(width, height) {
  return [
    { sx: width * 0.1, sy: height * 0.1 },
    { sx: width * 0.9, sy: height * 0.1 },
    { sx: width * 0.5, sy: height * 0.5 },
    { sx: width * 0.1, sy: height * 0.9 },
    { sx: width * 0.9, sy: height * 0.9 },
  ];
}

export function basis(x, y) {
  return [x, y, x * x, y * y, x * y, 1];
}

export function fitQuadraticMapping(samples, lambda = 0.001) {
  if (!Array.isArray(samples) || samples.length < 6) return null;

  const dim = 6;
  const A = Array.from({ length: dim }, () => Array(dim).fill(0));
  const bx = Array(dim).fill(0);
  const by = Array(dim).fill(0);

  for (const s of samples) {
    const f = basis(s.x, s.y);
    for (let i = 0; i < dim; i += 1) {
      bx[i] += f[i] * s.sx;
      by[i] += f[i] * s.sy;
      for (let j = 0; j < dim; j += 1) {
        A[i][j] += f[i] * f[j];
      }
    }
  }

  for (let i = 0; i < dim; i += 1) A[i][i] += lambda;

  const wx = solveLinearSystem(A, bx);
  const wy = solveLinearSystem(A, by);
  if (!wx || !wy) return null;
  return { wx, wy };
}

export function solveLinearSystem(matrix, rhs) {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  const b = rhs.slice();

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(a[r][col]);
      if (v > best) { best = v; pivot = r; }
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

export function applyMappingFor(mapping, sample) {
  const f = basis(sample.x, sample.y);
  const x = dot(mapping.wx, f);
  const y = dot(mapping.wy, f);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

export function robustCenter(samples) {
  if (!Array.isArray(samples) || samples.length < 8) return null;
  const sortedX = samples.map((s) => s.x).sort((a, b) => a - b);
  const sortedY = samples.map((s) => s.y).sort((a, b) => a - b);
  const trim = Math.floor(samples.length * 0.15);
  const sliceX = sortedX.slice(trim, sortedX.length - trim);
  const sliceY = sortedY.slice(trim, sortedY.length - trim);
  if (sliceX.length < 6 || sliceY.length < 6) return null;
  const cx = sliceX.reduce((acc, v) => acc + v, 0) / sliceX.length;
  const cy = sliceY.reduce((acc, v) => acc + v, 0) / sliceY.length;
  const ax = sliceX.reduce((acc, v) => acc + Math.abs(v - cx), 0) / sliceX.length;
  const ay = sliceY.reduce((acc, v) => acc + Math.abs(v - cy), 0) / sliceY.length;
  return { cx, cy, ax, ay };
}

// Higher-level orchestrator: drives the user through a multi-point
// calibration sequence and returns the fitted mapping. The caller passes a
// `getSample()` function that returns the current raw sample (or null).
//
// opts:
//   - width, height: screen dims for the calibration grid
//   - getSample(): () => {x, y, quality} | null   (raw sample in tracker units)
//   - dwellMs (default 700): per-point dwell time
//   - sampleStepMs (default 28): polling cadence within dwell
//   - qualityMin (default 0.4): reject samples below this quality
//   - lambda (default 0.0025): regularizer for the linear solve
//
// returns: { mapping, sampleCount, validationRmsePx, grade } or throws.
export async function runQuadraticCalibration({
  width,
  height,
  getSample,
  dwellMs = 700,
  sampleStepMs = 28,
  qualityMin = 0.4,
  lambda = 0.0025,
} = {}) {
  if (typeof getSample !== 'function') {
    throw new Error('runQuadraticCalibration requires a getSample() function');
  }

  const positions = buildCalibrationGrid(width, height);
  const overlay = showCalibrationOverlay();
  const samples = [];

  try {
    for (let i = 0; i < positions.length; i += 1) {
      const p = positions[i];
      moveCalibrationDot(overlay, p.sx, p.sy, `Sampling point ${i + 1}/${positions.length}`);
      await _sleep(280);

      const pointSamples = [];
      const start = performance.now();
      while (performance.now() - start < dwellMs - 280) {
        const s = getSample();
        if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && (s.quality ?? 1) >= qualityMin) {
          pointSamples.push({ x: s.x, y: s.y });
        }
        await _sleep(sampleStepMs);
      }
      if (pointSamples.length < 4) continue;
      const ax = pointSamples.reduce((a, s) => a + s.x, 0) / pointSamples.length;
      const ay = pointSamples.reduce((a, s) => a + s.y, 0) / pointSamples.length;
      samples.push({ x: ax, y: ay, sx: p.sx, sy: p.sy });
    }
  } finally {
    dismissCalibrationOverlay(overlay);
  }

  if (samples.length < 5) {
    throw new Error(`Calibration failed: only ${samples.length}/${positions.length} points captured. Check lighting / camera framing.`);
  }

  const mapping = fitQuadraticMapping(samples, lambda);
  if (!mapping) {
    throw new Error('Calibration failed: linear solve unstable. Retry in better lighting.');
  }

  // RMSE on the same training points — quick sanity check; full validation
  // would re-sample at different points but that doubles user wait time.
  let totalSq = 0;
  for (const s of samples) {
    const pred = applyMappingFor(mapping, { x: s.x, y: s.y });
    if (!pred) continue;
    totalSq += (pred.x - s.sx) ** 2 + (pred.y - s.sy) ** 2;
  }
  const rmsePx = Math.sqrt(totalSq / samples.length);
  const grade = rmsePx <= 120 ? 'excellent' : rmsePx <= 180 ? 'good' : rmsePx <= 230 ? 'usable' : 'weak';

  return { mapping, sampleCount: samples.length, rmsePx, grade };
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
