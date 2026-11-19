/**
 * OMI SYNDICATE — Visual Engine
 *
 * 1. Real-time WebGL Fragment Shader:
 *    Domain-warped liquid FBM + thin-film oil-slick iridescence on dark obsidian,
 *    audio-reactive luminescence, gravitational anchor bloom, click ripples, and film grain.
 * 2. Crisp 2D Overlay Renderer:
 *    Locked drone anchor reticle with smooth morph interpolation, rapid-click ghost anchors,
 *    expanding hairline shockwaves, and subtle hover pitch sighting.
 * 3. Real-Time Oscilloscope Renderer:
 *    High-DPI smoked-glass waveform scope driven by Web Audio AnalyserNode.
 */

(function (global) {
  'use strict';

  const VERTEX_SHADER_SRC = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SHADER_SRC = `
    precision highp float;

    varying vec2 vUv;

    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec2 uAnchor;        // Current smoothed locked drone position (0..1, y-up)
    uniform float uAnchorActive; // 0..1 smooth blend when drone is engaged
    uniform float uEnergy;       // 0..1 real-time audio RMS energy
    uniform float uDrumPulse;    // 0..1 decaying pulse on drum hits
    uniform vec2 uRipplePos;     // Last click ripple origin (0..1, y-up)
    uniform float uRippleAge;    // Seconds since last click ripple
    uniform float uSpace;        // Reverb/Space knob (0..1) enriches atmospheric depth

    // Smooth 2D hash & gradient noise for silky organic fluid flow
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
    }

    float gnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

      float a = dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
      float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
      float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
      float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    // 4-octave rotated Fractal Brownian Motion (eliminates axis artifacts)
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.52;
      mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
      for (int i = 0; i < 4; i++) {
        value += amp * gnoise(p);
        p = rot * p * 1.96 + vec2(1.7, 9.2);
        amp *= 0.5;
      }
      return value;
    }

    // Thin-film iridescent palette (luminous oil-slick: sapphire -> cyan -> lavender -> rose-pearl, zero muddy browns)
    vec3 iridescence(float t, float shift) {
      vec3 a = vec3(0.36, 0.42, 0.58);
      vec3 b = vec3(0.34, 0.36, 0.42);
      vec3 c = vec3(1.00, 1.00, 1.00);
      vec3 d = vec3(0.62 + shift * 0.12, 0.80 + shift * 0.06, 0.96 - shift * 0.08);
      vec3 col = a + b * cos(6.28318 * (c * t + d));
      // Keep thin-film reflection cool, silky, and holographic
      return clamp(col * vec3(0.92, 0.98, 1.12), 0.0, 1.0);
    }

    void main() {
      vec2 uv = vUv;
      float aspect = uResolution.x / max(uResolution.y, 1.0);

      // Aspect-corrected grand silky fluid scale
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 1.48;
      vec2 anchorP = (uAnchor - 0.5) * vec2(aspect, 1.0) * 1.48;
      vec2 rippleP = (uRipplePos - 0.5) * vec2(aspect, 1.0) * 1.48;

      // Very slow hypnotic temporal drift
      float t = uTime * 0.068;

      // Subtle fluid distortion from click shockwave ripple
      float rDist = length(p - rippleP);
      float rippleWave = 0.0;
      if (uRippleAge < 4.5) {
        float waveFront = uRippleAge * 0.72;
        float ring = exp(-pow((rDist - waveFront) * 5.0, 2.0));
        float decay = exp(-uRippleAge * 0.82);
        rippleWave = sin((rDist - waveFront) * 16.0) * ring * decay * 0.085;
      }
      vec2 rDir = normalize(p - rippleP + 0.0001);
      vec2 pWarped = p + rDir * rippleWave;

      // Subtle gravitational pull toward locked drone anchor
      vec2 toAnchor = anchorP - pWarped;
      float aDist = length(toAnchor);
      float pull = exp(-aDist * 1.25) * 0.16 * uAnchorActive;
      pWarped += toAnchor * pull * (0.65 + 0.35 * sin(uTime * 0.35));

      // Two-stage domain warping for smooth liquid mercury / oil-slick currents
      vec2 q = vec2(
        fbm(pWarped + vec2(t * 0.72, -t * 0.40)),
        fbm(pWarped + vec2(-t * 0.48 + 4.3, t * 0.64 + 1.9))
      );

      vec2 r = vec2(
        fbm(pWarped + 1.95 * q + vec2(1.7 + t * 0.34, 9.2 - t * 0.26)),
        fbm(pWarped + 1.95 * q + vec2(8.3 - t * 0.29, 2.8 + t * 0.42))
      );

      float f = fbm(pWarped + 1.65 * r);

      // Deep cosmic obsidian base with nocturnal sapphire, abyssal teal, and violet silk
      vec3 obsidian = vec3(0.018, 0.022, 0.036);
      vec3 deepSapphire = vec3(0.052, 0.078, 0.185);
      vec3 abyssTeal = vec3(0.034, 0.145, 0.205);
      vec3 cosmicViolet = vec3(0.118, 0.058, 0.195);

      float hGrad = smoothstep(0.0, 1.0, uv.x);
      vec3 baseCol = mix(obsidian, deepSapphire, smoothstep(-0.42, 0.62, f + 0.24));
      baseCol = mix(baseCol, abyssTeal, smoothstep(0.02, 0.82, q.x * 0.62 + hGrad * 0.48) * 0.72);
      baseCol = mix(baseCol, cosmicViolet, smoothstep(-0.08, 0.82, r.y * 0.72 + (1.0 - uv.x) * 0.28) * 0.62);

      // Liquid ridge / contour ribbons for crisp iridescent thin-film reflections
      float ridge = abs(f - 0.15 * q.y);
      float crest = smoothstep(0.28, 0.0, ridge);
      float ribbon = smoothstep(0.48, 0.08, abs(length(r) - 0.50));
      float microHighlight = pow(crest, 2.4) * smoothstep(-0.2, 0.6, q.y + 0.35);

      // Thin-film iridescent reflection along liquid ridges
      float filmPhase = f * 1.45 + length(q) * 0.85 + uAnchor.x * 0.42 + uTime * 0.028;
      vec3 filmCol = iridescence(filmPhase, uAnchor.x - 0.5);

      float sheenStrength = (0.19 + uEnergy * 0.26 + uSpace * 0.09 + uDrumPulse * 0.08);
      vec3 col = baseCol;
      col += filmCol * crest * sheenStrength * 0.82;
      col += filmCol * ribbon * (0.12 + uEnergy * 0.18);
      col += vec3(0.76, 0.88, 1.0) * microHighlight * (0.10 + uEnergy * 0.14);

      // Soft luminous aura centered on the locked drone zone
      float aura = exp(-aDist * aDist * (1.75 - uEnergy * 0.45));
      float innerCore = exp(-aDist * aDist * 13.0);
      vec3 auraTint = mix(
        vec3(0.32, 0.40, 0.86), // Left: deep twilight sapphire-violet
        vec3(0.44, 0.82, 0.94), // Right: celestial cyan-pearl
        uAnchor.x
      );
      auraTint = mix(auraTint, vec3(0.74, 0.48, 0.86), uAnchor.y * 0.38);

      col += auraTint * aura * (0.18 + uEnergy * 0.24 + uDrumPulse * 0.07) * uAnchorActive;
      col += vec3(0.86, 0.93, 1.0) * innerCore * (0.10 + uEnergy * 0.15) * uAnchorActive;

      // Subtle ripple specular highlight
      col += vec3(0.70, 0.86, 1.0) * abs(rippleWave) * 1.85;

      // Gentle S-curve contrast & dark luxury lift
      col = col / (1.0 + col * 0.34);
      col = pow(max(col, 0.0), vec3(0.94));

      // Subtle optical film grain (prevents dark-gradient banding)
      float grain = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 73.1, vec2(12.9898, 78.233))) * 43758.5453);
      col += (grain - 0.5) * 0.014;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /**
   * WebGL Liquid Shader Stage
   */
  class LiquidShader {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      });

      this.ready = false;
      if (!this.gl) return;

      this.initPipeline();
      this.resize();
    }

    compileShader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('Omi Syndicate WebGL shader error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    initPipeline() {
      const gl = this.gl;
      const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
      const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
      if (!vs || !fs) return;

      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn('Omi Syndicate WebGL link error:', gl.getProgramInfoLog(program));
        return;
      }

      gl.useProgram(program);
      this.program = program;

      // Full-screen quad
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      const posLoc = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      // Uniform locations
      this.u = {
        resolution: gl.getUniformLocation(program, 'uResolution'),
        time: gl.getUniformLocation(program, 'uTime'),
        anchor: gl.getUniformLocation(program, 'uAnchor'),
        anchorActive: gl.getUniformLocation(program, 'uAnchorActive'),
        energy: gl.getUniformLocation(program, 'uEnergy'),
        drumPulse: gl.getUniformLocation(program, 'uDrumPulse'),
        ripplePos: gl.getUniformLocation(program, 'uRipplePos'),
        rippleAge: gl.getUniformLocation(program, 'uRippleAge'),
        space: gl.getUniformLocation(program, 'uSpace')
      };

      this.ready = true;
    }

    resize() {
      if (!this.ready) return;
      // Cap DPR at 1.5 for rock-solid 60fps across retina / 4K monitors
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(window.innerWidth * dpr));
      const height = Math.max(1, Math.floor(window.innerHeight * dpr));

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.gl.viewport(0, 0, width, height);
      }
    }

    render(state) {
      if (!this.ready) return;
      const gl = this.gl;

      gl.uniform2f(this.u.resolution, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.u.time, state.time);
      gl.uniform2f(this.u.anchor, state.anchorX, state.anchorY);
      gl.uniform1f(this.u.anchorActive, state.anchorActive);
      gl.uniform1f(this.u.energy, state.energy);
      gl.uniform1f(this.u.drumPulse, state.drumPulse);
      gl.uniform2f(this.u.ripplePos, state.rippleX, state.rippleY);
      gl.uniform1f(this.u.rippleAge, state.rippleAge);
      gl.uniform1f(this.u.space, state.space);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /**
   * 2D Crisp Architectural Overlay (Anchor reticles, ghost drones, ripples, hover telemetry)
   */
  class OverlayRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.ripples = [];
      this.ghosts = [];
      this.hover = { active: false, x: 0.5, y: 0.5, label: '' };
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.dpr = dpr;
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    addRipple(xNorm, yNorm) {
      this.ripples.push({
        x: xNorm,
        y: yNorm,
        born: performance.now()
      });
      if (this.ripples.length > 8) this.ripples.shift();
    }

    addGhostAnchor(xNorm, yNorm) {
      this.ghosts.push({
        x: xNorm,
        y: yNorm,
        born: performance.now(),
        duration: 3800
      });
      if (this.ghosts.length > 5) this.ghosts.shift();
    }

    setHover(active, xNorm, yNorm, label) {
      this.hover.active = active;
      this.hover.x = xNorm;
      this.hover.y = yNorm;
      if (label !== undefined) this.hover.label = label;
    }

    render(state) {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      const now = performance.now();

      ctx.clearRect(0, 0, w, h);

      // 1. Expanding click ripples
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const r = this.ripples[i];
        const age = (now - r.born) / 1000;
        if (age > 2.2) {
          this.ripples.splice(i, 1);
          continue;
        }
        const t = age / 2.2;
        const ease = 1 - Math.pow(1 - t, 3);
        const radius = 14 + ease * 195;
        const alpha = (1 - t) * (1 - t) * 0.42;

        const px = r.x * w;
        const py = (1 - r.y) * h;

        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(182, 232, 255, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 2. Rapid-click fading ghost anchors (overlapping drones)
      for (let i = this.ghosts.length - 1; i >= 0; i--) {
        const g = this.ghosts[i];
        const progress = (now - g.born) / g.duration;
        if (progress >= 1) {
          this.ghosts.splice(i, 1);
          continue;
        }
        const alpha = (1 - progress) * 0.48;
        const px = g.x * w;
        const py = (1 - g.y) * h;
        const rad = 16 + progress * 12;

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(176, 166, 255, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.85;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(216, 224, 255, ${(alpha * 1.1).toFixed(3)})`;
        ctx.fill();
        ctx.restore();
      }

      // 3. Subtle hover pitch sighting reticle
      if (this.hover.active) {
        const hx = this.hover.x * w;
        const hy = (1 - this.hover.y) * h;
        ctx.save();
        ctx.strokeStyle = 'rgba(230, 238, 255, 0.22)';
        ctx.lineWidth = 0.8;

        const arm = 7;
        const gap = 4;
        ctx.beginPath();
        ctx.moveTo(hx - arm - gap, hy);
        ctx.lineTo(hx - gap, hy);
        ctx.moveTo(hx + gap, hy);
        ctx.lineTo(hx + arm + gap, hy);
        ctx.moveTo(hx, hy - arm - gap);
        ctx.lineTo(hx, hy - gap);
        ctx.moveTo(hx, hy + gap);
        ctx.lineTo(hx, hy + arm + gap);
        ctx.stroke();

        if (this.hover.label) {
          ctx.font = '300 9.5px "JetBrains Mono", monospace';
          ctx.fillStyle = 'rgba(214, 226, 246, 0.42)';
          ctx.fillText(this.hover.label, hx + 14, hy - 10);
        }
        ctx.restore();
      }

      // 4. Primary Locked Drone Anchor Reticle
      if (state.anchorActive > 0.01) {
        const ax = state.anchorX * w;
        const ay = (1 - state.anchorY) * h;
        const alpha = state.anchorActive;
        const breathe = Math.sin(state.time * (1.4 + state.anchorY * 2.2)) * 2.5;
        const energyBoost = state.energy * 16 + state.drumPulse * 5;

        ctx.save();

        // Delicate fading axis hairlines
        const lineLen = 48;
        const hGrad = ctx.createLinearGradient(ax - lineLen, ay, ax + lineLen, ay);
        hGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        hGrad.addColorStop(0.5, `rgba(210, 232, 255, ${(0.22 * alpha).toFixed(3)})`);
        hGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.strokeStyle = hGrad;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(ax - lineLen, ay);
        ctx.lineTo(ax + lineLen, ay);
        ctx.stroke();

        const vGrad = ctx.createLinearGradient(ax, ay - lineLen, ax, ay + lineLen);
        vGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        vGrad.addColorStop(0.5, `rgba(210, 232, 255, ${(0.22 * alpha).toFixed(3)})`);
        vGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.strokeStyle = vGrad;
        ctx.beginPath();
        ctx.moveTo(ax, ay - lineLen);
        ctx.lineTo(ax, ay + lineLen);
        ctx.stroke();

        // Outer breathing aura ring
        const outerR = 26 + breathe + energyBoost;
        ctx.beginPath();
        ctx.arc(ax, ay, outerR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(146, 226, 252, ${(0.24 * alpha).toFixed(3)})`;
        ctx.lineWidth = 0.85;
        ctx.stroke();

        // Precision inner lock ring
        const innerR = 12 + energyBoost * 0.25;
        ctx.beginPath();
        ctx.arc(ax, ay, innerR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(244, 248, 255, ${(0.68 * alpha).toFixed(3)})`;
        ctx.lineWidth = 1.1;
        ctx.stroke();

        // Glowing center core
        const coreGrad = ctx.createRadialGradient(ax, ay, 0.5, ax, ay, 8);
        coreGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.95 * alpha).toFixed(3)})`);
        coreGrad.addColorStop(0.45, `rgba(145, 232, 255, ${(0.55 * alpha).toFixed(3)})`);
        coreGrad.addColorStop(1, 'rgba(145, 232, 255, 0)');
        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.arc(ax, ay, 8, 0, Math.PI * 2);
        ctx.fill();

        // Crisp floating micro-telemetry beside anchor
        if (state.anchorTag) {
          const flipLeft = ax > w - 180;
          const tx = flipLeft ? ax - 24 : ax + 24;
          ctx.textAlign = flipLeft ? 'right' : 'left';

          ctx.font = '400 10.5px "JetBrains Mono", monospace';
          ctx.fillStyle = `rgba(242, 246, 255, ${(0.82 * alpha).toFixed(3)})`;
          ctx.fillText(state.anchorTag, tx, ay - 4);

          if (state.anchorSubTag) {
            ctx.font = '300 9px "JetBrains Mono", monospace';
            ctx.fillStyle = `rgba(182, 206, 232, ${(0.52 * alpha).toFixed(3)})`;
            ctx.fillText(state.anchorSubTag, tx, ay + 10);
          }
        }

        ctx.restore();
      }
    }
  }

  /**
   * Real-time high-DPI Oscilloscope Renderer
   */
  class ScopeRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.setupDPI();
    }

    setupDPI() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = 148;
      const cssH = 30;
      this.width = cssW;
      this.height = cssH;
      this.canvas.width = Math.floor(cssW * dpr);
      this.canvas.height = Math.floor(cssH * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    render(timeData, isPlaying, time) {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      const midY = h * 0.5;

      ctx.clearRect(0, 0, w, h);

      // Subtle center reference hairline
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 0.75;
      ctx.stroke();

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, 'rgba(167, 139, 250, 0.35)');
      grad.addColorStop(0.5, 'rgba(145, 232, 255, 0.92)');
      grad.addColorStop(1, 'rgba(232, 174, 212, 0.45)');

      ctx.beginPath();

      if (!timeData || !isPlaying) {
        // Serene breathing standby line
        const amp = 1.4;
        for (let x = 0; x <= w; x += 4) {
          const y = midY + Math.sin(x * 0.06 + time * 1.2) * amp * Math.sin((x / w) * Math.PI);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(180, 198, 224, 0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
        return;
      }

      // Find rising zero-crossing for stable, jitter-free oscilloscope lock
      let startIdx = 0;
      const half = Math.floor(timeData.length * 0.5);
      for (let i = 1; i < half; i++) {
        if (timeData[i - 1] < 128 && timeData[i] >= 128) {
          startIdx = i;
          break;
        }
      }

      const samples = 256;
      const step = w / samples;

      for (let i = 0; i <= samples; i++) {
        const v = (timeData[startIdx + i] - 128) / 128.0;
        // Edge windowing so ends taper gracefully inside glass capsule
        const edge = Math.sin((i / samples) * Math.PI);
        const y = midY + v * (h * 0.44) * Math.pow(edge, 0.35);
        const x = i * step;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.35;
      ctx.shadowColor = 'rgba(123, 227, 246, 0.45)';
      ctx.shadowBlur = 5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  global.OmiVisuals = {
    LiquidShader,
    OverlayRenderer,
    ScopeRenderer
  };
})(window);
