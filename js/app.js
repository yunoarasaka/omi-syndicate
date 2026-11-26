/**
 * OMI SYNDICATE — Main Application Controller
 *
 * Orchestrates:
 *  - Full-viewport liquid gradient stage interaction (click-to-lock, rapid-click layering, drag glide)
 *  - Pure Web Audio engine + 60fps WebGL / 2D Overlay / Oscilloscope render loop
 *  - Anodized rotary knobs, universal Play/Stop transport, and 16-step drum sequencer
 */

(function () {
  'use strict';

  const { AudioEngine, SCALES, SCALE_NOTE_NAMES, computeRangeBounds } = window.OmiAudio;
  const { LiquidShader, OverlayRenderer, ScopeRenderer } = window.OmiVisuals;
  const { RotaryKnob } = window.OmiKnobs;

  // Curated minimal ambient / dub-techno drum presets
  const DRUM_PRESETS = [
    {
      name: 'HYPNOTIC',
      kick:  [1, 0, 0, 0,  0, 0, 1, 0,  1, 0, 0, 0,  0, 0, 0, 0],
      snare: [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 1],
      hat:   [0, 0, 1, 0,  0, 0, 1, 0,  0, 1, 1, 0,  0, 0, 1, 0]
    },
    {
      name: 'DUB PULSE',
      kick:  [1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0],
      snare: [0, 0, 0, 0,  0, 0, 0, 1,  0, 0, 0, 0,  1, 0, 0, 0],
      hat:   [0, 0, 1, 0,  0, 0, 1, 0,  0, 0, 1, 1,  0, 0, 1, 0]
    },
    {
      name: 'BROKEN',
      kick:  [1, 0, 0, 1,  0, 0, 0, 0,  0, 0, 1, 0,  0, 0, 0, 0],
      snare: [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0,  0, 1, 0, 0],
      hat:   [1, 0, 1, 0,  0, 1, 0, 1,  1, 0, 0, 1,  0, 1, 1, 0]
    },
    {
      name: 'SPARSE',
      kick:  [1, 0, 0, 0,  0, 0, 0, 0,  0, 0, 1, 0,  0, 0, 0, 0],
      snare: [0, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0],
      hat:   [0, 0, 0, 1,  0, 0, 0, 0,  0, 0, 0, 1,  0, 0, 1, 0]
    }
  ];

  const TRACKS = [
    { key: 'kick', label: 'KICK' },
    { key: 'snare', label: 'SNARE' },
    { key: 'hat', label: 'HI-HAT' }
  ];

  function formatHz(hz) {
    if (hz >= 1000) return `${(hz / 1000).toFixed(1)} kHz`;
    return `${Math.round(hz)} Hz`;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  const SCALE_ORDER = [
    'phrygian-dominant',
    'ionian',
    'dorian',
    'phrygian',
    'lydian',
    'mixolydian',
    'aeolian',
    'locrian'
  ];

  // Instantiate core systems
  const audio = new AudioEngine();
  const stageEl = document.getElementById('stage');
  const stagePromptEl = document.getElementById('stage-prompt');
  const shaderCanvas = document.getElementById('shader-canvas');
  const overlayCanvas = document.getElementById('overlay-canvas');
  const scopeCanvas = document.getElementById('scope-canvas');

  const statusLedEl = document.getElementById('status-led');
  const scalePickerEl = document.getElementById('scale-picker');
  const rootBtnEl = document.getElementById('root-btn');
  const modeBtnEl = document.getElementById('mode-btn');
  const modeLabelEl = document.getElementById('mode-label');
  const scaleMenuEl = document.getElementById('scale-menu');
  const telemetryEl = document.getElementById('telemetry-readout');
  const voiceCountEl = document.getElementById('voice-count');
  const transportBtn = document.getElementById('master-transport');
  const transportLabelEl = document.getElementById('transport-label');

  const seqModuleEl = document.querySelector('.sequencer-module');
  const seqGridEl = document.getElementById('sequencer-grid');
  const drumsToggleBtn = document.getElementById('drums-toggle');
  const bpmReadoutEl = document.getElementById('bpm-value');
  const bpmDownBtn = document.getElementById('bpm-down');
  const bpmUpBtn = document.getElementById('bpm-up');
  const presetBtn = document.getElementById('seq-preset');
  const clearBtn = document.getElementById('seq-clear');

  const shader = new LiquidShader(shaderCanvas);
  if (!shader.ready) {
    stageEl.classList.add('is-fallback');
  }
  const overlay = new OverlayRenderer(overlayCanvas);
  const scope = new ScopeRenderer(scopeCanvas);

  // Smooth visual interpolation state (driven at 60fps)
  const visState = {
    time: 0,
    anchorX: 0.42,
    anchorY: 0.52,
    targetAnchorX: 0.42,
    targetAnchorY: 0.52,
    anchorActive: 0,
    targetAnchorActive: 0,
    energy: 0,
    drumPulse: 0,
    rippleX: 0.5,
    rippleY: 0.5,
    rippleBorn: -10,
    rippleAge: 99,
    space: audio.params.reverb,
    anchorTag: '',
    anchorSubTag: ''
  };

  let presetIndex = 0;
  let rootSemitone = audio.params.rootSemitone; // Default 2 (D)
  let activeScaleKey = audio.params.scale;      // Default 'phrygian-dominant'
  let scaleOptionButtons = {};
  let isStageDragging = false;
  let hasInteracted = false;
  let stepButtons = { kick: [], snare: [], hat: [] };
  let activeVisualStep = -1;

  /* ==========================================================================
     Telemetry & Transport UI Synchronization
     ========================================================================== */

  function updateTelemetryDisplay() {
    const voices = audio.getActiveVoiceCount();
    voiceCountEl.textContent = `${voices} ${voices === 1 ? 'VOICE' : 'VOICES'}`;

    if (audio.isPlaying && audio.lockedZone) {
      const info = audio.getZoneTelemetry(audio.lockedZone.x, audio.lockedZone.y);
      const hzText = info.freq < 100 ? info.freq.toFixed(1) : Math.round(info.freq);
      telemetryEl.textContent = `${hzText} Hz · ${info.note} · LP ${formatHz(info.cutoff)}`;
      visState.anchorTag = `${hzText} Hz · ${info.note}`;
      visState.anchorSubTag = `LP ${formatHz(info.cutoff)}`;
    } else if (audio.isPlaying) {
      telemetryEl.textContent = 'LIVE · CLICK FIELD TO LOCK DRONE';
      visState.anchorTag = '';
      visState.anchorSubTag = '';
    } else {
      telemetryEl.textContent = 'STANDBY · — Hz';
      visState.anchorTag = '';
      visState.anchorSubTag = '';
    }
  }

  function syncTransportUI() {
    const live = audio.isPlaying;
    transportBtn.classList.toggle('is-playing', live);
    transportBtn.setAttribute('aria-pressed', String(live));
    transportLabelEl.textContent = live ? 'STOP' : 'PLAY';
    statusLedEl.classList.toggle('is-live', live);
    visState.targetAnchorActive = live && audio.lockedZone ? 1 : 0;
    updateTelemetryDisplay();
  }

  async function toggleMasterTransport() {
    if (audio.isPlaying) {
      audio.stop();
      syncTransportUI();
    } else {
      // If user hits Play before ever clicking the field, lock a warm initial pad
      if (!audio.lockedZone) {
        const initX = 0.38;
        const initY = 0.52;
        await handleStageTrigger(initX, initY, false);
      } else {
        await audio.play();
        syncTransportUI();
      }
    }
  }

  transportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMasterTransport();
  });

  /* ==========================================================================
     Scale Mode & Root Key Picker (Phrygian Dominant + 7 Diatonic Modes)
     ========================================================================== */

  function setScaleMenuOpen(open) {
    if (!scalePickerEl || !modeBtnEl) return;
    scalePickerEl.classList.toggle('is-open', open);
    modeBtnEl.setAttribute('aria-expanded', String(open));
  }

  function selectScale(scaleKey) {
    if (!SCALES[scaleKey]) return;
    activeScaleKey = scaleKey;
    audio.setScale(scaleKey);
    if (modeLabelEl) {
      modeLabelEl.textContent = SCALES[scaleKey].label;
    }
    for (const [key, btn] of Object.entries(scaleOptionButtons)) {
      const isCurrent = key === scaleKey;
      btn.classList.toggle('is-active', isCurrent);
      btn.setAttribute('aria-selected', String(isCurrent));
    }
    updateTelemetryDisplay();
  }

  function stepRoot(delta) {
    rootSemitone = (rootSemitone + delta + 12) % 12;
    audio.setRoot(rootSemitone);
    if (rootBtnEl) {
      rootBtnEl.textContent = SCALE_NOTE_NAMES[rootSemitone];
    }
    updateTelemetryDisplay();
  }

  function buildScaleMenu() {
    if (!scaleMenuEl) return;
    scaleMenuEl.innerHTML = '';
    scaleOptionButtons = {};

    SCALE_ORDER.forEach((key, index) => {
      const scale = SCALES[key];
      if (!scale) return;

      // Subtle hairline divider between Phrygian Dominant and the 7 diatonic modes
      if (index === 1) {
        const divider = document.createElement('div');
        divider.className = 'scale-menu-divider';
        divider.setAttribute('aria-hidden', 'true');
        scaleMenuEl.appendChild(divider);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scale-option';
      btn.setAttribute('role', 'option');
      const isCurrent = key === activeScaleKey;
      btn.classList.toggle('is-active', isCurrent);
      btn.setAttribute('aria-selected', String(isCurrent));

      btn.innerHTML = `
        <span class="scale-option-left">
          <span class="scale-option-dot"></span>
          <span>${scale.label}</span>
        </span>
        <span class="scale-option-formula">${scale.formula}</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectScale(key);
        setScaleMenuOpen(false);
      });

      scaleMenuEl.appendChild(btn);
      scaleOptionButtons[key] = btn;
    });
  }

  if (rootBtnEl) {
    rootBtnEl.textContent = SCALE_NOTE_NAMES[rootSemitone];
    rootBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      stepRoot(1);
    });
    rootBtnEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      stepRoot(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  if (modeBtnEl) {
    modeBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = scalePickerEl.classList.contains('is-open');
      setScaleMenuOpen(!isOpen);
    });
  }

  if (scaleMenuEl) {
    scaleMenuEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    buildScaleMenu();
  }

  window.addEventListener('pointerdown', (e) => {
    if (scalePickerEl && scalePickerEl.classList.contains('is-open')) {
      if (!scalePickerEl.contains(e.target)) {
        setScaleMenuOpen(false);
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && scalePickerEl?.classList.contains('is-open')) {
      setScaleMenuOpen(false);
    }
  });

  /* ==========================================================================
     Interactive Liquid Stage Events
     ========================================================================== */

  function pointerToNormalized(e) {
    const rect = stageEl.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    // Invert Y so bottom = 0 (darker/closed), top = 1 (brighter/open)
    const y = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
    return { x, y };
  }

  async function handleStageTrigger(x, y, isDrag) {
    if (!hasInteracted) {
      hasInteracted = true;
      stagePromptEl.classList.add('is-hidden');
    }

    const prevX = visState.targetAnchorX;
    const prevY = visState.targetAnchorY;
    const hadPrevious = audio.isPlaying && audio.lockedZone !== null;

    const result = await audio.triggerZone(x, y, isDrag);

    // If rapid-clicking spawned a new overlapping layer, leave a fading ghost reticle at the old spot
    if (!isDrag && hadPrevious && result.spawnedNew) {
      overlay.addGhostAnchor(prevX, prevY);
    }

    visState.targetAnchorX = x;
    visState.targetAnchorY = y;
    visState.targetAnchorActive = 1;

    if (!isDrag) {
      visState.rippleX = x;
      visState.rippleY = y;
      visState.rippleBorn = visState.time;
      overlay.addRipple(x, y);
    }

    syncTransportUI();
  }

  stageEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isStageDragging = true;
    stageEl.setPointerCapture(e.pointerId);
    const { x, y } = pointerToNormalized(e);
    handleStageTrigger(x, y, false);
  });

  stageEl.addEventListener('pointermove', (e) => {
    const { x, y } = pointerToNormalized(e);
    const preview = audio.getZoneTelemetry(x, y);
    const hz = preview.freq < 100 ? preview.freq.toFixed(1) : Math.round(preview.freq);
    overlay.setHover(true, x, y, `${hz} Hz · ${preview.note}`);

    if (isStageDragging) {
      handleStageTrigger(x, y, true);
    }
  });

  const endStageDrag = (e) => {
    if (!isStageDragging) return;
    isStageDragging = false;
    if (e && e.pointerId !== undefined) {
      try { stageEl.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };

  stageEl.addEventListener('pointerup', endStageDrag);
  stageEl.addEventListener('pointercancel', endStageDrag);
  stageEl.addEventListener('pointerleave', () => {
    overlay.setHover(false, 0.5, 0.5, '');
  });

  /* ==========================================================================
     Physical Rotary Knobs Initialization
     ========================================================================== */

  const knobFormatters = {
    range: (v) => {
      const { minFreq, maxFreq } = computeRangeBounds(v);
      return `${Math.round(minFreq)}–${Math.round(maxFreq)}Hz`;
    },
    cutoff: (v) => {
      const hz = 140 * Math.pow(62, v);
      return formatHz(hz);
    },
    resonance: (v) => {
      const q = 0.65 + Math.pow(v, 1.55) * 11.5;
      return `Q ${q.toFixed(1)}`;
    },
    reverb: (v) => `${Math.round(v * 100)}%`
  };

  const knobSlots = document.querySelectorAll('.knob-slot');
  knobSlots.forEach((slot) => {
    const id = slot.dataset.knob;
    new RotaryKnob(slot, {
      formatter: knobFormatters[id],
      onChange: (value, paramId) => {
        audio.setParam(paramId, value);
        if (paramId === 'reverb') {
          visState.space = value;
        }
        updateTelemetryDisplay();
      }
    });
  });

  /* ==========================================================================
     16-Step Drum Sequencer UI & BPM Control
     ========================================================================== */

  let isPaintingSteps = false;
  let paintValue = 1;

  function buildSequencerGrid() {
    seqGridEl.innerHTML = '';
    stepButtons = { kick: [], snare: [], hat: [] };

    // Subtle step ruler marking downbeats (1, 5, 9, 13)
    const ruler = document.createElement('div');
    ruler.className = 'seq-ruler';
    ruler.setAttribute('aria-hidden', 'true');
    const rulerSpacer = document.createElement('div');
    const rulerSteps = document.createElement('div');
    rulerSteps.className = 'seq-ruler-steps';
    for (let s = 0; s < 16; s++) {
      const mark = document.createElement('span');
      const isDownbeat = s % 4 === 0;
      mark.className = isDownbeat ? 'seq-ruler-mark is-downbeat' : 'seq-ruler-mark';
      mark.textContent = isDownbeat ? String(s + 1).padStart(2, '0') : '·';
      rulerSteps.appendChild(mark);
    }
    ruler.appendChild(rulerSpacer);
    ruler.appendChild(rulerSteps);
    seqGridEl.appendChild(ruler);

    for (const track of TRACKS) {
      const row = document.createElement('div');
      row.className = 'seq-row';
      row.dataset.track = track.key;

      const label = document.createElement('div');
      label.className = 'seq-track-label';
      label.innerHTML = `<span class="track-swatch"></span><span>${track.label}</span>`;

      const stepsContainer = document.createElement('div');
      stepsContainer.className = 'seq-steps';

      for (let step = 0; step < 16; step++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seq-step';
        if (Math.floor(step / 4) % 2 === 1) {
          btn.classList.add('is-bar-alt');
        }
        btn.setAttribute('aria-label', `${track.label} step ${step + 1}`);
        btn.dataset.track = track.key;
        btn.dataset.step = String(step);

        const isActive = Boolean(audio.pattern[track.key][step]);
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));

        // Click or sweep-paint across steps seamlessly
        btn.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const next = audio.toggleStep(track.key, step);
          isPaintingSteps = true;
          paintValue = next;
          btn.classList.toggle('is-active', Boolean(next));
          btn.setAttribute('aria-pressed', String(Boolean(next)));
        });

        btn.addEventListener('pointerenter', () => {
          if (!isPaintingSteps) return;
          if (audio.pattern[track.key][step] !== paintValue) {
            audio.pattern[track.key][step] = paintValue;
            btn.classList.toggle('is-active', Boolean(paintValue));
            btn.setAttribute('aria-pressed', String(Boolean(paintValue)));
          }
        });

        stepsContainer.appendChild(btn);
        stepButtons[track.key].push(btn);
      }

      row.appendChild(label);
      row.appendChild(stepsContainer);
      seqGridEl.appendChild(row);
    }
  }

  const stopPaintingSteps = () => {
    isPaintingSteps = false;
  };
  window.addEventListener('pointerup', stopPaintingSteps);
  window.addEventListener('pointercancel', stopPaintingSteps);

  function syncSequencerButtons() {
    for (const track of TRACKS) {
      const arr = audio.pattern[track.key];
      for (let i = 0; i < 16; i++) {
        const btn = stepButtons[track.key][i];
        const active = Boolean(arr[i]);
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    }
  }

  // Visual step playhead callback from lookahead audio clock
  audio.onStepVisual = (step) => {
    if (activeVisualStep >= 0) {
      for (const track of TRACKS) {
        stepButtons[track.key][activeVisualStep]?.classList.remove('is-current');
      }
    }
    activeVisualStep = step;
    if (step >= 0) {
      for (const track of TRACKS) {
        stepButtons[track.key][step]?.classList.add('is-current');
      }
    }
  };

  // Subtle dark-matter visual pulse on drum hits
  audio.onDrumHit = (strength) => {
    visState.drumPulse = Math.max(visState.drumPulse, strength);
  };

  // Drums mute / unmute toggle
  function toggleDrums() {
    const next = !audio.drumsEnabled;
    audio.setDrumsEnabled(next);
    drumsToggleBtn.classList.toggle('active', next);
    drumsToggleBtn.setAttribute('aria-pressed', String(next));
    seqModuleEl.classList.toggle('is-muted', !next);
  }

  drumsToggleBtn.addEventListener('click', toggleDrums);

  // BPM control (buttons, vertical drag, scroll wheel, keyboard)
  function updateBpm(nextBpm) {
    audio.setBpm(nextBpm);
    bpmReadoutEl.textContent = String(audio.bpm);
    bpmReadoutEl.setAttribute('aria-valuenow', String(audio.bpm));
  }

  bpmDownBtn.addEventListener('click', () => updateBpm(audio.bpm - 1));
  bpmUpBtn.addEventListener('click', () => updateBpm(audio.bpm + 1));

  let bpmDragActive = false;
  let bpmDragStartY = 0;
  let bpmDragStartVal = audio.bpm;

  bpmReadoutEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bpmDragActive = true;
    bpmDragStartY = e.clientY;
    bpmDragStartVal = audio.bpm;
    bpmReadoutEl.setPointerCapture(e.pointerId);
  });

  bpmReadoutEl.addEventListener('pointermove', (e) => {
    if (!bpmDragActive) return;
    const dy = bpmDragStartY - e.clientY;
    updateBpm(bpmDragStartVal + Math.round(dy * 0.45));
  });

  const endBpmDrag = (e) => {
    if (!bpmDragActive) return;
    bpmDragActive = false;
    if (e && e.pointerId !== undefined) {
      try { bpmReadoutEl.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  bpmReadoutEl.addEventListener('pointerup', endBpmDrag);
  bpmReadoutEl.addEventListener('pointercancel', endBpmDrag);

  bpmReadoutEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    updateBpm(audio.bpm + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  bpmReadoutEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      updateBpm(audio.bpm + 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      updateBpm(audio.bpm - 1);
    }
  });

  // Cycle curated presets & clear steps
  presetBtn.textContent = DRUM_PRESETS[presetIndex].name;
  presetBtn.addEventListener('click', () => {
    presetIndex = (presetIndex + 1) % DRUM_PRESETS.length;
    const preset = DRUM_PRESETS[presetIndex];
    audio.setPattern(preset);
    presetBtn.textContent = preset.name;
    syncSequencerButtons();
  });

  clearBtn.addEventListener('click', () => {
    audio.clearPattern();
    syncSequencerButtons();
  });

  buildSequencerGrid();

  /* ==========================================================================
     Keyboard Shortcuts & Resize Handling
     ========================================================================== */

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

    if (e.code === 'Space') {
      e.preventDefault();
      toggleMasterTransport();
    } else if (e.key === 'd' || e.key === 'D') {
      toggleDrums();
    }
  });

  window.addEventListener('resize', () => {
    shader.resize();
    overlay.resize();
    scope.setupDPI();
  });

  /* ==========================================================================
     60fps Master Animation Loop
     ========================================================================== */

  let lastFrameTime = performance.now();
  let voicePollCounter = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    visState.time += dt;

    // Smooth silky anchor morph interpolation matching audio glide
    const lerpRate = isStageDragging ? 14.0 : 5.2;
    const blend = 1 - Math.exp(-lerpRate * dt);
    visState.anchorX += (visState.targetAnchorX - visState.anchorX) * blend;
    visState.anchorY += (visState.targetAnchorY - visState.anchorY) * blend;
    visState.anchorActive += (visState.targetAnchorActive - visState.anchorActive) * (1 - Math.exp(-6.0 * dt));

    // Smooth audio energy reactivity & drum pulse decay
    const rawEnergy = audio.getAudioEnergy();
    visState.energy += (rawEnergy - visState.energy) * (1 - Math.exp(-9.0 * dt));
    visState.drumPulse *= Math.exp(-7.5 * dt);
    visState.rippleAge = visState.time - visState.rippleBorn;

    // Periodic voice count refresh (for rapid-click fading voices settling back to 1)
    voicePollCounter++;
    if (voicePollCounter % 15 === 0) {
      const voices = audio.getActiveVoiceCount();
      voiceCountEl.textContent = `${voices} ${voices === 1 ? 'VOICE' : 'VOICES'}`;
    }

    // Render all visual layers
    shader.render(visState);
    overlay.render(visState);
    scope.render(audio.getWaveformData(), audio.isPlaying, visState.time);

    requestAnimationFrame(frame);
  }

  syncTransportUI();
  requestAnimationFrame(frame);
})();
