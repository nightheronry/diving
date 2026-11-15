// ============================================================================
// Ocean Audio Engine: 3-Zone Crossfading Ambient Music + Spatial Whale Acoustics
// ============================================================================
// Pure Web Audio API procedural synthesis (zero external audio asset dependencies):
//  1. Surface Zone (水面): Sunlit coastal breeze, rolling ocean surf, warm Lydian
//     harmonic chord pad, bright harp/kalimba plucks, and distant seabird cries.
//  2. Underwater Zone (水下): Luminous D-major pentatonic reef pad, cathedral
//     convolver reverb, crystalline caustic glass chimes, and rising scuba/reef bubbles.
//  3. Deep Abyss Zone (深處): Sub-bass tectonic drone, minor/Dorian dark ambient
//     choir pad, deep resonant sunken-bell harmonics, and hydrothermal pressure rumble.
//  4. Whale Bioacoustics (靠近鯨魚): Spatial 3D distance-attenuated & stereo-panned
//     Mother & Calf Sperm Whale melodic calls, signature echolocation click codas,
//     and surface blowhole exhalation spouts.

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

export class OceanAudioSystem {
  constructor() {
    this.ac = null;
    this.masterGain = null;
    this.muted = false;
    this.initialized = false;
    this.masterVol = 0.82;

    // Live telemetry state for UI display
    this.currentZoneLabel = '水下';
    this.whaleAudible = false;
    this.zoneWeights = { surface: 0, underwater: 1, deep: 0 };

    // Internal scheduling timers
    this._lastStepTime = 0;
    this._prevCamX = 0;
    this._prevCamY = -15;
    this._prevCamZ = 20;
    this._prevPosInit = false;

    this._nextSurfPluck = 0;
    this._nextSeagull = 0;
    this._nextReefBubble = 0;
    this._nextReefChime = 0;
    this._nextDeepBell = 0;
    this._nextWhaleSong = 0;
    this._nextWhaleCoda = 0;
    this._nextSpoutSound = 0;

    this._rng = 246813579;
  }

  _rand() {
    this._rng = (this._rng * 1664525 + 1013904223) >>> 0;
    return this._rng / 4294967296;
  }

  _rr(a, b) {
    return a + (b - a) * this._rand();
  }

  init() {
    if (this.initialized) {
      this.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ac = new AudioCtx({ latencyHint: 'playback' });
    this.ac = ac;
    this.initialized = true;
    const sr = ac.sampleRate;

    const N = (Cls, opts, ...targets) => {
      const node = new Cls(ac, opts);
      for (const dst of targets) node.connect(dst);
      if (node.start) node.start();
      return node;
    };
    const G = (gain, ...targets) => N(GainNode, { gain }, ...targets);
    const BQ = (type, frequency, Q, ...targets) => N(BiquadFilterNode, { type, frequency, Q }, ...targets);
    const LFO = (frequency, depth, param) => N(OscillatorNode, { frequency }, G(depth, param));

    const makeBuffer = (secs, fillFn) => {
      const len = (sr * secs) | 0;
      const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: sr });
      fillFn(buf.getChannelData(0), len, 0);
      fillFn(buf.getChannelData(1), len, 1);
      return buf;
    };

    // Seamless crossfaded brown/pink noise buffer (11s)
    const noiseBuf = makeBuffer(11, (data, len) => {
      let b = 0;
      for (let i = 0; i < len + 4096; i++) {
        b = (b + 0.022 * (this._rand() * 2 - 1)) / 1.022;
        if (i < len) {
          data[i] = b * 3.4;
        } else {
          const k = (i - len) / 4096;
          data[i - len] = data[i - len] * k + b * 3.4 * (1.0 - k);
        }
      }
    });

