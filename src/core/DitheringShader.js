export class DitheringShader {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'dithering-canvas';
    this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    this.isActive = false;
    this.gpuTimeMs = 0;
    
    this.rIn = 35.0; 
    this.rOut = 45.0;
    this._lastW = 0;
    this._lastH = 0;
    
    if (!this.gl) {
      console.warn('WebGL not supported, will use CSS fallback.');
    } else {
      this.initWebGL();
    }
    
    window.addEventListener('resize', () => this.resize());
  }

  get isValid() {
    return !!this.gl;
  }

  resize(width, height) {
    const w = (width  || window.innerWidth)  | 0;
    const h = (height || window.innerHeight) | 0;
    // Only touch canvas dimensions when they actually change — avoids
    // pixel-grid instability that causes dithering flicker.
    if (w === this._lastW && h === this._lastH) return;
    this._lastW = w;
    this._lastH = h;
    this.canvas.width  = w;
    this.canvas.height = h;
    if (this.gl) {
      this.gl.viewport(0, 0, w, h);
    }
  }

  initWebGL() {
    this.resize();
    this.canvas.style.position = 'fixed';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100vw';
    this.canvas.style.height = '100vh';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '9998';
    // 移除 opacity = '0'，透明度由 shader 的 u_intensity 完全接管
    document.body.appendChild(this.canvas);

    const vsSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // Chang-Hain (CH) Framework — Three-zone FOV mask with Stationary Anchor Grid
    // Zone 1 (r < rIn):  Fully transparent — clear foveal vision
    // Zone 2 (rIn→rOut): Smooth dark mask gradient (Destabilizing flow attenuation)
    //                     NO grid here — smooth transition only
    // Zone 3 (r > rOut): Dark mask + WHITE stationary anchor grid
    //                     Grid = Stabilizing effect (S): locked to screen coordinates,
    //                     provides vestibular ground-truth for adaptive recalibration
    const fsSource = `
      precision highp float;
      varying vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_rIn;
      uniform float u_rOut;
      uniform float u_time;
      uniform float u_intensity;

      void main() {
        vec2 px = v_uv * u_resolution;
        vec2 center = u_center * u_resolution;
        float distPx = length(px - center);

        // Corner-distance normalization for full edge coverage
        float d1 = length(center);
        float d2 = length(center - vec2(u_resolution.x, 0.0));
        float d3 = length(center - vec2(0.0, u_resolution.y));
        float d4 = length(center - u_resolution);
        float maxDistPx = max(max(d1, d2), max(d3, d4));
        float r_px = (distPx / max(maxDistPx, 1.0)) * 100.0;

        // ── Smooth transition gradient (rIn → rOut → beyond) ──
        float transP = clamp((r_px - u_rIn) / max(u_rOut - u_rIn, 0.1), 0.0, 1.0);
        transP = transP * transP * (3.0 - 2.0 * transP);  // hermite smoothstep

        // Stable peripheral mask opacity (no random grain flicker)
        float maskAlpha = transP * (0.16 + 0.14 * u_intensity);

        // ── CH Stationary Anchor Grid (WHITE, translucent, screen-locked) ──
        // Grid strength driven by transP² — naturally fades in toward periphery,
        // no separate zone boundary. Quadratic growth = barely visible in
        // transition zone, prominent only in deep periphery.
        float gridSpacing = 40.0;
        float gx = mod(px.x, gridSpacing);
        float gy = mod(px.y, gridSpacing);
        float lineX = 1.0 - smoothstep(0.0, 1.2, min(gx, gridSpacing - gx));
        float lineY = 1.0 - smoothstep(0.0, 1.2, min(gy, gridSpacing - gy));
        float gridLine = max(lineX, lineY);
        float gridAlpha = gridLine * transP * transP * (0.05 + 0.07 * u_intensity);

        if (gridAlpha > 0.003) {
          // WHITE anchor grid — Stabilizing effect (S)
          gl_FragColor = vec4(1.0, 1.0, 1.0, gridAlpha);
        } else if (maskAlpha > 0.002) {
          // Dark peripheral mask (calm/consistent)
          gl_FragColor = vec4(vec3(0.06), maskAlpha);
        } else {
          gl_FragColor = vec4(0.0);
        }
      }
    `;

    const shaderProgram = this.createProgram(this.gl, vsSource, fsSource);
    this.programInfo = {
      program: shaderProgram,
      attribLocations: { position: this.gl.getAttribLocation(shaderProgram, 'a_position') },
      uniformLocations: {
        center: this.gl.getUniformLocation(shaderProgram, 'u_center'),
        resolution: this.gl.getUniformLocation(shaderProgram, 'u_resolution'),
        rIn: this.gl.getUniformLocation(shaderProgram, 'u_rIn'),
        rOut: this.gl.getUniformLocation(shaderProgram, 'u_rOut'),
        time: this.gl.getUniformLocation(shaderProgram, 'u_time'),
        intensity: this.gl.getUniformLocation(shaderProgram, 'u_intensity'),
      },
    };

    const positionBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
    const positions = [ -1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0 ];
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(positions), this.gl.STATIC_DRAW);
    this.positionBuffer = positionBuffer;
  }

  createProgram(gl, vs, fs) {
    const vShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vShader, vs);
    gl.compileShader(vShader);
    
    const fShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fShader, fs);
    gl.compileShader(fShader);
    
    const program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);
    return program;
  }

  render(mouseX, mouseY, rIn, rOut, intensity = 1.0) {
    if (!this.gl) return;
    
    // 如果強度歸零，清空畫布即可，節省 GPU
    if (intensity <= 0.01) {
      this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      return;
    }
    
    const start = performance.now();

    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    this.gl.useProgram(this.programInfo.program);

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.vertexAttribPointer(this.programInfo.attribLocations.position, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.enableVertexAttribArray(this.programInfo.attribLocations.position);

    this.gl.uniform2f(this.programInfo.uniformLocations.center, mouseX / this.canvas.width, 1.0 - (mouseY / this.canvas.height));
    this.gl.uniform2f(this.programInfo.uniformLocations.resolution, this.canvas.width, this.canvas.height);
    this.gl.uniform1f(this.programInfo.uniformLocations.rIn, rIn);
    this.gl.uniform1f(this.programInfo.uniformLocations.rOut, rOut);
    this.gl.uniform1f(this.programInfo.uniformLocations.time, performance.now() / 1000.0);
    this.gl.uniform1f(this.programInfo.uniformLocations.intensity, intensity);

    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);

    const end = performance.now();
    this.gpuTimeMs = end - start; // 確保嚴格控制在毫秒級 (<3.53ms)
  }

  setActive(active) {
    this.isActive = active;
    // 透明度與漸變完全交由 RenderController 與 u_intensity 處理，不再強制設定 CSS opacity
  }
}
