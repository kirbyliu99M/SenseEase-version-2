export class RenderController {
  constructor(ditheringShader) {
    this.shader = ditheringShader;
    this.fallbackOverlay = null;
    this.fovRadiusInner = 35;
    this.fovRadiusOuter = 45;
    this.mouseX = window.innerWidth / 2;
    this.mouseY = window.innerHeight / 2;
    this.directionX = 0;
    this.npuActive = false;

    this.targetElement = null;
    this.observer = null;
    this.eyeTracker = null;
    this.inferenceEngine = null;
    this.currentIntensity = 0.0;
    this.targetIntensitySmoothed = 0.0;
    this.maskVisible = false;
    this.currentRadiusInner = 130.0;
    this.userRadiusOffset = 0;
    this.radiusOverride = null;

    this.initMouseTracking();
    this.createFallbackOverlay();
  }

  forceHideMaskLayers() {
    if (this.shader?.isValid) {
      this.shader.setActive(false);
      this.shader.canvas.style.setProperty('display', 'none', 'important');
      this.shader.canvas.style.setProperty('opacity', '0', 'important');
    }

    if (this.fallbackOverlay) {
      this.fallbackOverlay.style.setProperty('display', 'none', 'important');
      this.fallbackOverlay.style.setProperty('opacity', '0', 'important');
      this.fallbackOverlay.style.background = 'none';
    }
  }

  showMaskLayers() {
    if (this.shader?.isValid) {
      this.shader.canvas.style.setProperty('display', 'block', 'important');
      this.shader.canvas.style.removeProperty('opacity');
      this.shader.setActive(true);
    } else if (this.fallbackOverlay) {
      this.fallbackOverlay.style.setProperty('display', 'block', 'important');
      this.fallbackOverlay.style.removeProperty('opacity');
    }
  }

  enforceKillSwitch() {
    this.currentIntensity = 0;
    this.targetIntensitySmoothed = 0;
    this.maskVisible = false;
    if (this.inferenceEngine) {
      // Kill-switch only controls rendering/mask visibility.
      // Do not mutate VIMS pressure here; pressure is owned by InferenceEngine.
      this.inferenceEngine.isMaskActive = false;
    }
    this.forceHideMaskLayers();
  }

  setTargetElement(el) {
    this.targetElement = el;
    if (!el) {
      this.currentIntensity = 0;
      this.targetIntensitySmoothed = 0;
      this.maskVisible = false;
      this.forceHideMaskLayers();
    }
  }

  initMouseTracking() {
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    const renderLoop = () => {
      // Absolute hardware kill-switch at frame head.
      if (!this.npuActive) {
        this.enforceKillSwitch();
        requestAnimationFrame(renderLoop);
        return;
      }

      // NPU may be active for non-FOV scenarios (e.g., Demo 2); keep layers hidden.
      if (!this.targetElement) {
        this.currentIntensity = 0;
        this.targetIntensitySmoothed = 0;
        this.maskVisible = false;
        this.forceHideMaskLayers();
        requestAnimationFrame(renderLoop);
        return;
      }

      const rect = this.targetElement.getBoundingClientRect();

      const currentFlow = this.observer ? this.observer.opticalFlow : 0;
      const currentPressure = this.inferenceEngine ? this.inferenceEngine.getPressure() : 0;

      const flowTerm = Math.max(0, Math.min(1, currentFlow / 120.0));
      const pressureTerm = Math.max(0, Math.min(1, currentPressure / 100.0));
      const adaptiveIntensity = Math.max(0.0, Math.min(1.0, (flowTerm * 0.35) + (pressureTerm * 0.85)));

      const activeDemoId = document.querySelector('#demo-sub-tabs .demo-sub-btn.active')?.dataset.demo;
      const isHabituationDemo = activeDemoId === 'demo-scen5';

      let targetIntensity = adaptiveIntensity;
      if (this.inferenceEngine?.isGlobalOverrideOn) {
        // Scenario 1 keeps full forced visibility; Habituation keeps adaptive tone but with a visible floor.
        targetIntensity = isHabituationDemo ? Math.max(0.55, adaptiveIntensity) : 1.0;
      }

      const targetFilter = targetIntensity > this.targetIntensitySmoothed ? 0.20 : 0.10;
      this.targetIntensitySmoothed += (targetIntensity - this.targetIntensitySmoothed) * targetFilter;

      const response = this.targetIntensitySmoothed > this.currentIntensity ? 0.16 : 0.06;
      const nextIntensity = this.currentIntensity + (this.targetIntensitySmoothed - this.currentIntensity) * response;
      const maxStep = 0.035;
      const delta = Math.max(-maxStep, Math.min(maxStep, nextIntensity - this.currentIntensity));
      this.currentIntensity = Math.max(0, Math.min(1, this.currentIntensity + delta));

      const SHOW_THRESHOLD = 0.018;
      const HIDE_THRESHOLD = 0.008;
      if (!this.maskVisible && this.currentIntensity >= SHOW_THRESHOLD) this.maskVisible = true;
      if (this.maskVisible && this.currentIntensity <= HIDE_THRESHOLD) this.maskVisible = false;

      if (this.maskVisible) {
        let gazeX = rect.width / 2;
        let gazeY = rect.height / 2;

        if (this.eyeTracker) {
          const features = this.eyeTracker.extractFeatures(this.mouseX, this.mouseY);
          gazeX = features.gazeOriginX - rect.left;
          gazeY = features.gazeOriginY - rect.top;
        }

        let targetRadiusInner = 130 - (currentFlow / 150) * 105;
        targetRadiusInner += this.userRadiusOffset;
        targetRadiusInner = Math.max(25, Math.min(130, targetRadiusInner));
        if (this.radiusOverride !== null) targetRadiusInner = this.radiusOverride;

        if (currentPressure > 100) targetRadiusInner -= 10;
        targetRadiusInner = Math.max(15, targetRadiusInner);

        this.currentRadiusInner += (targetRadiusInner - this.currentRadiusInner) * 0.01;
        const dynamicRadiusOuter = this.currentRadiusInner + 10;

        if (this.shader && this.shader.isValid) {
          this.showMaskLayers();
          this.shader.canvas.style.top = `${rect.top}px`;
          this.shader.canvas.style.left = `${rect.left}px`;
          this.shader.canvas.style.width = `${rect.width}px`;
          this.shader.canvas.style.height = `${rect.height}px`;

          this.shader.resize(rect.width, rect.height);
          this.shader.render(gazeX, gazeY, this.currentRadiusInner, dynamicRadiusOuter, this.currentIntensity);
        } else {
          this.showMaskLayers();
          this.updateFallbackMaskPosition(rect, gazeX, gazeY, this.currentRadiusInner, dynamicRadiusOuter, this.currentIntensity);
        }
      } else {
        if (this.shader && this.shader.isValid) {
          this.shader.render(0, 0, 100, 100, 0);
        }
        this.forceHideMaskLayers();
      }

      requestAnimationFrame(renderLoop);
    };

    renderLoop();
  }

  createFallbackOverlay() {
    this.fallbackOverlay = document.createElement('div');
    this.fallbackOverlay.id = 'senseease-overlay';
    Object.assign(this.fallbackOverlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '9999',
      display: 'none',
    });
    document.body.appendChild(this.fallbackOverlay);
  }

  setNpuState(isActive) {
    this.npuActive = !!isActive;
    if (!this.npuActive) this.enforceKillSwitch();
  }

  hardReset() {
    this.npuActive = false;
    this.currentIntensity = 0;
    this.radiusOverride = null;
    this.enforceKillSwitch();
  }

  triggerFOVMask(directionX = 0) {
    this.directionX = directionX;
    this.npuActive = true;
    // Reset chatbot offset on re-trigger so mask is effective again
    this.userRadiusOffset = 0;
    this.showMaskLayers();
  }

  removeFOVMask() {
    this.npuActive = false;
    this.enforceKillSwitch();
  }

  updateFallbackMaskPosition(rect, gazeX, gazeY, rIn, rOut, intensity) {
    const ov = this.fallbackOverlay;
    if (!ov) return;

    const vpGazeX = rect.left + gazeX;
    const vpGazeY = rect.top + gazeY;
    const rPx = rIn / 100 * Math.min(rect.width, rect.height) * 0.9;

    ov.style.setProperty('--fog-cx', `${vpGazeX.toFixed(1)}px`);
    ov.style.setProperty('--fog-cy', `${vpGazeY.toFixed(1)}px`);
    ov.style.setProperty('--fog-alpha', (0.9 * intensity).toFixed(3));
    ov.style.setProperty('--fog-r', `${rPx.toFixed(1)}px`);

    const a = (0.9 * intensity).toFixed(3);
    const gridAlpha = (0.15 * intensity).toFixed(3);
    ov.style.background = `
      radial-gradient(circle at var(--fog-cx) var(--fog-cy),
        transparent var(--fog-r),
        rgba(40,45,55, calc(${a} * 0.35)) calc(var(--fog-r) + 2vmax),
        rgba(20,25,35, calc(${a} * 0.75)) calc(var(--fog-r) + 4.5vmax),
        rgba(10,15,20, ${a}) calc(var(--fog-r) + 8vmax),
        rgba(10,15,20, ${a}) 200vmax),
      linear-gradient(rgba(255,255,255,${gridAlpha}) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,${gridAlpha}) 1px, transparent 1px)`;
    ov.style.backgroundSize = '100% 100%, 40px 40px, 40px 40px';
  }

  tightenMask() {
    this.userRadiusOffset -= 15;
  }

  relaxMask(percent) {
    this.userRadiusOffset += percent;
    if (this.userRadiusOffset > 50) {
      this.userRadiusOffset = 50;
      this.removeFOVMask();
    }
  }

  triggerColorShift() {
    const overlay = document.createElement('div');
    overlay.className = 'color-shift-overlay';
    document.body.appendChild(overlay);
    overlay.offsetHeight;
    requestAnimationFrame(() => {
      overlay.classList.add('active');
    });
    setTimeout(() => {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 1000);
    }, 1500);
  }
}
