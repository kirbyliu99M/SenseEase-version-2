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

  async calibrate({ preCenterMs = 1500 } = {}) {
    const ms = Math.max(800, preCenterMs | 0);
    const t0 = performance.now();
    let n = 0;
    let sx = 0;
    let sy = 0;

    while (performance.now() - t0 < ms) {
      if (this._lastRaw) {
        sx += this._lastRaw.x;
        sy += this._lastRaw.y;
        n += 1;
      }
      await _sleep(28);
    }

    if (n < 8) throw new Error('OpenVINO bridge calibration failed: insufficient gaze samples');
    const cx = sx / n;
    const cy = sy / n;
    this._lastCalibration = { passed: true, grade: 'quick', mode: 'bridge', samples: n, center: { x: cx, y: cy } };
    return true;
  }

  getDiagnostics() {
    const staleMs = this._lastRecvTs ? performance.now() - this._lastRecvTs : Infinity;
    return {
      backend: 'openvino-bridge',
      calibration: this._lastCalibration,
      loadState: this._isReady ? 'ready' : 'idle',
      lastError: this._lastErr,
      mappingMode: this._mappingMode,
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
    this._canvas = document.createElement('canvas');
    this._canvas.width = 160;
    this._canvas.height = 120;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
  }

  _sendFrame(video) {
    if (!video || video.videoWidth === 0 || !this._ctx) return;
    try {
      this._ctx.drawImage(video, 0, 0, this._canvas.width, this._canvas.height);
      const payload = this._canvas.toDataURL('image/jpeg', 0.55);
      this._ws.send(JSON.stringify({
        type: 'frame',
        width: this._canvas.width,
        height: this._canvas.height,
        image: payload,
        ts: performance.now(),
      }));
    } catch (e) {
      this._lastErr = e?.message || String(e);
    }
  }

  _onMessage(ev) {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'hello') {
        this._remote = {
          backend: msg.backend || null,
          device: msg.device || null,
          faceModel: msg.face_model || null,
          headposeModel: msg.headpose_model || null,
          precision: msg.precision || null,
          reason: msg.reason || null,
          protocol: msg.protocol || null,
        };
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

      // bridge payload expects normalized [0,1] coordinates.
      const x = _clamp(msg.x, 0, 1) * window.innerWidth;
      const y = _clamp(msg.y, 0, 1) * window.innerHeight;
      const quality = _clamp(Number.isFinite(msg.quality) ? msg.quality : 0.6, 0, 1);

      this._lastRaw = { x, y, quality };
      this.onGaze(x, y, {
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

