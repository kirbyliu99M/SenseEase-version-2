import { runQuadraticCalibration, applyMappingFor } from './calibration.js';

export class OpenVinoBridgeTracker {
  constructor(webcamSource, onGaze, {
    wsUrl = 'ws://127.0.0.1:8765',
    sendHz = 12,
  } = {}) {
    this.webcam = webcamSource;
    this.onGaze = onGaze;
    this.wsUrl = wsUrl;
    this.sendIntervalMs = Math.max(40, Math.floor(1000 / Math.max(1, sendHz)));

    this._ws = null;
    this._isReady = false;
    this._unsubFrame = null;
    this._lastSendTs = 0;
    this._lastErr = '';
    this._lastRaw = null;
    this._lastCalibration = null;
    this._mappingMode = 'normalized';
    // For eye-gaze pipeline: stores the quadratic mapping fit during calibrate.
    // For head-pose / opencv pipelines: null, raw samples are already screen coords.
    this._mapping = null;
    // Server-advertised coord type from hello / per-frame. "gaze_vec" requires
    // mapping; "screen" is direct passthrough.
    this._coordType = 'screen';
    this._lastRecvTs = 0;
    this._sampleHzEma = 0;

    // Populated by the server's hello handshake — drives the visible
    // backend status pill ("Intel NPU", "OpenCV-CPU", etc.).
    this._remote = {
      backend: null,
      device: null,
      faceModel: null,
      headposeModel: null,
      protocol: null,
    };
    this._inferenceMsEma = 0;

    this._canvas = null;
    this._ctx = null;
  }

