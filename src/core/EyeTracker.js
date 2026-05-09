// Single source of truth for "no fresh gaze sample" timeout. extractFeatures
// re-centers only after a much longer window so brief MediaPipe drops at the
// edge of frame don't yank gaze back to center (the "must recalibrate to look
// at corner again" symptom).
export const STALE_LOST_MS = 450;          // mode/banner flip
export const STALE_RECENTER_MS = 1500;     // start re-centering only after 1.5s of silence

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
    // Anchor + leash: shader visually rests at _anchor. Gaze movement within
    // ANCHOR_RADIUS_PX of _anchor leaves it untouched (no jitter fatigue).
    // Once gaze leaves the zone, the anchor smoothly catches up — the
    // further/longer it's been escaping, the faster it pulls.
    this._anchor = null;
    this._anchorEscapeMs = 0; // accumulated time gaze has been outside the leash
    this.ANCHOR_RADIUS_PX = 90; // hold radius — ~1° visual angle at desk distance
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
      this._anchor = { ...clamped };
      this._anchorEscapeMs = 0;
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

    // Adaptive micro-jitter deadzone. Static gaze with high confidence collapses
    // to a tight 12px ring; low confidence or motion relaxes up to 32px so we
    // don't swallow real saccades. The previous fixed 26px occasionally let
    // single-pixel jitter through on long fixations.
    const microDist = Math.hypot(accepted.x - this._raw.x, accepted.y - this._raw.y);
    const motionFactor = _clamp(rawSpeed / 600, 0, 1);
    const deadzonePx = _lerp(12, 32, Math.max(motionFactor, 1 - q));
    if (microDist < deadzonePx && q < 0.98) {
      accepted = { ...this._raw };
    }

    // One-Euro style filter tuned for webcam jitter.
    const dCutoff = 0.75;
    const minCutoff = 0.1 + (1 - q) * 0.22;
    const beta = 0.003 + q * 0.01;

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
      this._output.x = _lerp(this._output.x, zoneCenter.x, 0.08);
      this._output.y = _lerp(this._output.y, zoneCenter.y, 0.08);
    } else {
      this._mode = q < 0.52 ? 'reacquire' : 'fine';
      const speedRatio = _clamp(speed / 1000, 0, 1);
      // Weaker magnet — the prior 0.08 + q*0.09 over-snapped to zone centers
      // and contributed to the "calibration looks off after pass" complaint.
      // Calibrated mapping is good enough that we can trust filtered position
      // more than the 3×3 zone grid.
      // Edge & corner zones additionally suppress the magnet entirely. With
      // anchors now at 5%/95%, a corner zone tugs gaze *toward* the corner
      // which is correct, but pulling tilts the mask into the chrome the
      // moment the user's eye drifts a few pixels back — the "失焦" symptom.
      const isEdgeZone = (this._zoneStable !== null
        && this._zoneStable !== 4 // center
        && Number.isFinite(this._zoneStable));
      const magnetBase = isEdgeZone ? 0 : (0.04 + q * 0.05);
      const magnet = (1 - speedRatio) * magnetBase;

      const magneticX = _lerp(this._filtered.x, zoneCenter.x, magnet);
      const magneticY = _lerp(this._filtered.y, zoneCenter.y, magnet);
      const distToOutput = Math.hypot(magneticX - this._output.x, magneticY - this._output.y);

      // Continuous distance-based alpha replaces the previous banded
      // (hold / commit / intent-gate) output controller. Bands had two
      // problems: (a) crossing a boundary visibly stepped the mask because
      // alpha jumped 3-5×, (b) the intent-gate added 110-180 ms of latency
      // before any far movement registered.
      //
      // The smooth curve below:
      //   - Idle smoothness: tiny distance → small alpha (~0.022)
      //   - Linear ramp:     ~250 px → ~0.11
      //   - Saccade catchup: 600+ px → caps at 0.32
      // baseAlpha is scaled by quality so flickery low-quality samples
      // contribute less. The intent gate is gone; the output filter +
      // glide pass below already provide enough smoothing.
      const distRatio = _clamp(distToOutput / 600, 0, 1);
      const qualityScale = 0.6 + q * 0.4;
      const outputAlpha = (0.022 + distRatio * distRatio * 0.30) * qualityScale;
      this._intentTarget = null;
      this._intentSince = 0;
      this._output.x = _lerp(this._output.x, magneticX, outputAlpha);
      this._output.y = _lerp(this._output.y, magneticY, outputAlpha);
    }

    const aiOutput = this._runAiAssist(this._output.x, this._output.y, q, dt);
    if (!this._glide) this._glide = { ...aiOutput };
    // Continuous glide alpha — replaces the previous 3-band step function
    // that produced visible "judder" when crossing band boundaries during
    // smooth pursuit. Quadratic distance term keeps idle smooth (≈0.06)
    // while saccade-distance jumps reach 0.26 quickly.
    const glideDist = Math.hypot(aiOutput.x - this._glide.x, aiOutput.y - this._glide.y);
    const glideRatio = _clamp(glideDist / 100, 0, 1);
    const speedRatio2 = _clamp(speed / 800, 0, 1);
    const glideAlpha = 0.06 + Math.max(glideRatio * glideRatio, speedRatio2) * 0.20;
    this._glide.x = _lerp(this._glide.x, aiOutput.x, glideAlpha);
    this._glide.y = _lerp(this._glide.y, aiOutput.y, glideAlpha);

    // Anchor + leash. The shader-visible position (this.gazeOverride) is the
    // *anchor*, not the live glide. As long as glide stays within
    // ANCHOR_RADIUS_PX of the anchor, the anchor doesn't move at all — so
    // small natural saccades / tracker jitter don't drag the mask around.
    // Once glide escapes the leash, the anchor catches up with a soft
    // ease-out: the longer + further glide has been outside, the faster
    // the catch-up alpha. When glide returns inside the leash, the anchor
    // freezes wherever it last reached, and escape-time decays.
    if (!this._anchor) this._anchor = { x: this._glide.x, y: this._glide.y };
    const anchorDx = this._glide.x - this._anchor.x;
    const anchorDy = this._glide.y - this._anchor.y;
    const anchorDist = Math.hypot(anchorDx, anchorDy);
    const dtMs = Math.max(1, dt * 1000);

    if (anchorDist > this.ANCHOR_RADIUS_PX) {
      // Outside leash — accumulate escape time and pull anchor toward glide.
      this._anchorEscapeMs += dtMs;
      const escapeDist = anchorDist - this.ANCHOR_RADIUS_PX;
      // alpha grows with both (a) how far past the leash we are and
      // (b) how long we've been past it. Capped so a sudden far jump
      // doesn't snap; bounded so a slow drift still eventually catches up.
      const distFactor = _clamp(escapeDist / 220, 0, 1);
      const timeFactor = _clamp(this._anchorEscapeMs / 240, 0, 1);
      const anchorAlpha = 0.014 + Math.max(distFactor * distFactor, timeFactor) * 0.10;
      this._anchor.x += anchorDx * anchorAlpha;
      this._anchor.y += anchorDy * anchorAlpha;
    } else {
      // Inside leash — freeze anchor, decay escape timer so a brief
      // excursion doesn't bias the next escape's alpha curve.
      this._anchorEscapeMs = Math.max(0, this._anchorEscapeMs - dtMs * 1.5);
    }

    this.gazeOverride = {
      x: _clamp(this._anchor.x, 0, window.innerWidth),
      y: _clamp(this._anchor.y, 0, window.innerHeight),
    };

    this._raw = accepted;
    this._lastTs = now;
    this._lastRawTs = now;
    this._lastQuality = q;
  }

  // Wipe drift-bias accumulated by AI assist without dropping the live filter
  // chain. Calibration completion should call this so any pre-calibration bias
  // doesn't leak into the calibrated pipeline as a permanent offset.
  clearAiAssistBias() {
    this._aiAssist.biasX = 0;
    this._aiAssist.biasY = 0;
    this._aiAssist.vx = 0;
    this._aiAssist.vy = 0;
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
    this._anchor = null;
    this._anchorEscapeMs = 0;
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
      mode: staleMs > STALE_LOST_MS ? 'lost' : this._mode,
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
      if (staleMs > STALE_RECENTER_MS) {
        this._mode = 'lost';
        // Very gentle re-center (0.005 instead of 0.02) so a brief MediaPipe
        // drop at the edge of frame doesn't snap gaze back to center. After
        // 1.5s of silence we *suggest* the center but the user can still
        // saccade out without needing a recalibrate. Also drift the anchor
        // toward center so the next live sample's leash is computed against
        // the recenter, not the stale corner.
        this.gazeOverride.x = _lerp(this.gazeOverride.x, this.screenCenterX, 0.005);
        this.gazeOverride.y = _lerp(this.gazeOverride.y, this.screenCenterY, 0.005);
        if (this._anchor) {
          this._anchor.x = _lerp(this._anchor.x, this.screenCenterX, 0.005);
          this._anchor.y = _lerp(this._anchor.y, this.screenCenterY, 0.005);
        }
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
    // Edge zones now anchor at the actual edge (5%/95%) instead of 10%/90%.
    // Previously a gaze at 5% sat 64px inside the holdRadius (180px) so the
    // mask refused to follow into the corner — the "sticking" symptom.
    const xAnchors = [0.05, 0.5, 0.95];
    const yAnchors = [0.05, 0.5, 0.95];
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
    const requiredMs = speed > 700 ? 300 : 460;
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
    const smoothGain = residual < 32 ? 0.08 : residual < 84 ? 0.14 : 0.22;
    const confGain = _clamp(0.55 + q * 0.45, 0.55, 1.0);
    const kPos = smoothGain * confGain;
    const kVel = _clamp(0.52 * kPos, 0.04, 0.18);

    st.x = predX + kPos * rx;
    st.y = predY + kPos * ry;
    st.vx = _lerp(st.vx, (kVel * rx) / Math.max(dt, 1 / 120), 0.42);
    st.vy = _lerp(st.vy, (kVel * ry) / Math.max(dt, 1 / 120), 0.42);

    // Edge guard: when gaze sits in the outer 15% of the screen, freeze drift
    // bias accumulation. The prior unconditional drift learn would lock in a
    // corner-direction bias during long fixations on the edge of the video
    // frame, which then yanked the mask the wrong way the moment the user's
    // gaze returned to center. Decay any accumulated bias gently in this band.
    const nx = x / Math.max(1, window.innerWidth);
    const ny = y / Math.max(1, window.innerHeight);
    const onEdgeBand = nx < 0.15 || nx > 0.85 || ny < 0.15 || ny > 0.85;

    const driftLike = residual < 14 && Math.hypot(st.vx, st.vy) < 90;
    if (driftLike && !onEdgeBand) {
      st.biasX = _lerp(st.biasX, st.x - x, 0.05);
      st.biasY = _lerp(st.biasY, st.y - y, 0.05);
    } else {
      // Faster decay on edge band so any pre-existing bias dissipates before
      // the next saccade lands.
      const decay = onEdgeBand ? 0.06 : 0.02;
      st.biasX = _lerp(st.biasX, 0, decay);
      st.biasY = _lerp(st.biasY, 0, decay);
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
