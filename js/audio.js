/**
 * OMI SYNDICATE — Pure Web Audio API Engine
 *
 * Architecture:
 *  - Continuous polyphonic-capable Drone Synthesizer with smooth parameter morphing
 *    (multi-oscillator sub/tri/saw/fifth + pink-filtered air + dual LFOs + cascaded 24dB LP filter)
 *  - Procedural stereo algorithmic Convolution Reverb + Tape-filtered Ping-Pong Delay
 *  - Pure Web Audio synthesized 3-track Drum Machine (Kick, Snare, Hi-Hat)
 *  - Sample-accurate lookahead 16-step sequencer clock (60–180 BPM)
 *  - Real-time AnalyserNode telemetry (waveform & spectral energy for WebGL shader)
 */

(function (global) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALE_NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  // Phrygian Dominant scale degrees (1, b2, 3, 4, 5, b6, b7)
  const PHRYGIAN_DOM_INTERVALS = [0, 1, 4, 5, 7, 8, 10];
  // Strictly in-scale consonant harmonic overtone interval (semitones) for each degree
  const PHRYGIAN_DOM_HARMONICS = [7, 7, 8, 7, 5, 4, 7];

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  /**
   * Convert MIDI note number to clean readable note name (e.g., D2, Eb2, F#3).
   */
  function midiToNoteName(midi) {
    const rounded = Math.round(midi);
    const name = SCALE_NOTE_NAMES[((rounded % 12) + 12) % 12];
    const octave = Math.floor(rounded / 12) - 1;
    return `${name}${octave}`;
  }

  /**
   * Convert frequency in Hz to nearest musical note name.
   */
  function freqToNote(freq) {
    if (!freq || freq <= 0) return '—';
    return midiToNoteName(freqToMidi(freq));
  }

  /**
   * Build all Phrygian Dominant notes inside [minFreq, maxFreq] and map xNorm [0..1]
   * cleanly onto the scale so every click anywhere on the field lands in harmony.
   */
  function quantizePhrygianDominant(xNorm, rangeNorm, rootSemitone = 2) {
    const { minFreq, maxFreq } = computeRangeBounds(rangeNorm);
    const minMidi = Math.ceil(freqToMidi(minFreq));
    const maxMidi = Math.floor(freqToMidi(maxFreq));

    const scaleNotes = [];
    for (let midi = minMidi; midi <= maxMidi; midi++) {
      const rel = (((midi - rootSemitone) % 12) + 12) % 12;
      const degreeIdx = PHRYGIAN_DOM_INTERVALS.indexOf(rel);
      if (degreeIdx !== -1) {
        scaleNotes.push({ midi, degreeIdx });
      }
    }

    // Fallback safety if range is somehow ultra-narrow
    if (scaleNotes.length === 0) {
      const fallbackMidi = Math.round(freqToMidi(minFreq));
      return {
        freq: midiToFreq(fallbackMidi),
        harmonicFreq: midiToFreq(fallbackMidi + 7),
        midi: fallbackMidi,
        note: midiToNoteName(fallbackMidi),
        minFreq,
        maxFreq
      };
    }

    const idx = Math.min(
      scaleNotes.length - 1,
      Math.max(0, Math.round(xNorm * (scaleNotes.length - 1)))
    );
    const chosen = scaleNotes[idx];
    const baseFreq = midiToFreq(chosen.midi);

    // Consonant harmonic overtone strictly inside the same Phrygian Dominant scale
    const harmonicOffset = PHRYGIAN_DOM_HARMONICS[chosen.degreeIdx];
    const shimmerOctave = xNorm > 0.72 ? 12 : 0;
    const harmonicFreq = midiToFreq(chosen.midi + harmonicOffset + shimmerOctave);

    return {
      freq: baseFreq,
      harmonicFreq,
      midi: chosen.midi,
      note: midiToNoteName(chosen.midi),
      minFreq,
      maxFreq
    };
  }

  /**
   * Generate a soft-clipping waveshaper curve for subtle analog warmth.
   */
  function makeWarmSaturationCurve(amount) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = amount;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /**
   * Procedurally synthesize a lush stereo ambient cathedral impulse response
   * for ConvolverNode (no external audio files required).
   */
  function createAlgorithmicReverbIR(ctx, duration = 4.6, decay = 2.8) {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const impulse = ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      let lp2 = 0;

      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Soft attack swell so early reflections feel diffused rather than metallic
        const attack = Math.min(1, i / (sampleRate * 0.045));
        const env = attack * Math.pow(1 - t, decay);

        // White noise darkened progressively over time (air absorption)
        const white = Math.random() * 2 - 1;
        const damp = 0.22 + 0.55 * (1 - t);
        lp = lp + damp * (white - lp);
        lp2 = lp2 + (damp * 0.65) * (lp - lp2);

        data[i] = lp2 * env * 0.72;
      }
    }
    return impulse;
  }

  /**
   * Generate a seamless looping pink/brown-tilted ambient noise buffer.
   */
  function createAmbientNoiseBuffer(ctx, seconds = 4) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Paul Kellet pink noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.06;
      b6 = white * 0.115926;
    }

    // Gentle crossfade at loop seam to eliminate loop click
    const fadeSamples = Math.min(2048, Math.floor(length * 0.05));
    for (let i = 0; i < fadeSamples; i++) {
      const w = i / fadeSamples;
      data[i] = data[i] * w + data[length - fadeSamples + i] * (1 - w);
    }

    return buffer;
  }

  /**
   * Generate a short white noise buffer for snare & hi-hat synthesis.
   */
  function createWhiteNoiseBuffer(ctx, seconds = 1.2) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Single continuous sustaining Drone Voice.
   * Built with 4 oscillators (sub sine, detuned triangle, warm detuned saw, harmonic fifth),
   * gentle pink noise air, dual LFOs (analog drift + filter breathing),
   * cascaded 24dB-style lowpass filters, and stereo placement.
   */
  class DroneVoice {
    constructor(ctx, destination, noiseBuffer, xNorm, yNorm, params) {
      this.ctx = ctx;
      this.isDisposed = false;
      this.x = xNorm;
      this.y = yNorm;

      const now = ctx.currentTime;

      // Output stage & stereo positioning
      this.voiceGain = ctx.createGain();
      this.voiceGain.gain.setValueAtTime(0.0001, now);

      this.panner = ctx.createStereoPanner();
      this.panner.connect(this.voiceGain);
      this.voiceGain.connect(destination);

      // Cascaded lowpass filters for silky, rich analog slope
      this.filterA = ctx.createBiquadFilter();
      this.filterA.type = 'lowpass';

      this.filterB = ctx.createBiquadFilter();
      this.filterB.type = 'lowpass';
      this.filterB.Q.setValueAtTime(0.72, now);

      this.filterA.connect(this.filterB);
      this.filterB.connect(this.panner);

      // Voice mixer bus before filter
      this.preFilterGain = ctx.createGain();
      this.preFilterGain.gain.setValueAtTime(0.55, now);
      this.preFilterGain.connect(this.filterA);

      // 1. Sub Fundamental (Sine)
      this.oscSub = ctx.createOscillator();
      this.oscSub.type = 'sine';
      this.gainSub = ctx.createGain();
      this.gainSub.gain.setValueAtTime(0.46, now);
      this.oscSub.connect(this.gainSub);
      this.gainSub.connect(this.preFilterGain);

      // 2. Warm Detuned Triangle
      this.oscTri = ctx.createOscillator();
      this.oscTri.type = 'triangle';
      this.gainTri = ctx.createGain();
      this.gainTri.gain.setValueAtTime(0.28, now);
      this.oscTri.connect(this.gainTri);
      this.gainTri.connect(this.preFilterGain);

      // 3. Detuned Sawtooth (sculpted upper harmonics)
      this.oscSaw = ctx.createOscillator();
      this.oscSaw.type = 'sawtooth';
      this.gainSaw = ctx.createGain();
      this.gainSaw.gain.setValueAtTime(0.18, now);
      this.oscSaw.connect(this.gainSaw);
      this.gainSaw.connect(this.preFilterGain);

      // 4. Harmonic Fifth / Shimmer Oscillator (blooms gently towards the right)
      this.oscFifth = ctx.createOscillator();
      this.oscFifth.type = 'triangle';
      this.gainFifth = ctx.createGain();
      this.gainFifth.gain.setValueAtTime(0.08, now);
      this.oscFifth.connect(this.gainFifth);
      this.gainFifth.connect(this.preFilterGain);

      // 5. Gentle Filtered Ambient Air Noise
      this.noiseSrc = ctx.createBufferSource();
      this.noiseSrc.buffer = noiseBuffer;
      this.noiseSrc.loop = true;

      this.noiseFilter = ctx.createBiquadFilter();
      this.noiseFilter.type = 'bandpass';
      this.noiseFilter.Q.setValueAtTime(0.9, now);

      this.gainNoise = ctx.createGain();
      this.gainNoise.gain.setValueAtTime(0.06, now);

      this.noiseSrc.connect(this.noiseFilter);
      this.noiseFilter.connect(this.gainNoise);
      this.gainNoise.connect(this.filterB);

      // 6. Slow Analog Pitch Drift LFO
      this.lfoDrift = ctx.createOscillator();
      this.lfoDrift.type = 'sine';
      this.lfoDrift.frequency.setValueAtTime(0.09 + Math.random() * 0.06, now);

      this.lfoDriftDepth = ctx.createGain();
      this.lfoDriftDepth.gain.setValueAtTime(4.5, now); // ±4.5 cents organic beating
      this.lfoDrift.connect(this.lfoDriftDepth);
      this.lfoDriftDepth.connect(this.oscTri.detune);
      this.lfoDriftDepth.connect(this.oscSaw.detune);

      // 7. Filter Breathing Modulation LFO (depth governed by Y coordinate)
      this.lfoFilter = ctx.createOscillator();
      this.lfoFilter.type = 'sine';
      this.lfoFilter.frequency.setValueAtTime(0.18, now);

      this.lfoFilterDepth = ctx.createGain();
      this.lfoFilterDepth.gain.setValueAtTime(120, now);
      this.lfoFilter.connect(this.lfoFilterDepth);
      this.lfoFilterDepth.connect(this.filterA.frequency);

      // Apply initial parameters immediately before starting oscillators
      this.applyParameters(xNorm, yNorm, params, 0.005);

      // Start all continuous sources
      this.oscSub.start(now);
      this.oscTri.start(now);
      this.oscSaw.start(now);
      this.oscFifth.start(now);
      this.noiseSrc.start(now);
      this.lfoDrift.start(now);
      this.lfoFilter.start(now);

      // Smooth lush attack bloom (never clicks, holds indefinitely)
      this.voiceGain.gain.setTargetAtTime(0.46, now, 0.16);
    }

    /**
     * Smoothly morph pitch, harmonic content, filter cutoff, resonance,
     * modulation depth, and stereo image over `morphSeconds`.
     */
    applyParameters(xNorm, yNorm, params, morphSeconds = 0.56) {
      if (this.isDisposed) return;

      this.x = xNorm;
      this.y = yNorm;

      const now = this.ctx.currentTime;
      const tau = Math.max(0.004, morphSeconds / 3.0);

      // Quantize pitch strictly to Phrygian Dominant scale so every note harmonizes
      const rootSemitone = params.rootSemitone ?? 2; // Default: D Phrygian Dominant
      const pitched = quantizePhrygianDominant(xNorm, params.range, rootSemitone);
      const baseFreq = pitched.freq;

      // Oscillator pitches with musical subtle analog detune
      this.oscSub.frequency.setTargetAtTime(baseFreq, now, tau);
      this.oscTri.frequency.setTargetAtTime(baseFreq * 1.0028, now, tau);
      this.oscSaw.frequency.setTargetAtTime(baseFreq * 0.9968, now, tau);

      // Strictly in-scale harmonic overtone oscillator (never clashes even when drones overlap)
      this.oscFifth.frequency.setTargetAtTime(pitched.harmonicFreq * 1.0012, now, tau);

      // Timbral balance across X: left = dark sub-heavy, right = richer harmonic glow
      const sawLevel = 0.11 + xNorm * 0.18;
      const fifthLevel = 0.04 + Math.pow(xNorm, 1.35) * 0.18;
      const subLevel = 0.52 - xNorm * 0.14;
      this.gainSaw.gain.setTargetAtTime(sawLevel, now, tau);
      this.gainFifth.gain.setTargetAtTime(fifthLevel, now, tau);
      this.gainSub.gain.setTargetAtTime(subLevel, now, tau);

      // Filter cutoff combines master CUTOFF knob + vertical Y position + subtle X brightness tracking
      const knobCutoff = 140 * Math.pow(62, params.cutoff); // ~140Hz .. ~8680Hz
      const yFactor = 0.28 + Math.pow(yNorm, 1.45) * 1.25;
      const xTracking = 0.78 + xNorm * 0.45;
      const targetCutoff = clamp(knobCutoff * yFactor * xTracking, 95, 11000);

      this.filterA.frequency.setTargetAtTime(targetCutoff, now, tau);
      this.filterB.frequency.setTargetAtTime(clamp(targetCutoff * 1.45, 160, 14500), now, tau);

      // Resonance Q (musical, rich vocal emphasis without harsh whistling)
      const qValue = 0.65 + Math.pow(params.resonance, 1.55) * 11.5;
      this.filterA.Q.setTargetAtTime(qValue, now, tau);

      // Vertical Y also enriches slow modulation depth & breathing rate
      const lfoRate = 0.12 + yNorm * 0.42;
      const lfoDepth = clamp(targetCutoff * (0.06 + yNorm * 0.34), 18, 2200);
      this.lfoFilter.frequency.setTargetAtTime(lfoRate, now, tau);
      this.lfoFilterDepth.gain.setTargetAtTime(lfoDepth, now, tau);

      // Air noise opens gently as you move higher & brighter
      const noiseCenter = 420 + yNorm * 2600 + xNorm * 900;
      const noiseLevel = 0.025 + yNorm * 0.075;
      this.noiseFilter.frequency.setTargetAtTime(noiseCenter, now, tau);
      this.gainNoise.gain.setTargetAtTime(noiseLevel, now, tau);

      // Subtle stereo spatial grounding from left to right
      const pan = (xNorm - 0.5) * 0.62;
      this.panner.pan.setTargetAtTime(pan, now, tau);
    }

    /**
     * Gracefully crossfade out and clean up audio nodes.
     */
    release(fadeSeconds = 3.6) {
      if (this.isDisposed) return;
      this.isDisposed = true;

      const now = this.ctx.currentTime;
      const tau = Math.max(0.02, fadeSeconds / 4.2);

      this.voiceGain.gain.cancelScheduledValues(now);
      this.voiceGain.gain.setTargetAtTime(0.00001, now, tau);

      const cleanupMs = Math.ceil((fadeSeconds + 0.4) * 1000);
      setTimeout(() => this.disposeNodes(), cleanupMs);
    }

    disposeNodes() {
      const stoppables = [
        this.oscSub,
        this.oscTri,
        this.oscSaw,
        this.oscFifth,
        this.noiseSrc,
        this.lfoDrift,
        this.lfoFilter
      ];
      for (const node of stoppables) {
        try { node.stop(); } catch (_) {}
        try { node.disconnect(); } catch (_) {}
      }
      const gains = [
        this.voiceGain,
        this.panner,
        this.filterA,
        this.filterB,
        this.preFilterGain,
        this.noiseFilter,
        this.lfoDriftDepth,
        this.lfoFilterDepth
      ];
      for (const node of gains) {
        try { node.disconnect(); } catch (_) {}
      }
    }
  }

  /**
   * Map normalized RANGE knob [0..1] to [minFreq, maxFreq] in Hz.
   * At default 0.45 -> ~40Hz to ~400Hz.
   */
  function computeRangeBounds(rangeNorm) {
    const minFreq = 26 * Math.pow(3.0, rangeNorm);   // ~26Hz .. ~78Hz (at 0.45 -> ~42Hz)
    const maxFreq = 210 * Math.pow(3.6, rangeNorm);  // ~210Hz .. ~756Hz (at 0.45 -> ~374Hz)
    return { minFreq, maxFreq };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /**
   * Main Omi Syndicate Audio Engine
   */
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.isInitialized = false;
      this.isPlaying = false;

      // Synthesis parameters (normalized 0..1) + Phrygian Dominant root (2 = D)
      this.params = {
        range: 0.45,
        cutoff: 0.62,
        resonance: 0.28,
        reverb: 0.58,
        rootSemitone: 2
      };

      // Active drone voice state
      this.primaryVoice = null;
      this.fadingVoices = [];
      this.lockedZone = null; // { x, y }
      this.lastClickTime = 0;

      // Drum sequencer state (16 steps x 3 tracks)
      this.bpm = 98;
      this.drumsEnabled = true;
      this.currentStep = 0;
      this.nextNoteTime = 0;
      this.schedulerTimer = null;
      this.stepCallbacks = [];
      this.onStepVisual = null;
      this.onDrumHit = null;

      // Subtle, hypnotic minimal starter groove
      this.pattern = {
        kick:  [1, 0, 0, 0,  0, 0, 1, 0,  1, 0, 0, 0,  0, 0, 0, 0],
        snare: [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 1],
        hat:   [0, 0, 1, 0,  0, 0, 1, 0,  0, 1, 1, 0,  0, 0, 1, 0]
      };

      // Buffers for real-time visualization
      this.timeData = null;
      this.freqData = null;
    }

    /**
     * Lazy-initialize Web Audio graph on first user gesture.
     */
    init() {
      if (this.isInitialized) return;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      const now = this.ctx.currentTime;

      // Master bus: Master Gain -> Warm Soft Clipper -> Dynamics Compressor -> Analyser -> Destination
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.0001, now);

      this.warmShaper = this.ctx.createWaveShaper();
      this.warmShaper.curve = makeWarmSaturationCurve(0.45);
      this.warmShaper.oversample = '2x';

      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-11, now);
      this.compressor.knee.setValueAtTime(16, now);
      this.compressor.ratio.setValueAtTime(3.6, now);
      this.compressor.attack.setValueAtTime(0.008, now);
      this.compressor.release.setValueAtTime(0.18, now);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.84;
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.masterGain.connect(this.warmShaper);
      this.warmShaper.connect(this.compressor);
      this.compressor.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      // Drone Bus
      this.droneBus = this.ctx.createGain();
      this.droneBus.gain.setValueAtTime(0.88, now);

      this.droneDryGain = this.ctx.createGain();
      this.droneDryGain.gain.setValueAtTime(0.85, now);
      this.droneBus.connect(this.droneDryGain);
      this.droneDryGain.connect(this.masterGain);

      // Lush Stereo Algorithmic Reverb Bus
      this.reverbSend = this.ctx.createGain();
      this.convolver = this.ctx.createConvolver();
      this.convolver.buffer = createAlgorithmicReverbIR(this.ctx, 4.8, 2.7);

      this.reverbFilter = this.ctx.createBiquadFilter();
      this.reverbFilter.type = 'lowpass';
      this.reverbFilter.frequency.setValueAtTime(4200, now);

      this.reverbReturn = this.ctx.createGain();
      this.reverbReturn.gain.setValueAtTime(0.95, now);

      this.droneBus.connect(this.reverbSend);
      this.reverbSend.connect(this.convolver);
      this.convolver.connect(this.reverbFilter);
      this.reverbFilter.connect(this.reverbReturn);
      this.reverbReturn.connect(this.masterGain);

      // Stereo Diffusion Ping-Pong Delay Bus (adds liquid ambient movement)
      this.delaySend = this.ctx.createGain();
      this.delayLeft = this.ctx.createDelay(2.0);
      this.delayRight = this.ctx.createDelay(2.0);
      this.delayLeft.delayTime.setValueAtTime(0.37, now);
      this.delayRight.delayTime.setValueAtTime(0.53, now);

      this.delayFilterL = this.ctx.createBiquadFilter();
      this.delayFilterL.type = 'lowpass';
      this.delayFilterL.frequency.setValueAtTime(1950, now);

      this.delayFilterR = this.ctx.createBiquadFilter();
      this.delayFilterR.type = 'lowpass';
      this.delayFilterR.frequency.setValueAtTime(1750, now);

      this.delayFeedbackL = this.ctx.createGain();
      this.delayFeedbackR = this.ctx.createGain();
      this.delayFeedbackL.gain.setValueAtTime(0.42, now);
      this.delayFeedbackR.gain.setValueAtTime(0.42, now);

      this.delayPanL = this.ctx.createStereoPanner();
      this.delayPanR = this.ctx.createStereoPanner();
      this.delayPanL.pan.setValueAtTime(-0.55, now);
      this.delayPanR.pan.setValueAtTime(0.55, now);

      this.droneBus.connect(this.delaySend);
      this.delaySend.connect(this.delayLeft);
      this.delayLeft.connect(this.delayFilterL);
      this.delayFilterL.connect(this.delayFeedbackL);
      this.delayFeedbackL.connect(this.delayRight);
      this.delayRight.connect(this.delayFilterR);
      this.delayFilterR.connect(this.delayFeedbackR);
      this.delayFeedbackR.connect(this.delayLeft);

      this.delayFilterL.connect(this.delayPanL);
      this.delayFilterR.connect(this.delayPanR);
      this.delayPanL.connect(this.masterGain);
      this.delayPanR.connect(this.masterGain);

      // Drum Bus (clean punchy dry + whisper of reverb send for snare/hat air)
      this.drumBus = this.ctx.createGain();
      this.drumBus.gain.setValueAtTime(0.84, now);
      this.drumBus.connect(this.masterGain);

      this.drumReverbSend = this.ctx.createGain();
      this.drumReverbSend.gain.setValueAtTime(0.16, now);
      this.drumReverbSend.connect(this.convolver);

      // Pre-generate shared noise buffers
      this.ambientNoiseBuffer = createAmbientNoiseBuffer(this.ctx, 4.5);
      this.whiteNoiseBuffer = createWhiteNoiseBuffer(this.ctx, 1.2);

      // Apply initial FX mix levels
      this.updateSpaceMix();

      this.isInitialized = true;
    }

    /**
     * Universal Play — wakes AudioContext, fades master in cleanly,
     * starts drum sequencer, and restores locked drone if one exists.
     */
    async play() {
      this.init();
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      if (this.isPlaying) return;

      this.isPlaying = true;
      const now = this.ctx.currentTime;

      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(0.86, now, 0.025);

      // Restore sustaining drone if a zone was already locked
      if (this.lockedZone && !this.primaryVoice) {
        this.primaryVoice = new DroneVoice(
          this.ctx,
          this.droneBus,
          this.ambientNoiseBuffer,
          this.lockedZone.x,
          this.lockedZone.y,
          this.params
        );
      }

      this.startSequencerClock();
    }

    /**
     * Universal Stop — cuts all audio cleanly without pops,
     * halts drum sequencer, and releases active voices while remembering locked coordinates.
     */
    stop() {
      if (!this.isPlaying) return;
      this.isPlaying = false;

      this.stopSequencerClock();

      if (this.ctx) {
        const now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setTargetAtTime(0.00001, now, 0.012);

        // Cleanly release active voices after master hits silence
        const voicesToRelease = [...this.fadingVoices];
        if (this.primaryVoice) {
          voicesToRelease.push(this.primaryVoice);
          this.primaryVoice = null;
        }
        this.fadingVoices = [];

        setTimeout(() => {
          for (const v of voicesToRelease) {
            v.release(0.05);
          }
          if (!this.isPlaying && this.ctx && this.ctx.state === 'running') {
            this.ctx.suspend().catch(() => {});
          }
        }, 70);
      }
    }

    /**
     * Trigger or morph the drone at normalized canvas coordinates (x: 0..1, y: 0..1).
     *  - Calm clicks morph the active sustaining pad smoothly over ~560ms.
     *  - Rapid clicks (< 720ms apart) spawn overlapping harmonic layers that bloom
     *    and gracefully dissolve into the newly locked zone.
     *  - Dragging glides continuously in real time.
     */
    async triggerZone(xNorm, yNorm, isDrag = false) {
      const x = clamp(xNorm, 0, 1);
      const y = clamp(yNorm, 0, 1);
      this.lockedZone = { x, y };

      if (!this.isPlaying) {
        await this.play();
      }

      const now = this.ctx.currentTime;
      const dt = now - this.lastClickTime;

      if (isDrag) {
        if (this.primaryVoice) {
          this.primaryVoice.applyParameters(x, y, this.params, 0.14);
        }
        return { spawnedNew: false, info: this.getZoneTelemetry(x, y) };
      }

      this.lastClickTime = now;
      let spawnedNew = false;

      if (!this.primaryVoice) {
        // First lock — spawn continuous sustaining pad
        this.primaryVoice = new DroneVoice(
          this.ctx,
          this.droneBus,
          this.ambientNoiseBuffer,
          x,
          y,
          this.params
        );
        spawnedNew = true;
      } else if (dt < 0.72) {
        // Rapid click — allow lush overlapping harmonic layers that gradually settle
        const retiring = this.primaryVoice;
        retiring.release(3.8);
        this.fadingVoices.push(retiring);

        // Cap simultaneous fading layers for clean headroom
        while (this.fadingVoices.length > 3) {
          const oldest = this.fadingVoices.shift();
          oldest.release(0.45);
        }

        // Prune disposed references
        this.fadingVoices = this.fadingVoices.filter((v) => !v.isDisposed || true);
        setTimeout(() => {
          const idx = this.fadingVoices.indexOf(retiring);
          if (idx !== -1) this.fadingVoices.splice(idx, 1);
        }, 4200);

        this.primaryVoice = new DroneVoice(
          this.ctx,
          this.droneBus,
          this.ambientNoiseBuffer,
          x,
          y,
          this.params
        );
        spawnedNew = true;
      } else {
        // Primary behavior — smoothly morph/crossfade existing pad to new zone (~560ms)
        this.primaryVoice.applyParameters(x, y, this.params, 0.58);
      }

      return { spawnedNew, info: this.getZoneTelemetry(x, y) };
    }

    /**
     * Update a rotary knob parameter ('range' | 'cutoff' | 'resonance' | 'reverb').
     */
    setParam(name, value) {
      this.params[name] = clamp(value, 0, 1);

      if (!this.isInitialized) return;

      if (name === 'reverb') {
        this.updateSpaceMix();
      } else {
        if (this.primaryVoice && this.lockedZone) {
          this.primaryVoice.applyParameters(
            this.lockedZone.x,
            this.lockedZone.y,
            this.params,
            0.12
          );
        }
        for (const v of this.fadingVoices) {
          v.applyParameters(v.x, v.y, this.params, 0.16);
        }
      }
    }

    /**
     * Change the root key of the Phrygian Dominant scale (0=C .. 11=B).
     */
    setRoot(semitone) {
      this.params.rootSemitone = ((Math.round(semitone) % 12) + 12) % 12;
      if (!this.isInitialized) return;
      if (this.primaryVoice && this.lockedZone) {
        this.primaryVoice.applyParameters(
          this.lockedZone.x,
          this.lockedZone.y,
          this.params,
          0.35
        );
      }
      for (const v of this.fadingVoices) {
        v.applyParameters(v.x, v.y, this.params, 0.35);
      }
    }

    updateSpaceMix() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const amt = this.params.reverb;
      // Rich cathedral wet send + tape diffusion delay
      this.reverbSend.gain.setTargetAtTime(amt * 0.92, now, 0.04);
      this.delaySend.gain.setTargetAtTime(amt * 0.34, now, 0.04);
      this.delayFeedbackL.gain.setTargetAtTime(0.24 + amt * 0.36, now, 0.05);
      this.delayFeedbackR.gain.setTargetAtTime(0.24 + amt * 0.36, now, 0.05);
      // Slightly pull back dry level at extreme space settings for immersive wash
      this.droneDryGain.gain.setTargetAtTime(0.92 - amt * 0.28, now, 0.04);
    }

    /**
     * Compute human-readable Phrygian Dominant frequency, note, and filter cutoff for HUD display.
     */
    getZoneTelemetry(x, y) {
      const pitched = quantizePhrygianDominant(x, this.params.range, this.params.rootSemitone);
      const knobCutoff = 140 * Math.pow(62, this.params.cutoff);
      const yFactor = 0.28 + Math.pow(y, 1.45) * 1.25;
      const xTracking = 0.78 + x * 0.45;
      const cutoff = clamp(knobCutoff * yFactor * xTracking, 95, 11000);
      return {
        freq: pitched.freq,
        note: pitched.note,
        cutoff,
        minFreq: pitched.minFreq,
        maxFreq: pitched.maxFreq
      };
    }

    getActiveVoiceCount() {
      if (!this.isPlaying) return 0;
      return (this.primaryVoice ? 1 : 0) + this.fadingVoices.length;
    }

    /* ========================================================================
       Lookahead 16-Step Drum Sequencer & Pure Web Audio Drum Synthesis
       ======================================================================== */

    setBpm(bpm) {
      this.bpm = clamp(Math.round(bpm), 60, 180);
    }

    setDrumsEnabled(enabled) {
      this.drumsEnabled = Boolean(enabled);
    }

    toggleStep(track, stepIndex) {
      if (!this.pattern[track]) return 0;
      this.pattern[track][stepIndex] = this.pattern[track][stepIndex] ? 0 : 1;
      return this.pattern[track][stepIndex];
    }

    setPattern(newPattern) {
      this.pattern.kick = newPattern.kick.slice(0, 16);
      this.pattern.snare = newPattern.snare.slice(0, 16);
      this.pattern.hat = newPattern.hat.slice(0, 16);
    }

    clearPattern() {
      this.pattern.kick.fill(0);
      this.pattern.snare.fill(0);
      this.pattern.hat.fill(0);
    }

    startSequencerClock() {
      this.stopSequencerClock();
      this.currentStep = 0;
      this.nextNoteTime = this.ctx.currentTime + 0.04;

      this.schedulerTimer = setInterval(() => this.scheduleAhead(), 25);
    }

    stopSequencerClock() {
      if (this.schedulerTimer !== null) {
        clearInterval(this.schedulerTimer);
        this.schedulerTimer = null;
      }
      for (const id of this.stepCallbacks) {
        clearTimeout(id);
      }
      this.stepCallbacks = [];
      if (this.onStepVisual) {
        this.onStepVisual(-1);
      }
    }

    scheduleAhead() {
      if (!this.isPlaying || !this.ctx) return;

      const lookahead = 0.11; // seconds
      while (this.nextNoteTime < this.ctx.currentTime + lookahead) {
        const step = this.currentStep;
        const time = this.nextNoteTime;

        if (this.drumsEnabled) {
          let hitStrength = 0;
          if (this.pattern.kick[step]) {
            this.triggerKick(time);
            hitStrength = Math.max(hitStrength, 1.0);
          }
          if (this.pattern.snare[step]) {
            this.triggerSnare(time);
            hitStrength = Math.max(hitStrength, 0.65);
          }
          if (this.pattern.hat[step]) {
            this.triggerHiHat(time, step % 4 === 2 ? 0.85 : 0.65);
            hitStrength = Math.max(hitStrength, 0.25);
          }

          if (hitStrength > 0 && this.onDrumHit) {
            const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
            const id = setTimeout(() => {
              if (this.isPlaying) this.onDrumHit(hitStrength);
            }, delayMs);
            this.stepCallbacks.push(id);
          }
        }

        // Sync visual playhead tightly to audio clock
        if (this.onStepVisual) {
          const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
          const id = setTimeout(() => {
            if (this.isPlaying) this.onStepVisual(step);
          }, delayMs);
          this.stepCallbacks.push(id);
        }

        // Advance 16th note
        const secondsPer16th = (60.0 / this.bpm) * 0.25;
        this.nextNoteTime += secondsPer16th;
        this.currentStep = (this.currentStep + 1) % 16;
      }

      // Keep callback list bounded
      if (this.stepCallbacks.length > 64) {
        this.stepCallbacks.splice(0, 32);
      }
    }

    /**
     * Synthesized Kick: Deep sub pitch-sweep + subtle transient click.
     */
    triggerKick(time) {
      const ctx = this.ctx;

      // Sub body oscillator
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(148, time);
      osc.frequency.exponentialRampToValueAtTime(48, time + 0.058);
      osc.frequency.exponentialRampToValueAtTime(36, time + 0.34);

      gain.gain.setValueAtTime(0.001, time);
      gain.gain.linearRampToValueAtTime(0.92, time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.36);

      osc.connect(gain);
      gain.connect(this.drumBus);
      osc.start(time);
      osc.stop(time + 0.38);

      // Subtle crisp attack click
      const clickOsc = ctx.createOscillator();
      const clickGain = ctx.createGain();
      clickOsc.type = 'triangle';
      clickOsc.frequency.setValueAtTime(980, time);
      clickOsc.frequency.exponentialRampToValueAtTime(140, time + 0.015);

      clickGain.gain.setValueAtTime(0.24, time);
      clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.018);

      clickOsc.connect(clickGain);
      clickGain.connect(this.drumBus);
      clickOsc.start(time);
      clickOsc.stop(time + 0.022);
    }

    /**
     * Synthesized Snare: Tight tonal body + sculpted filtered noise snap + touch of space.
     */
    triggerSnare(time) {
      const ctx = this.ctx;

      // Noise snap
      const noise = ctx.createBufferSource();
      noise.buffer = this.whiteNoiseBuffer;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(950, time);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2200, time);
      bp.Q.setValueAtTime(0.75, time);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.001, time);
      noiseGain.gain.linearRampToValueAtTime(0.46, time + 0.003);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.17);

      noise.connect(hp);
      hp.connect(bp);
      bp.connect(noiseGain);
      noiseGain.connect(this.drumBus);
      noiseGain.connect(this.drumReverbSend);

      noise.start(time);
      noise.stop(time + 0.19);

      // Tonal drum shell body
      const body = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      body.type = 'triangle';
      body.frequency.setValueAtTime(205, time);
      body.frequency.exponentialRampToValueAtTime(112, time + 0.075);

      bodyGain.gain.setValueAtTime(0.36, time);
      bodyGain.gain.exponentialRampToValueAtTime(0.001, time + 0.11);

      body.connect(bodyGain);
      bodyGain.connect(this.drumBus);

      body.start(time);
      body.stop(time + 0.12);
    }

    /**
     * Synthesized Hi-Hat: Metallic inharmonic cluster + surgical highpass noise burst.
     */
    triggerHiHat(time, velocity = 0.75) {
      const ctx = this.ctx;

      const outGain = ctx.createGain();
      outGain.gain.setValueAtTime(0.001, time);
      outGain.gain.linearRampToValueAtTime(0.24 * velocity, time + 0.002);
      outGain.gain.exponentialRampToValueAtTime(0.0008, time + 0.056);

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(7200, time);
      hp.Q.setValueAtTime(0.85, time);

      hp.connect(outGain);
      outGain.connect(this.drumBus);
      outGain.connect(this.drumReverbSend);

      // Filtered noise shimmer
      const noise = ctx.createBufferSource();
      noise.buffer = this.whiteNoiseBuffer;
      noise.connect(hp);
      noise.start(time);
      noise.stop(time + 0.07);

      // Metallic FM-like partials
      const ratios = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
      for (let i = 0; i < ratios.length; i++) {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(ratios[i] * 1.85, time);
        oscGain.gain.setValueAtTime(0.055, time);
        osc.connect(oscGain);
        oscGain.connect(hp);
        osc.start(time);
        osc.stop(time + 0.065);
      }
    }

    /* ========================================================================
       Real-Time Visualizer Telemetry (Oscilloscope & Shader Reactivity)
       ======================================================================== */

    getWaveformData() {
      if (!this.analyser || !this.isPlaying) return null;
      this.analyser.getByteTimeDomainData(this.timeData);
      return this.timeData;
    }

    getAudioEnergy() {
      if (!this.analyser || !this.isPlaying) return 0;
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      const bins = 48; // Focus on warm drone fundamental & mid-harmonics
      for (let i = 0; i < bins; i++) {
        sum += this.freqData[i];
      }
      return clamp(sum / (bins * 255), 0, 1);
    }
  }

  global.OmiAudio = {
    AudioEngine,
    computeRangeBounds,
    freqToNote
  };
})(window);