  async start() {
    if (this._isReady) return;
    await this._connect();
    this._ensureCanvas();
    this._unsubFrame = this.webcam.onFrame((video, ts) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      if (ts - this._lastSendTs < this.sendIntervalMs) return;
      this._lastSendTs = ts;
      this._sendFrame(video);
    }, 24);
    this._isReady = true;
  }

  stop() {
    if (this._unsubFrame) {
      this._unsubFrame();
      this._unsubFrame = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._isReady = false;
    this._lastRaw = null;
  }

  async calibrate({ preCenterMs = 1500, dwellMs = 700 } = {}) {
    // Eye-gaze pipeline: server sends gaze vectors; we MUST fit a per-user
    // quadratic mapping or the mask won't track. 9-point overlay
    // calibration shared with the MediaPipe path.
    if (this._coordType === 'gaze_vec') {
      const result = await runQuadraticCalibration({
        width: window.innerWidth,
        height: window.innerHeight,
        getSample: () => (this._lastRaw && this._lastRaw.quality >= 0.4 ? this._lastRaw : null),
        dwellMs,
        qualityMin: 0.4,
      });
      this._mapping = result.mapping;
      this._mappingMode = 'quadratic';
      this._lastCalibration = {
        passed: result.grade !== 'weak' || result.rmsePx <= 360,
        grade: result.grade,
        mode: 'bridge-eye-gaze',
        samples: result.sampleCount,
        rmsePx: result.rmsePx,
      };
      return true;
    }

    // Head-pose / OpenCV pipelines: server already returns screen-normalized
    // coords. A center-baseline is enough — we record where "looking
    // forward" lands so the EyeTracker filter can debias drift.
    const ms = Math.max(800, preCenterMs | 0);
    const t0 = performance.now();
    const samples = [];
    let lowQualitySeen = 0;
    while (performance.now() - t0 < ms) {
      if (this._lastRaw) {
        if (this._lastRaw.quality >= 0.4) {
          samples.push({ x: this._lastRaw.x, y: this._lastRaw.y });
        } else {
          lowQualitySeen += 1;
        }
      }
      await _sleep(28);
    }
    if (samples.length < 8) {
      const total = samples.length + lowQualitySeen;
      const reason = lowQualitySeen > samples.length
        ? 'face not detected — improve lighting / center your face'
        : 'insufficient gaze samples';
      throw new Error(`OpenVINO bridge calibration failed: ${reason} (${samples.length}/${total} usable samples)`);
    }
    const cx = samples.reduce((a, s) => a + s.x, 0) / samples.length;
    const cy = samples.reduce((a, s) => a + s.y, 0) / samples.length;
    this._lastCalibration = {
      passed: true,
      grade: 'quick',
      mode: 'bridge-head-pose',
      samples: samples.length,
      lowQualityRejected: lowQualitySeen,
      center: { x: cx, y: cy },
    };
    return true;
  }

  getDiagnostics() {
    const staleMs = this._lastRecvTs ? performance.now() - this._lastRecvTs : Infinity;
    return {
      backend: 'openvino-bridge',
      pipeline: this._remote?.pipeline || null,
      coordType: this._coordType,
      calibration: this._lastCalibration,
      loadState: this._isReady ? 'ready' : 'idle',
      lastError: this._lastErr,
      mappingMode: this._mapping ? 'quadratic' : (this._coordType === 'gaze_vec' ? 'fallback-uncalibrated' : 'screen-passthrough'),
      staleMs,
      sampleHz: this._sampleHzEma,
      remote: { ...this._remote },
      inferenceMs: this._inferenceMsEma,
    };
  }

  // User-friendly label for the live backend, used by the status pill.
  // Examples: "Intel NPU", "Intel GPU", "Intel CPU", "OpenCV (no AI)",
  // "Bridge connected" (before hello arrives).
  getBackendLabel() {
    const r = this._remote;
    if (!r || !r.backend) return 'Bridge connected';
    if (r.backend === 'openvino') {
      const dev = (r.device || 'CPU').toUpperCase();
      if (dev === 'NPU') return 'Intel NPU';
      if (dev === 'GPU') return 'Intel GPU (iGPU)';
      if (dev === 'CPU') return 'Intel CPU (OpenVINO)';
      return `OpenVINO ${dev}`;
    }
    if (r.backend === 'opencv') return 'OpenCV (no AI accel)';
    return r.backend;
  }

  async _connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      let done = false;
      const ws = new WebSocket(this.wsUrl);
      // 5s instead of 2.5s — OpenVINO model compile + NPU init can take
      // 5-15s on cold boot. The previous 2.5s window declared the bridge
      // unreachable while it was still legitimately starting.
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.close(); } catch {}
        reject(new Error(`OpenVINO bridge timeout: ${this.wsUrl}`));
      }, 5000);

      ws.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this._ws = ws;
        ws.onmessage = (ev) => this._onMessage(ev);
        ws.onerror = () => { this._lastErr = 'OpenVINO bridge socket error'; };
        // Auto-reconnect on transient drops. The previous empty handler
        // silently abandoned the connection on any close, so a momentary
        // server hiccup permanently downgraded the demo to MediaPipe.
        ws.onclose = (ev) => this._scheduleReconnect(ev);
        resolve();
      };

      ws.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        reject(new Error(`OpenVINO bridge unreachable: ${this.wsUrl}`));
      };
    });
  }

  _scheduleReconnect(closeEvent) {
    if (!this._isReady) return; // user-initiated stop()
    this._ws = null;
    this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
    if (this._reconnectAttempts > 3) {
      this._lastErr = `Bridge dropped after ${this._reconnectAttempts - 1} reconnect attempts`;
      console.warn('[OpenVinoBridge]', this._lastErr);
      return;
    }
    // Exponential backoff: 1s, 2s, 5s.
    const delay = [1000, 2000, 5000][this._reconnectAttempts - 1];
    console.info(
      `[OpenVinoBridge] reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/3, close=${closeEvent?.code || 'n/a'})`,
    );
    setTimeout(async () => {
      if (!this._isReady) return;
      try {
        await this._connect();
        this._reconnectAttempts = 0;
        console.info('[OpenVinoBridge] reconnected');
      } catch (e) {
        this._lastErr = e?.message || String(e);
      }
    }, delay);
  }

  _ensureCanvas() {
    if (this._canvas) return;
    // OffscreenCanvas where supported — `convertToBlob` is async and yields
    // to the event loop, freeing the main thread for video paint and the
    // RenderController shader pass. Falls back to a regular canvas with
    // `toBlob` (also async) on older browsers.
    // 240×180 (4:3) gives the face detector ~2× the pixel area of 160×120
    // without meaningfully bumping bandwidth (still well under 100 KB/frame
    // at quality 0.65). 160×120 was starving the face detector at booth
    // distance; 320×240 was the original webcam capture, no upside in
    // sending higher than that.
    if (typeof OffscreenCanvas !== 'undefined') {
      this._canvas = new OffscreenCanvas(240, 180);
      this._isOffscreen = true;
    } else {
      this._canvas = document.createElement('canvas');
      this._canvas.width = 240;
      this._canvas.height = 180;
      this._isOffscreen = false;
    }
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
    this._sendInFlight = false;
  }

  _sendFrame(video) {
    if (!video || video.videoWidth === 0 || !this._ctx) return;
    // Drop the new frame if the previous JPEG encode hasn't shipped yet.
    // Stops a slow encoder from queueing several frames behind it and
    // saturating the WS, which was the freeze symptom.
    if (this._sendInFlight) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    try {
      this._ctx.drawImage(video, 0, 0, this._canvas.width, this._canvas.height);
    } catch (e) {
      this._lastErr = e?.message || String(e);
      return;
    }

    this._sendInFlight = true;
    const ts = performance.now();
    // OffscreenCanvas → convertToBlob (async, off main thread on modern
    // engines). Regular canvas → toBlob (async via task queue).
    const blobPromise = this._isOffscreen
      ? this._canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 })
      : new Promise((resolve, reject) => {
          this._canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
            'image/jpeg',
            0.65,
          );
        });

    blobPromise
      .then((blob) => blob.arrayBuffer())
      .then((buf) => {
        this._sendInFlight = false;
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        // 16-byte header carries metadata; rest is raw JPEG bytes. Saves
        // ~33% bandwidth vs base64 + zero JSON parse on the server side.
        // Layout: [u8 magic=0xE1, u8 version=1, u16 width, u16 height,
        //          u8 reserved x2, f64 client_ts] + jpeg bytes
        const header = new ArrayBuffer(16);
        const dv = new DataView(header);
        dv.setUint8(0, 0xE1);
        dv.setUint8(1, 1);
        dv.setUint16(2, this._canvas.width, true);
        dv.setUint16(4, this._canvas.height, true);
        dv.setFloat64(8, ts, true);
        const jpeg = new Uint8Array(buf);
        const out = new Uint8Array(header.byteLength + jpeg.byteLength);
        out.set(new Uint8Array(header), 0);
        out.set(jpeg, header.byteLength);
        try { this._ws.send(out.buffer); }
        catch (e) { this._lastErr = e?.message || String(e); }
      })
      .catch((e) => {
        this._sendInFlight = false;
        this._lastErr = e?.message || String(e);
      });
  }

  _onMessage(ev) {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'hello') {
        this._remote = {
          backend: msg.backend || null,
          pipeline: msg.pipeline || null,
          device: msg.device || null,
          faceModel: msg.face_model || null,
          landmarksModel: msg.landmarks_model || null,
          headposeModel: msg.headpose_model || null,
          gazeModel: msg.gaze_model || null,
          precision: msg.precision || null,
          reason: msg.reason || null,
          protocol: msg.protocol || null,
        };
        // The pipeline tells us whether to apply mapping or pass through.
        this._coordType = msg.pipeline === 'eye-gaze' ? 'gaze_vec' : 'screen';
        // Loud, friendly confirmation in DevTools — useful at the booth so
        // the presenter can prove the NPU path is actually live.
        console.info(
          `[OpenVinoBridge] Live backend = ${this._remote.backend} on device ${this._remote.device}`,
          this._remote.faceModel ? `(face=${this._remote.faceModel})` : '',
        );
        return;
      }

      if (msg.type === 'pong') {
        // liveness reply — no action needed beyond resetting the lastRecvTs
        this._lastRecvTs = performance.now();
        return;
      }

      if (msg.type !== 'gaze') return;
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;

      const now = performance.now();
      if (this._lastRecvTs) {
        const dt = Math.max(1 / 120, (now - this._lastRecvTs) / 1000);
        const hz = 1 / dt;
        this._sampleHzEma = this._sampleHzEma === 0 ? hz : _lerp(this._sampleHzEma, hz, 0.1);
      }
      this._lastRecvTs = now;

      if (Number.isFinite(msg.inferenceMs)) {
        this._inferenceMsEma = this._inferenceMsEma === 0
          ? msg.inferenceMs
          : _lerp(this._inferenceMsEma, msg.inferenceMs, 0.2);
      }

      // Per-frame coord_type from server overrides hello's hint if present
      // (defensive — handles a server upgrade mid-session).
      const coordType = msg.coord_type || this._coordType || 'screen';
      this._coordType = coordType;

      const quality = _clamp(Number.isFinite(msg.quality) ? msg.quality : 0.6, 0, 1);

      let screenX, screenY;
      if (coordType === 'gaze_vec') {
        // msg.x, msg.y are gaze vector components, roughly [-1, 1]. Stash
        // raw for the calibrate routine to consume; pass through mapping
        // for live gaze.
        this._lastRaw = { x: msg.x, y: msg.y, quality };
        if (this._mapping) {
          const mapped = applyMappingFor(this._mapping, { x: msg.x, y: msg.y });
          if (!mapped) return;
          screenX = _clamp(mapped.x, -window.innerWidth * 0.10, window.innerWidth * 1.10);
          screenY = _clamp(mapped.y, -window.innerHeight * 0.10, window.innerHeight * 1.10);
        } else {
          // No calibration yet — fall back to a naive ±30° → screen mapping
          // so the marker isn't pinned to the corner. The user should run
          // calibrate to get accurate gaze.
          screenX = window.innerWidth * (0.5 + _clamp(msg.x, -1, 1) * 0.4);
          screenY = window.innerHeight * (0.5 + _clamp(msg.y, -1, 1) * 0.4);
        }
      } else {
        // Legacy screen-coord path (head-pose / opencv backends).
        screenX = _clamp(msg.x, 0, 1) * window.innerWidth;
        screenY = _clamp(msg.y, 0, 1) * window.innerHeight;
        this._lastRaw = { x: screenX, y: screenY, quality };
      }

      this.onGaze(screenX, screenY, {
        quality,
        ts: now,
        source: 'openvino-bridge',
      });
    } catch (e) {
      this._lastErr = e?.message || String(e);
    }
  }
}

// Lightweight one-shot probe for the bridge. Used by the UI on first webcam
// enable so we can show "Bridge ready on Intel NPU" *before* the user
// commits to the slower MediaPipe boot. Resolves with the hello payload or
// rejects on timeout / error.
OpenVinoBridgeTracker.probe = function probe(wsUrl = 'ws://127.0.0.1:8765', timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      try { if (ws) ws.close(); } catch {}
      fn(val);
    };
    const timer = setTimeout(() => finish(reject, new Error(`probe timeout: ${wsUrl}`)), timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === 'hello') {
          clearTimeout(timer);
          finish(resolve, msg);
        }
      } catch {}
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish(reject, new Error(`bridge unreachable: ${wsUrl}`));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (!done) finish(reject, new Error('bridge closed before hello'));
    };
  });
};

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

