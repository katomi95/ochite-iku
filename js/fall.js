// 落下の速度モデル（VRとPCで共通）。
// 目標速度をまず一定の割合でゆっくり上げ下げし（加速度の上限）、実際の速度はそれを
// 「臨界減衰ばね」で追いかける。加速度そのものも0からなめらかに立ち上がるので、
// 急な加速・急な停止が起きない。落下距離は倍精度で積算し、上限は設けない（地面は存在しない）。
export const SPEEDS = [
  { name: 'ゆっくり', v: 7 },
  { name: 'ふつう', v: 15 },
  { name: 'はやい', v: 30 },
];
export const WAIT_SECONDS = 4; // 開始から落ち始めるまでの静止時間

export class Fall {
  constructor() {
    this.level = 0;
    this.reset();
  }

  reset() {
    this.t = 0;          // 開始からの経過秒
    this.fall = 0;       // 落下距離[m]
    this.v = 0;          // 速度[m/s]
    this.a = 0;          // 加速度[m/s²]
    this.ramp = 0;       // 上限付きで目標へ近づく中間の速度
    this.paused = false;
  }

  get waiting() { return this.t < WAIT_SECONDS; }
  get target() { return this.paused || this.waiting ? 0 : SPEEDS[this.level].v; }
  get speedFrac() { return Math.min(this.v / SPEEDS[2].v, 1); }

  update(dt) {
    this.t += dt;
    // 加速は約9秒かけて目標速度へ（どの速度設定でも同じ時間）、減速は最大 6m/s²
    const up = SPEEDS[this.level].v / 9, down = 6;
    const w = 1.3;
    const steps = Math.ceil(dt / 0.02);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const d = this.target - this.ramp;
      this.ramp += Math.max(-down * h, Math.min(up * h, d));
      this.a += (w * w * (this.ramp - this.v) - 2 * w * this.a) * h;
      this.v += this.a * h;
      if (this.v < 0) { this.v = 0; if (this.a < 0) this.a = 0; }
      this.fall += this.v * h;
    }
  }
}
