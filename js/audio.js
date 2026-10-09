// 風切り音。音声ファイルを使わず、ノイズをフィルターで加工して作る。
// 左右で別のノイズを使い、低い唸り・ゴーという風・かすかな笛音の3層を速度に応じて混ぜる。
// 音量は速度に対して緩やかに飽和させ、長時間聞いても疲れにくい上限に抑える。
export class Wind {
  constructor() {
    this.ctx = null;
    this.gust = 0;
    this.gustV = 0;
  }

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);
      this.layers = [];
      for (const pan of [-0.7, 0.7]) {
        const src = ctx.createBufferSource();
        src.buffer = this._pinkNoise(ctx, 6);
        src.loop = true;
        const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (p) { p.pan.value = pan; p.connect(this.master); }
        const out = p || this.master;

        const rumble = ctx.createBiquadFilter();
        rumble.type = 'lowpass'; rumble.frequency.value = 160;
        const rumbleG = ctx.createGain(); rumbleG.gain.value = 0;
        src.connect(rumble).connect(rumbleG).connect(out);

        const whoosh = ctx.createBiquadFilter();
        whoosh.type = 'bandpass'; whoosh.frequency.value = 500; whoosh.Q.value = 0.7;
        const whooshG = ctx.createGain(); whooshG.gain.value = 0;
        src.connect(whoosh).connect(whooshG).connect(out);

        const whistle = ctx.createBiquadFilter();
        whistle.type = 'bandpass'; whistle.frequency.value = 1300; whistle.Q.value = 5;
        const whistleG = ctx.createGain(); whistleG.gain.value = 0;
        src.connect(whistle).connect(whistleG).connect(out);

        src.start(0, Math.random() * 5);
        this.layers.push({ rumbleG, whoosh, whooshG, whistle, whistleG, phase: Math.random() * 10 });
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _pinkNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    // ループの継ぎ目でプツッと鳴らないよう端を馴染ませる
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
    return buf;
  }

  // speed: 現在の落下速度[m/s]、volume: 0..1
  update(speed, dt, volume = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(speed / 30, 1.15);
    const loud = Math.pow(Math.min(s, 1), 0.75);
    // ゆるやかな突風（ランダムウォーク）
    this.gustV += (Math.random() - 0.5) * dt * 0.8 - this.gustV * dt * 0.6;
    this.gust = Math.max(-1, Math.min(1, this.gust + this.gustV * dt * 2));
    this.master.gain.setTargetAtTime(0.75 * volume, t, 0.3);
    for (const L of this.layers) {
      L.phase += dt;
      const g = this.gust * 0.5 + Math.sin(L.phase * 0.37) * 0.25;
      L.rumbleG.gain.setTargetAtTime((0.55 * loud) * (1 + g * 0.25), t, 0.15);
      L.whooshG.gain.setTargetAtTime((0.04 + 0.42 * loud) * (1 + g * 0.3), t, 0.15);
      L.whoosh.frequency.setTargetAtTime(380 + 650 * s + g * 160, t, 0.25);
      L.whistleG.gain.setTargetAtTime(0.05 * loud * Math.max(0, 0.4 + g), t, 0.3);
      L.whistle.frequency.setTargetAtTime(1100 + 500 * s + g * 250, t, 0.4);
    }
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
}