    // Lush 5.2s underwater cathedral & canyon impulse response
    const reverbBuf = makeBuffer(5.2, (data, len) => {
      let b = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        b += (this._rand() * 2 - 1 - b) * (0.04 + 0.48 * Math.exp(-t * 1.9));
        data[i] = b * (1.0 - Math.exp(-t * 28.0)) * Math.exp(-t * 1.38) * (1.0 - i / len);
      }
    });

    const limiter = N(
      DynamicsCompressorNode,
      { threshold: -6, knee: 6, ratio: 18, attack: 0.003, release: 0.28 },
      ac.destination
    );
    this.masterGain = G(this.muted ? 0.0 : this.masterVol, limiter);
    const wetReverb = N(ConvolverNode, { buffer: reverbBuf }, this.masterGain);

    const makeNoiseLoop = (playbackRate, ...targets) =>
      N(AudioBufferSourceNode, { buffer: noiseBuf, loop: true, playbackRate }, ...targets);

    // ========================================================================
    // 1. SURFACE ZONE (水面): Sunlit Lydian Pad + Rolling Surf + Breeze
    // ========================================================================
    this.surfaceBus = G(0.0, this.masterGain, G(0.55, wetReverb));

    // Rolling coastal ocean waves & airy sea breeze
    const surfWaveGain = G(0.32, this.surfaceBus);
    makeNoiseLoop(0.82, BQ('bandpass', 520, 0.55, surfWaveGain));
    LFO(0.11, 0.22, surfWaveGain.gain);
    LFO(0.17, 0.14, surfWaveGain.gain);

    const breezeGain = G(0.14, this.surfaceBus);
    makeNoiseLoop(1.18, BQ('bandpass', 1150, 0.7, breezeGain));
    LFO(0.065, 0.08, breezeGain.gain);

    // Warm sunlit A-Lydian / Major-9th open chord pad (A2, E3, B3, C#4, E4, G#4)
    const surfPadFilter = BQ('lowpass', 2400, 0.7, this.surfaceBus);
    [110.0, 164.81, 246.94, 277.18, 329.63, 415.3].forEach((freq, idx) => {
      const vGain = G(0.020 - idx * 0.0022, surfPadFilter);
      N(OscillatorNode, { type: 'triangle', frequency: freq }, vGain);
      N(OscillatorNode, { type: 'sine', frequency: freq + this._rr(0.08, 0.22) }, vGain);
    });

    // ========================================================================
    // 2. UNDERWATER REEF ZONE (水下): D-Major Pentatonic Pad + Caustic Wash
    // ========================================================================
    this.underwaterBus = G(0.8, this.masterGain, G(1.35, wetReverb));

    // Muffled overhead wave wash
    const uwWashGain = G(0.26, this.underwaterBus);
    makeNoiseLoop(0.63, BQ('lowpass', 360, 0.65, uwWashGain));
    LFO(0.085, 0.14, uwWashGain.gain);

    // Serene stacked fifths on D (D2, A2, E3, B3, F#4)
    const uwPadFilter = BQ('lowpass', 1350, 0.7, this.underwaterBus);
    [73.42, 110.0, 164.81, 246.94, 369.99].forEach((freq, idx) => {
      const vGain = G(0.025 - idx * 0.003, uwPadFilter);
      N(OscillatorNode, { type: 'sine', frequency: freq }, vGain);
      N(OscillatorNode, { type: 'sine', frequency: freq + this._rr(0.04, 0.12) }, vGain);
    });

    // ========================================================================
    // 3. DEEP ABYSS ZONE (深處): Sub-Bass Drone + Dorian Choir + Trench Rumble
    // ========================================================================
    this.deepBus = G(0.0, this.masterGain, G(1.85, wetReverb));

    // Abyssal hydrothermal sub-rumble
    const deepRumble = G(0.45, this.deepBus);
    makeNoiseLoop(0.48, BQ('lowpass', 95, 0.85, deepRumble));
    LFO(0.05, 0.16, deepRumble.gain);

    // Haunting D-Dorian / Minor Abyssal Drone (D1 sub, D2, F2, A2, C3, E3)
    const deepPadFilter = BQ('lowpass', 420, 1.1, this.deepBus);
    LFO(0.042, 110, deepPadFilter.frequency);
    [36.71, 73.42, 87.31, 110.0, 130.81, 164.81].forEach((freq, idx) => {
      const vGain = G(idx === 0 ? 0.038 : 0.024 - idx * 0.0025, deepPadFilter);
      N(OscillatorNode, { type: idx === 0 ? 'sine' : 'triangle', frequency: freq }, vGain);
      N(OscillatorNode, { type: 'sine', frequency: freq - this._rr(0.03, 0.09) }, vGain);
    });

    // ========================================================================
    // 4. SWIMMING HYDRODYNAMIC RUSH & POOLED GENERATIVE VOICES
    // ========================================================================
    this.rushGain = G(0.0, this.masterGain);
    this.rushFilter = BQ('bandpass', 280, 0.9, this.rushGain);
    makeNoiseLoop(0.74, this.rushFilter);

    const makeVoicePool = (count, wetSend, oscType = 'sine', filterFreq = 0) =>
      Array.from({ length: count }, () => {
        const panner = N(StereoPannerNode, {}, this.masterGain, G(wetSend, wetReverb));
        const env = G(0.0, panner);
        const target = filterFreq > 0 ? BQ('lowpass', filterFreq, 1.2, env) : env;
        const osc = N(OscillatorNode, { type: oscType, frequency: 220 }, target);
        return { panner, env, osc, filter: filterFreq > 0 ? target : null };
      });

    this.surfPluckPool = makeVoicePool(4, 0.75, 'triangle', 2600);
    this.seagullPool = makeVoicePool(4, 1.15, 'triangle', 3400);
    this.bubblePool = makeVoicePool(5, 0.18, 'sine', 0);
    this.reefChimePool = makeVoicePool(4, 1.35, 'sine', 0);
    this.deepBellPool = makeVoicePool(3, 2.1, 'triangle', 680);

    // Dedicated Spatial Whale Voice Pools (Mother low formant + Calf high call + Click codas)
    this.whaleSongPool = makeVoicePool(3, 2.2, 'triangle', 520);
    this.whaleHarmPool = makeVoicePool(3, 2.4, 'sine', 880);
    this.whaleClickPool = makeVoicePool(4, 1.4, 'triangle', 1400);

    // Reusable noise burst node for whale surface blowhole spouts
    this.spoutPanner = N(StereoPannerNode, {}, this.masterGain, G(0.9, wetReverb));
    this.spoutEnv = G(0.0, this.spoutPanner);
    this.spoutFilter = BQ('bandpass', 420, 1.1, this.spoutEnv);
    makeNoiseLoop(1.05, this.spoutFilter);

    const now = ac.currentTime;
    this._lastStepTime = now;
    this._nextSurfPluck = now + 0.8;
    this._nextSeagull = now + 0.35;
    this._prevWSurface = 0.0;
    this._seagullCallIdx = 0;
    this._nextReefBubble = now + 0.9;
    this._nextReefChime = now + 1.5;
    this._nextDeepBell = now + 1.2;
    this._nextWhaleSong = now + 0.7;
    this._nextWhaleCoda = now + 1.4;
    this._nextSpoutSound = now + 0.5;

    document.addEventListener('visibilitychange', () => {
      if (!this.ac) return;
      if (document.hidden) this.ac.suspend();
      else if (!this.muted) this.ac.resume();
    });
  }

  resume() {
    if (this.ac && this.ac.state === 'suspended' && !document.hidden) {
      this.ac.resume().catch(() => {});
    }
  }

  toggleMute() {
    if (!this.initialized) this.init();
    this.muted = !this.muted;
    if (this.ac && this.masterGain) {
      this.resume();
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0.0 : this.masterVol,
        this.ac.currentTime,
        0.08
      );
    }
    return this.muted;
  }

  _triggerVoice(pool, t, fStart, fEnd, dur, vol, attack, pan = 0) {
    const v = pool.shift();
    pool.push(v);
    const safeF0 = Math.max(20.0, fStart);
    const safeF1 = Math.max(20.0, fEnd);
    v.panner.pan.setValueAtTime(clamp(pan, -0.95, 0.95), t);
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setValueAtTime(safeF0, t);
    v.osc.frequency.exponentialRampToValueAtTime(safeF1, t + dur);

    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(0.0001, t);
    v.env.gain.linearRampToValueAtTime(vol, t + attack);
    v.env.gain.setTargetAtTime(0.0001, t + attack, Math.max(0.015, (dur - attack) * 0.22));
  }

  // Coastal seabird cry with arched pitch inflection (fStart -> fPeak -> fEnd)
  _triggerGullCry(t, fStart, fPeak, fEnd, riseDur, fallDur, vol, pan = 0) {
    const v = this.seagullPool.shift();
    this.seagullPool.push(v);
    v.panner.pan.setValueAtTime(clamp(pan, -0.95, 0.95), t);
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setValueAtTime(Math.max(80.0, fStart), t);
    v.osc.frequency.exponentialRampToValueAtTime(Math.max(80.0, fPeak), t + riseDur);
    v.osc.frequency.exponentialRampToValueAtTime(Math.max(80.0, fEnd), t + riseDur + fallDur);

    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(0.0001, t);
    v.env.gain.linearRampToValueAtTime(vol, t + riseDur * 0.85);
    v.env.gain.setTargetAtTime(0.0001, t + riseDur, Math.max(0.025, fallDur * 0.28));
  }

  update(cameraPos, camRight, waveHeight, whalePod) {
    // 1. Compute Smooth 3-Zone Depth Weights (水面 / 水下 / 深處) & Whale Proximity for HUD + Audio
    const depth = waveHeight - cameraPos.y; // <= 0 in air, > 0 underwater
    const wSurface = 1.0 - smoothstep(-0.2, 5.5, depth);
    const wDeep = smoothstep(17.5, 25.0, depth);
    const wUnderwater = clamp(1.0 - wSurface - wDeep, 0.0, 1.0);

    this.zoneWeights.surface = wSurface;
    this.zoneWeights.underwater = wUnderwater;
    this.zoneWeights.deep = wDeep;

    if (wSurface >= wUnderwater && wSurface >= wDeep) {
      this.currentZoneLabel = '水面';
    } else if (wDeep >= wUnderwater) {
      this.currentZoneLabel = '深處';
    } else {
      this.currentZoneLabel = '水下';
    }

    let distM = 999.0;
    let distC = 999.0;
    let dxM = 0; let dyM = 0; let dzM = 0;
    let dxC = 0; let dyC = 0; let dzC = 0;
    if (whalePod && whalePod.motherMesh && whalePod.calfMesh) {
      const mPos = whalePod.motherMesh.position;
      const cPos = whalePod.calfMesh.position;
      dxM = mPos.x - cameraPos.x;
      dyM = mPos.y - cameraPos.y;
      dzM = mPos.z - cameraPos.z;
      distM = Math.hypot(dxM, dyM, dzM);

      dxC = cPos.x - cameraPos.x;
      dyC = cPos.y - cameraPos.y;
      dzC = cPos.z - cameraPos.z;
      distC = Math.hypot(dxC, dyC, dzC);
    }
    const minDist = Math.min(distM, distC);
    const prox = Math.pow(clamp(1.0 - minDist / 82.0, 0.0, 1.0), 1.3);
    this.whaleAudible = prox > 0.08;

    if (!this.initialized || !this.ac || this.ac.state !== 'running') return;

    const now = this.ac.currentTime;
    const dt = now - this._lastStepTime;
    if (dt < 0.085) return; // Throttle audio graph updates to ~11 Hz
    this._lastStepTime = now;
    const t = now + 0.04;

    // Smoothly crossfade the 3 musical & ambient buses
    this.surfaceBus.gain.setTargetAtTime(wSurface * 0.95, t, 0.35);
    this.underwaterBus.gain.setTargetAtTime(wUnderwater * 0.95, t, 0.35);
    this.deepBus.gain.setTargetAtTime(wDeep * 1.05, t, 0.40);

    // 2. Camera Swim Velocity Water Rush
    if (!this._prevPosInit) {
      this._prevCamX = cameraPos.x;
      this._prevCamY = cameraPos.y;
      this._prevCamZ = cameraPos.z;
      this._prevPosInit = true;
    }
    let speed = Math.hypot(
      cameraPos.x - this._prevCamX,
      cameraPos.y - this._prevCamY,
      cameraPos.z - this._prevCamZ
    ) / Math.max(dt, 0.01);
    this._prevCamX = cameraPos.x;
    this._prevCamY = cameraPos.y;
    this._prevCamZ = cameraPos.z;
    if (speed > 45.0) speed = 0.0; // Ignore viewpoint teleport jumps

    const rushLevel = 0.38 * Math.pow(Math.min(speed / 24.0, 1.0), 1.2) * (1.0 - wSurface * 0.65);
    this.rushGain.gain.setTargetAtTime(rushLevel, t, 0.25);
    this.rushFilter.frequency.setTargetAtTime(210 + speed * 14.0, t, 0.25);

    // 3. Zone-Specific Melodic & Ambient Events
    // (A) Surface Zone: Sunlit Harp/Kalimba Pentatonic Arpeggios & Coastal Seabirds (海鳥叫聲)
    if (wSurface > 0.25 && this._prevWSurface <= 0.25) {
      // Immediately cue a welcoming coastal seabird cry when breaking the water surface
      this._nextSeagull = Math.min(this._nextSeagull, t + 0.18);
    }
    this._prevWSurface = wSurface;

    if (wSurface > 0.15) {
      if (t > this._nextSurfPluck) {
        const SURF_NOTES = [0, 4, 7, 11, 14, 16, 19, 23]; // A Major-9 / Lydian intervals
        const semi = SURF_NOTES[(this._rand() * SURF_NOTES.length) | 0];
        const freq = 440.0 * Math.pow(2.0, (semi - 12) / 12.0);
        this._triggerVoice(
          this.surfPluckPool,
          t,
          freq * 1.002,
          freq,
          2.6,
          this._rr(0.022, 0.042) * wSurface,
          0.018,
          this._rr(-0.65, 0.65)
        );
        this._nextSurfPluck = t + this._rr(0.65, 2.2);
      }
      if (t > this._nextSeagull) {
        let ct = t;
        const pan = this._rr(-0.82, 0.82);
        const callPattern = (this._seagullCallIdx++) % 2;
        if (callPattern === 0) {
          // Pattern A: Plaintive 2-phrase soaring coastal gull cry (upward arch -> descending glide)
          for (let k = 0; k < 2; k++) {
            const fBase = this._rr(1320, 1620) * (k === 0 ? 1.0 : 0.92);
            const rise = this._rr(0.11, 0.16);
            const fall = this._rr(0.36, 0.52);
            this._triggerGullCry(
              ct,
              fBase,
              fBase * this._rr(1.28, 1.42),
              fBase * this._rr(0.74, 0.84),
              rise,
              fall,
              0.042 * wSurface,
              clamp(pan + (k * 0.16 - 0.08), -0.9, 0.9)
            );
            ct += rise + fall + this._rr(0.14, 0.26);
          }
        } else {
          // Pattern B: 4-note Herring Gull "keow-keow-keow-keow" laughing call
          const basePeak = this._rr(1950, 2320);
          for (let k = 0; k < 4; k++) {
            const decay = 1.0 - k * 0.075;
            const rise = 0.065;
            const fall = this._rr(0.18, 0.25);
            this._triggerGullCry(
              ct,
              basePeak * 0.78 * decay,
              basePeak * decay,
              basePeak * 0.62 * decay,
              rise,
              fall,
              0.038 * wSurface * (1.0 - k * 0.12),
              pan
            );
            ct += rise + fall + this._rr(0.06, 0.11);
          }
        }
        this._nextSeagull = ct + this._rr(2.8, 5.8);
      }
    }

    // (B) Underwater Reef Zone: Pentatonic Glass Chimes & Rising Bubble Streams
    if (wUnderwater > 0.12) {
      if (t > this._nextReefBubble) {
        let bt = t;
        const count = (1 + this._rand() * this._rand() * 5) | 0;
        const pan = this._rr(-0.6, 0.6);
        for (let i = 0; i < count; i++) {
          const f = this._rr(400, 1280);
          this._triggerVoice(
            this.bubblePool,
            bt,
            f,
            f * this._rr(1.45, 2.15),
            0.05 + 38.0 / f,
            this._rr(0.025, 0.065) * wUnderwater,
            0.006,
            pan
          );
          bt += this._rr(0.065, 0.18);
        }
        this._nextReefBubble = bt + this._rr(0.9, 4.2);
      }
      if (t > this._nextReefChime) {
        const REEF_NOTES = [0, 2, 5, 7, 9, 12, 14, 17, 19]; // D major pentatonic above A4
        const semi = REEF_NOTES[(this._rand() * REEF_NOTES.length) | 0];
        const f = 440.0 * Math.pow(2.0, semi / 12.0);
        this._triggerVoice(
          this.reefChimePool,
          t,
          f,
          f * 0.999,
          4.8,
          this._rr(0.018, 0.036) * wUnderwater,
          0.028,
          this._rr(-0.7, 0.7)
        );
        this._nextReefChime = t + this._rr(2.2, 6.5);
      }
    }

    // (C) Deep Abyss Zone: Resonant Sunken Temple Bells & Sub-Harmonic Pulses
    if (wDeep > 0.12 && t > this._nextDeepBell) {
      const DEEP_FREQ = [110.0, 130.81, 146.83, 174.61, 196.0, 220.0, 261.63]; // D Dorian low bells
      const f = DEEP_FREQ[(this._rand() * DEEP_FREQ.length) | 0];
      const pan = this._rr(-0.65, 0.65);
      this._triggerVoice(
        this.deepBellPool,
        t,
        f * 1.004,
        f * 0.996,
        6.2,
        this._rr(0.032, 0.058) * wDeep,
        0.08,
        pan
      );
      this._nextDeepBell = t + this._rr(3.2, 7.8);
    }

    // 4. Spatial Proximity Sperm Whale Bioacoustics (靠近鯨魚時的聲音)
    if (prox > 0.05) {
      // Compute stereo pan toward Mother and Calf using camera right vector
      const invDistM = 1.0 / Math.max(1.0, distM);
      const panM = clamp((dxM * camRight.x + dyM * camRight.y + dzM * camRight.z) * invDistM * 0.85, -0.9, 0.9);
      const invDistC = 1.0 / Math.max(1.0, distC);
      const panC = clamp((dxC * camRight.x + dyC * camRight.y + dzC * camRight.z) * invDistC * 0.85, -0.9, 0.9);

      // (1) Expressive Mother & Calf Melodic Whale Calls (more frequent when closer)
      if (t > this._nextWhaleSong) {
        let wt = t;
        // Mother deep resonant call (fundamental + upper harmonic)
        const fM0 = this._rr(115, 185);
        const fM1 = fM0 * this._rr(0.68, 1.55);
        const durM = this._rr(1.8, 3.2);
        const volM = (0.045 + 0.11 * prox) * clamp(1.15 - distM / 60.0, 0.25, 1.0);
        this._triggerVoice(this.whaleSongPool, wt, fM0, fM1, durM, volM, durM * 0.35, panM);
        this._triggerVoice(this.whaleHarmPool, wt, fM0 * 2.0, fM1 * 1.98, durM * 0.9, volM * 0.45, durM * 0.38, panM);

        wt += durM * 0.78;

        // Calf higher-pitched affectionate answering call
        const fC0 = this._rr(250, 390);
        const fC1 = fC0 * this._rr(0.76, 1.38);
        const durC = this._rr(1.1, 2.0);
        const volC = (0.035 + 0.085 * prox) * clamp(1.15 - distC / 56.0, 0.25, 1.0);
        this._triggerVoice(this.whaleSongPool, wt, fC0, fC1, durC, volC, durC * 0.32, panC);
        this._triggerVoice(this.whaleHarmPool, wt, fC0 * 1.5, fC1 * 1.5, durC * 0.85, volC * 0.35, durC * 0.35, panC);

        const interval = 4.5 + (1.0 - prox) * 14.0 + this._rr(0.0, 3.5);
        this._nextWhaleSong = wt + durC + interval;
      }

      // (2) Authentic Sperm Whale Echolocation Click Codas (rhythmic 4-6 click bursts when within 38m)
      if (minDist < 38.0 && t > this._nextWhaleCoda) {
        const codaProx = clamp(1.0 - minDist / 38.0, 0.0, 1.0);
        const nClicks = 3 + ((this._rand() * 3) | 0);
        const baseClickF = distM <= distC ? this._rr(620, 880) : this._rr(880, 1180);
        const clickPan = distM <= distC ? panM : panC;
        let ct = t;
        for (let c = 0; c < nClicks; c++) {
          this._triggerVoice(
            this.whaleClickPool,
            ct,
            baseClickF * 1.35,
            baseClickF * 0.55,
            0.038,
            (0.03 + 0.075 * codaProx) * (1.0 - c * 0.08),
            0.003,
            clickPan
          );
          // Classic sperm whale coda rhythm: evenly spaced clicks + slightly delayed terminal click
          ct += c === nClicks - 2 ? this._rr(0.24, 0.34) : this._rr(0.11, 0.16);
        }
        this._nextWhaleCoda = ct + this._rr(2.8, 6.5) * (1.3 - 0.6 * codaProx);
      }

      // (3) Surface Blowhole Exhalation Whoosh when Mother or Calf is spouting nearby
      const ctrl = whalePod.controller;
      const mSpouting = ctrl && ctrl._mState && ctrl._mState.spouting;
      const cSpouting = ctrl && ctrl._cState && ctrl._cState.spouting;
      if ((mSpouting || cSpouting) && minDist < 46.0 && t > this._nextSpoutSound) {
        const spoutPan = mSpouting ? panM : panC;
        const spoutVol = (mSpouting ? 0.14 : 0.09) * prox * (0.45 + 0.55 * wSurface);
        this.spoutPanner.pan.setValueAtTime(spoutPan, t);
        this.spoutFilter.frequency.cancelScheduledValues(t);
        this.spoutFilter.frequency.setValueAtTime(290, t);
        this.spoutFilter.frequency.exponentialRampToValueAtTime(640, t + 0.35);
        this.spoutFilter.frequency.exponentialRampToValueAtTime(340, t + 0.95);

        this.spoutEnv.gain.cancelScheduledValues(t);
        this.spoutEnv.gain.setValueAtTime(0.0001, t);
        this.spoutEnv.gain.linearRampToValueAtTime(spoutVol, t + 0.09);
        this.spoutEnv.gain.setTargetAtTime(0.0001, t + 0.28, 0.22);

        this._nextSpoutSound = t + 2.2;
      }
    }
  }
}
