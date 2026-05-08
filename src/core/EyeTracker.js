export class EyeTracker {
  constructor() {
    this.screenCenterX = window.innerWidth / 2;
    this.screenCenterY = window.innerHeight / 2;

    // Stabilized gaze point used by rendering. Null means fallback (mouse or center).
    this.gazeOverride = null;
    this.disableMouse = false;

    this._raw = null;
    this._filtered = null;
    this._output = null;
    this._lastTs = 0;
    this._lastRawTs = 0;
    this._lastQuality = 0;
    this._velocity = 0;
    this._sampleHzEma = 0;
    this._backend = 'none';
    this._mode = 'idle'; // idle | fine | coarse | reacquire | lost
    this._rejectedJumpCount = 0;
    this._sampleCount = 0;

    this._derivativeX = 0;
    this._derivativeY = 0;

    this._zoneStable = null;
    this._zonePending = null;
    this._zonePendingSince = 0;
    this._intentTarget = null;
    this._intentSince = 0;
    this._glide = null;
    this._aiAssist = {
      enabled: true,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      biasX: 0,
      biasY: 0,
      ready: false,
    };

    window.addEventListener('resize', () => {
      this.screenCenterX = window.innerWidth / 2;
      this.screenCenterY = window.innerHeight / 2;
    });
  }

  setActiveBackend(name) {
    this._backend = name || 'none';
  }

  setGazeSample(x, y, { quality = 1, ts = performance.now(), source = null } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    if (source) this._backend = source;
    const now = Number.isFinite(ts) ? ts : performance.now();
    const dt = this._lastTs > 0 ? Math.max(1 / 120, (now - this._lastTs) / 1000) : 1 / 60;
    const hz = 1 / Math.max(dt, 1 / 240);
    this._sampleHzEma = this._sampleHzEma === 0 ? hz : _lerp(this._sampleHzEma, hz, 0.1);

    const clamped = {
      x: _clamp(x, 0, window.innerWidth),
      y: _clamp(y, 0, window.innerHeight),
    };

    const q = _clamp(Number.isFinite(quality) ? quality : 0.5, 0, 1);
    this._sampleCount += 1;

    if (!this._raw) {
      this._raw = { ...clamped };
      this._filtered = { ...clamped };
      this._output = { ...clamped };
      this._glide = { ...clamped };
      this.gazeOverride = { ...clamped };
      this._zoneStable = this._zoneFromPoint(clamped.x, clamped.y);
      this._zonePending = this._zoneStable;
      this._zonePendingSince = now;
      this._lastTs = now;
      this._lastRawTs = now;
      this._lastQuality = q;
      this._mode = q < 0.45 ? 'coarse' : 'fine';
      return;
    }

    const dxRaw = clamped.x - this._raw.x;
    const dyRaw = clamped.y - this._raw.y;
    const rawSpeed = Math.hypot(dxRaw, dyRaw) / dt;

    // Confidence/outlier gating: suppress improbable jumps on low-confidence frames.
    const maxSpeed = 1150; // px/s
    const jumpIsSuspicious = rawSpeed > maxSpeed && q < 0.72;
    let accepted = clamped;

    if (jumpIsSuspicious) {
      this._rejectedJumpCount += 1;
      const maxStep = maxSpeed * dt;
      const dist = Math.hypot(dxRaw, dyRaw) || 1;
      accepted = {
        x: this._raw.x + (dxRaw / dist) * maxStep,
        y: this._raw.y + (dyRaw / dist) * maxStep,
      };
    }

    // Micro-jitter deadzone: suppress tiny noise-induced movement.
    const microDist = Math.hypot(accepted.x - this._raw.x, accepted.y - this._raw.y);
    if (microDist < 14 && q < 0.95) {
      accepted = { ...this._raw };
    }

    // One-Euro style filter tuned for webcam jitter.
    const dCutoff = 0.75;
    const minCutoff = 0.16 + (1 - q) * 0.32;
    const beta = 0.004 + q * 0.014;

    const rawVx = (accepted.x - this._raw.x) / dt;
    const rawVy = (accepted.y - this._raw.y) / dt;

    const alphaD = _alpha(dCutoff, dt);
    this._derivativeX = _lerp(this._derivativeX, rawVx, alphaD);
    this._derivativeY = _lerp(this._derivativeY, rawVy, alphaD);

    const speed = Math.hypot(this._derivativeX, this._derivativeY);
    this._velocity = speed;

    const cutoff = minCutoff + beta * speed;
    const alpha = _alpha(cutoff, dt);

    this._filtered.x = _lerp(this._filtered.x, accepted.x, alpha);
    this._filtered.y = _lerp(this._filtered.y, accepted.y, alpha);

    const nextZone = this._zoneFromPoint(this._filtered.x, this._filtered.y);
    this._applyZoneHysteresis(nextZone, now, speed);
    const zoneCenter = this._zoneCenter(this._zoneStable);

    const isCoarse = q < 0.45 || this._sampleHzEma < 12;
    if (isCoarse) {
      this._mode = 'coarse';
      this._output.x = _lerp(this._output.x, zoneCenter.x, 0.12);
      this._output.y = _lerp(this._output.y, zoneCenter.y, 0.12);
    } else {
      this._mode = q < 0.52 ? 'reacquire' : 'fine';
      const speedRatio = _clamp(speed / 1000, 0, 1);
      const magnet = (1 - speedRatio) * (0.12 + q * 0.12);

      const magneticX = _lerp(this._filtered.x, zoneCenter.x, magnet);
      const magneticY = _lerp(this._filtered.y, zoneCenter.y, magnet);
      const distToOutput = Math.hypot(magneticX - this._output.x, magneticY - this._output.y);
      const holdRadius = 72;
      const commitRadius = 96;
      const moveConfirmMs = speed > 700 ? 120 : 190;

      if (distToOutput < holdRadius) {
        this._intentTarget = null;
        this._intentSince = 0;
        this._output.x = _lerp(this._output.x, magneticX, 0.012);
        this._output.y = _lerp(this._output.y, magneticY, 0.012);
      } else if (distToOutput < commitRadius) {
        this._intentTarget = null;
        this._intentSince = 0;
        this._output.x = _lerp(this._output.x, magneticX, 0.03);
        this._output.y = _lerp(this._output.y, magneticY, 0.03);
      } else {
        const sameIntent = this._intentTarget
          && Math.hypot(this._intentTarget.x - magneticX, this._intentTarget.y - magneticY) < 64;
        if (!sameIntent) {
          this._intentTarget = { x: magneticX, y: magneticY };
          this._intentSince = now;
        }

        const intentMs = now - this._intentSince;
        if (intentMs >= moveConfirmMs) {
          const outputAlpha = speedRatio > 0.45 ? 0.18 : 0.1;
          this._output.x = _lerp(this._output.x, magneticX, outputAlpha);
          this._output.y = _lerp(this._output.y, magneticY, outputAlpha);
        }
      }
    }

    const aiOutput = this._runAiAssist(this._output.x, this._output.y, q, dt);
    if (!this._glide) this._glide = { ...aiOutput };
    const glideAlpha = speed > 800 ? 0.14 : 0.075;
    this._glide.x = _lerp(this._glide.x, aiOutput.x, glideAlpha);
    this._glide.y = _lerp(this._glide.y, aiOutput.y, glideAlpha);

    this.gazeOverride = {
      x: _clamp(this._glide.x, 0, window.innerWidth),
      y: _clamp(this._glide.y, 0, window.innerHeight),
    };

    this._raw = accepted;
    this._lastTs = now;
    this._lastRawTs = now;
    this._lastQuality = q;
  }

  clearGazeSample() {
    this.gazeOverride = null;
    this._raw = null;
    this._filtered = null;
    this._output = null;
    this._lastTs = 0;
    this._lastRawTs = 0;
    this._lastQuality = 0;
    this._velocity = 0;
    this._sampleHzEma = 0;
    this._mode = 'idle';
    this._derivativeX = 0;
    this._derivativeY = 0;
    this._zoneStable = null;
    this._zonePending = null;
    this._zonePendingSince = 0;
    this._intentTarget = null;
    this._intentSince = 0;
    this._glide = null;
    this._aiAssist.ready = false;
    this._aiAssist.vx = 0;
    this._aiAssist.vy = 0;
    this._aiAssist.biasX = 0;
    this._aiAssist.biasY = 0;
  }

  getDiagnostics() {
    const staleMs = this._lastRawTs ? performance.now() - this._lastRawTs : Infinity;
    const zone = Number.isFinite(this._zoneStable) ? this._zoneStable : -1;
    return {
      backend: this._backend,
      mode: staleMs > 450 ? 'lost' : this._mode,
      quality: this._lastQuality,
      velocity: this._velocity,
      sampleHz: this._sampleHzEma,
      staleMs,
      zone,
      rejectedJumps: this._rejectedJumpCount,
      samples: this._sampleCount,
    };
  }

  // Sample geometric features from stabilized gaze input.
  extractFeatures(mouseX, mouseY) {
    const mx = this.disableMouse ? this.screenCenterX : mouseX;
    const my = this.disableMouse ? this.screenCenterY : mouseY;

    if (this.disableMouse && this.gazeOverride && this._lastRawTs) {
      const staleMs = performance.now() - this._lastRawTs;
      if (staleMs > 350) {
        this._mode = 'lost';
        // If signal drops, gently re-center instead of freezing forever.
        this.gazeOverride.x = _lerp(this.gazeOverride.x, this.screenCenterX, 0.02);
        this.gazeOverride.y = _lerp(this.gazeOverride.y, this.screenCenterY, 0.02);
      }
    }

    const gx = this.gazeOverride ? this.gazeOverride.x : mx;
    const gy = this.gazeOverride ? this.gazeOverride.y : my;

    const qualityNorm = _clamp(this._lastQuality || 0.5, 0, 1);
    const pupilDiameter = 4.2 + qualityNorm * 0.8;

    const features = {
      pupilPosXLeft: gx - 30,
      pupilPosYLeft: gy,
      pupilPosXRight: gx + 30,
      pupilPosYRight: gy,
      pupilDiameterLeft: pupilDiameter,
      pupilDiameterRight: pupilDiameter,
      saccadeVelocity: this._velocity,
      gazeOriginX: gx,
      gazeOriginY: gy,
      gazeOriginZ: 600,
      gazeConfidence: qualityNorm,
    };

    features.gazeDeviation = Math.pow(features.gazeOriginX - this.screenCenterX, 2)
      + Math.pow(features.gazeOriginY - this.screenCenterY, 2);

    return features;
  }

  _zoneFromPoint(x, y) {
    const nx = _clamp(x / Math.max(1, window.innerWidth), 0, 0.9999);
    const ny = _clamp(y / Math.max(1, window.innerHeight), 0, 0.9999);
    const col = Math.min(2, Math.floor(nx * 3));
    const row = Math.min(2, Math.floor(ny * 3));
    return row * 3 + col;
  }

  _zoneCenter(zoneIdx) {
    if (!Number.isFinite(zoneIdx) || zoneIdx < 0) {
      return { x: this.screenCenterX, y: this.screenCenterY };
    }
    const row = Math.floor(zoneIdx / 3);
    const col = zoneIdx % 3;
    const xAnchors = [0.1, 0.5, 0.9];
    const yAnchors = [0.1, 0.5, 0.9];
    return {
      x: xAnchors[col] * window.innerWidth,
      y: yAnchors[row] * window.innerHeight,
    };
  }

  _applyZoneHysteresis(nextZone, now, speed) {
    if (this._zoneStable === null) {
      this._zoneStable = nextZone;
      this._zonePending = nextZone;
      this._zonePendingSince = now;
      return;
    }

    if (nextZone === this._zoneStable) {
      this._zonePending = nextZone;
      this._zonePendingSince = now;
      return;
    }

    if (this._zonePending !== nextZone) {
      this._zonePending = nextZone;
      this._zonePendingSince = now;
      return;
    }

    const dwellMs = now - this._zonePendingSince;
    const requiredMs = speed > 700 ? 220 : 340;
    if (dwellMs >= requiredMs) {
      this._zoneStable = nextZone;
      this._zonePendingSince = now;
    }
  }

  _runAiAssist(x, y, q, dt) {
    if (!this._aiAssist.enabled) return { x, y };
    const st = this._aiAssist;

    if (!st.ready) {
      st.ready = true;
      st.x = x;
      st.y = y;
      st.vx = 0;
      st.vy = 0;
      st.biasX = 0;
      st.biasY = 0;
      return { x, y };
    }

    const predX = st.x + st.vx * dt;
    const predY = st.y + st.vy * dt;
    const rx = x - predX;
    const ry = y - predY;
    const residual = Math.hypot(rx, ry);
    const smoothGain = residual < 32 ? 0.11 : residual < 84 ? 0.18 : 0.28;
    const confGain = _clamp(0.55 + q * 0.45, 0.55, 1.0);
    const kPos = smoothGain * confGain;
    const kVel = _clamp(0.6 * kPos, 0.05, 0.22);

    st.x = predX + kPos * rx;
    st.y = predY + kPos * ry;
    st.vx = _lerp(st.vx, (kVel * rx) / Math.max(dt, 1 / 120), 0.42);
    st.vy = _lerp(st.vy, (kVel * ry) / Math.max(dt, 1 / 120), 0.42);

    const driftLike = residual < 18 && Math.hypot(st.vx, st.vy) < 120;
    if (driftLike) {
      st.biasX = _lerp(st.biasX, st.x - x, 0.05);
      st.biasY = _lerp(st.biasY, st.y - y, 0.05);
    } else {
      st.biasX = _lerp(st.biasX, 0, 0.02);
      st.biasY = _lerp(st.biasY, 0, 0.02);
    }

    return {
      x: st.x - st.biasX,
      y: st.y - st.biasY,
    };
  }
}

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _alpha(cutoff, dt) {
  const safeCutoff = Math.max(0.001, cutoff);
  const tau = 1 / (2 * Math.PI * safeCutoff);
  return 1 / (1 + tau / Math.max(0.0001, dt));
}
