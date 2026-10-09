// ビル街。プレイヤーは常に原点に留まり、街のほうが上へ流れる。
//
// 無限スクロールの仕組み：
//  - ビル本体：1本の箱（下端は奈落の霧の中 y=-BOTTOM で固定、上端は屋上）。窓や外壁はシェーダーで
//    「落下距離 fall」の分だけ模様をずらして描くので、ジオメトリを動かさなくても壁面が上へ流れる。
//    模様は P=16384m 周期で完全に繰り返すため、fall を P で割った余りだけを GPU に渡す（精度が落ちない）。
//  - 屋上と屋上設備：開始直後だけ見える。fall の分だけ上へ動き、十分上へ行ったら止める／隠す。
//  - 壁面の看板・配管・室外機・渡り廊下：固定数のインスタンスを使い回す。上端を越えたものは
//    下端へ戻り、そのときだけ別のビル・別の場所・別の種類に付け替える（生成・破棄なし）。
//  ビル本体・装飾・屋上設備・空はそれぞれ 1 ドローコール。
import * as THREE from '../vendor/three.module.min.js';
import { COMMON_GLSL } from './shaders.js';

export const PATTERN_PERIOD = 16384; // 外壁模様の周期[m]。階高 4m / 3.2m のどちらでも割り切れる
const BOTTOM = -4200;                // ビルの下端（霧で完全に見えない深さ）
const ROOF_CLAMP = 5000;             // 屋上はこれ以上は上へ動かさない（とうに視界外）
const DECO_LO = -1100, DECO_HI = 600; // 壁面装飾が存在する高さの範囲（プレイヤー基準）
const DECO_SPAN = DECO_HI - DECO_LO;
const DECO_COUNT = 2000;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function instancedBox() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = box.index;
  g.setAttribute('position', box.attributes.position);
  g.setAttribute('normal', box.attributes.normal);
  return g;
}

export class City {
  constructor(scene) {
    this.scene = scene;
    this.rng = mulberry32(20261009);
    this.shared = {
      uSunDir: { value: new THREE.Vector3(-0.8, 0.13, -0.55).normalize() },
      uFogDensity: { value: 0.001 },
      uTime: { value: 0 },
    };
    this.bases = [];   // 装飾を取り付ける対象（近〜中距離の本体のみ）
    this.boxes = [];   // 描画する箱（本体＋段差の上層＋遠景）
    this.bridges = []; // 渡り廊下を架けられる隣接ペア
    this.fall = 0;

    this._layout();
    this._buildBuildings();
    this._buildRoofProps();
    this._buildDecorations();
    this._buildSky();
    this.update(0, 0);
  }

  // ---------- 配置 ----------
  _layout() {
    const r = this.rng;
    const PITCH = 74, N = 14, CLEAR = 40;
    const grid = new Map();
    for (let i = -N; i <= N; i++) {
      for (let j = -N; j <= N; j++) {
        if (i === 0 && j === 0) continue; // プレイヤーが落ちる広い吹き抜け
        const ring = Math.max(Math.abs(i), Math.abs(j));
        if (ring > 1 && r() < 0.07) continue; // ところどころ空き地（奥行きが見える）
        let hw = (30 + r() * 24) / 2, hd = (30 + r() * 24) / 2;
        const cx = i * PITCH + (r() - 0.5) * 8;
        const cz = j * PITCH + (r() - 0.5) * 8;
        // プレイヤーの周囲に十分な空間を確保（壁面が至近距離を通過しないように）
        const near = () => Math.hypot(Math.max(Math.abs(cx) - hw, 0), Math.max(Math.abs(cz) - hd, 0));
        while (near() < CLEAR) { hw *= 0.93; hd *= 0.93; }
        const dist = Math.hypot(cx, cz);
        let top0 = -(45 + r() * 230);
        if (dist > 220 && r() < 0.13) top0 = -40 + r() * 260;          // 頭上までそびえる超高層
        if (ring === 2 && r() < 0.12) top0 = 20 + r() * 80;            // 近くにも何本か
        const s = r();
        const style = s < 0.38 ? 0 : s < 0.66 ? 1 : s < 0.83 ? 2 : 3;
        const b = { cx, cz, hw, hd, top0, ref0: top0, style, seed: Math.floor(r() * 60000) + 10, dist, i, j };
        this.boxes.push(b);
        grid.set(`${i},${j}`, b);
        if (dist < 430) this.bases.push(b);
        // 段差のある塔（上層を細くして載せる）
        if (dist < 1100 && r() < 0.3) {
          const k = 0.55 + r() * 0.2;
          this.boxes.push({ cx, cz, hw: hw * k, hd: hd * k, top0: top0 + 20 + r() * 80, ref0: top0, style, seed: b.seed, dist: dist + 0.1, tier: true });
        }
      }
    }
    // 遠景の都市シルエット
    for (let n = 0; n < 170; n++) {
      const a = r() * Math.PI * 2;
      const dist = 1150 + r() * 1300;
      const hw = 30 + r() * 30, hd = 30 + r() * 30;
      const s = r();
      this.boxes.push({
        cx: Math.cos(a) * dist, cz: Math.sin(a) * dist, hw, hd,
        top0: -250 + r() * 600, ref0: 0, style: s < 0.5 ? 0 : s < 0.8 ? 1 : 3,
        seed: Math.floor(r() * 60000) + 10, dist,
      });
    }
    for (const b of this.boxes) if (b.ref0 === 0 && !b.tier) b.ref0 = b.top0;

    // 渡り廊下の候補：x方向・z方向に隣り合う近距離のビル同士
    for (const b of this.bases) {
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const o = grid.get(`${b.i + di},${b.j + dj}`);
        if (!o || o.dist >= 430) continue;
        if (di) {
          const lo = Math.max(b.cz - b.hd, o.cz - o.hd) + 3, hi = Math.min(b.cz + b.hd, o.cz + o.hd) - 3;
          if (hi - lo < 8) continue;
          const x0 = b.cx + b.hw, x1 = o.cx - o.hw;
          this.bridges.push({ a: b, b: o, axis: 0, x0, x1, lo, hi });
        } else {
          const lo = Math.max(b.cx - b.hw, o.cx - o.hw) + 3, hi = Math.min(b.cx + b.hw, o.cx + o.hw) - 3;
          if (hi - lo < 8) continue;
          const z0 = b.cz + b.hd, z1 = o.cz - o.hd;
          this.bridges.push({ a: b, b: o, axis: 1, x0: z0, x1: z1, lo, hi });
        }
      }
    }
    // プレイヤーの近くを横切る渡り廊下は使わない
    this.bridges = this.bridges.filter((br) => {
      const mid = (br.lo + br.hi) / 2;
      const p = br.axis === 0 ? [(br.x0 + br.x1) / 2, mid] : [mid, (br.x0 + br.x1) / 2];
      return Math.hypot(p[0], p[1]) > 60;
    });

    this.bases.sort((a, b) => a.dist - b.dist);
    // 手前から描くとZテストで奥の描画が省けるので距離順に並べる（プレイヤーは水平移動しない）
    this.boxes.sort((a, b) => a.dist - b.dist);
  }

  // ---------- ビル本体 ----------
  _buildBuildings() {
    const n = this.boxes.length;
    const g = instancedBox();
    const aBox = new Float32Array(n * 4), aInfo = new Float32Array(n * 4);
    this.boxes.forEach((b, k) => {
      aBox.set([b.cx, b.cz, b.hw * 2, b.hd * 2], k * 4);
      aInfo.set([b.top0, b.ref0, b.style, b.seed], k * 4);
    });
    g.setAttribute('aBox', new THREE.InstancedBufferAttribute(aBox, 4));
    g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
    g.instanceCount = n;

    this.buildingMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        uFallC: { value: 0 },
        uFallMod: { value: 0 },
        uBottom: { value: BOTTOM },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aBox;
        attribute vec4 aInfo;
        uniform float uFallC;
        uniform float uBottom;
        varying vec3 vWorld;
        varying vec3 vN;
        varying vec4 vInfo;
        varying float vTop;
        void main() {
          float top = aInfo.x + uFallC;
          vec3 wp = vec3(aBox.x + position.x * aBox.z, position.y > 0.0 ? top : uBottom, aBox.y + position.z * aBox.w);
          vWorld = wp; vN = normal; vInfo = aInfo; vTop = top;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${COMMON_GLSL}
        uniform float uFallMod;
        varying vec3 vWorld;
        varying vec3 vN;
        varying vec4 vInfo;
        varying float vTop;
        void main() {
          vec3 n = normalize(vN);
          vec3 V = normalize(vWorld - cameraPosition);
          float sunL = max(dot(n, uSunDir), 0.0);
          float diff = 0.66 + 0.42 * sunL + 0.1 * n.y;
          float seed = vInfo.w;
          int st = int(vInfo.z + 0.5);
          vec3 sd = hash3(vec3(seed, 7.0, 3.0));
          vec3 col;

          if (n.y > 0.5) {
            // 屋上
            col = mix(vec3(0.33, 0.34, 0.37), vec3(0.42, 0.40, 0.38), sd.y) * diff;
            vec2 g = fract(vWorld.xz / 6.0);
            col *= 0.94 + 0.06 * step(0.5, g.x) ;
          } else {
            float faceId = abs(n.x) > 0.5 ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);
            float u = abs(n.x) > 0.5 ? vWorld.z * n.x : -vWorld.x * n.z;
            float v = vWorld.y - vInfo.y - uFallMod; // ビル基準の高さ（落下で上へ流れる）

            float floorH, colW, wx, wy, wy0;
            vec3 wall;
            if (st == 0) {        // ガラスのオフィス
              floorH = 4.0; colW = 1.6; wx = 0.88; wy = 0.74; wy0 = 0.16;
              wall = mix(vec3(0.24, 0.29, 0.35), vec3(0.34, 0.36, 0.40), sd.x);
            } else if (st == 1) { // コンクリート
              floorH = 3.2; colW = 2.4; wx = 0.52; wy = 0.52; wy0 = 0.26;
              wall = mix(vec3(0.66, 0.61, 0.54), vec3(0.58, 0.59, 0.61), sd.x);
            } else if (st == 2) { // 商業ビル
              floorH = 4.0; colW = 3.0; wx = 0.80; wy = 0.62; wy0 = 0.2;
              wall = mix(vec3(0.24, 0.22, 0.27), vec3(0.36, 0.30, 0.33), sd.x);
            } else {              // 集合住宅
              floorH = 3.2; colW = 3.6; wx = 0.66; wy = 0.55; wy0 = 0.3;
              wall = mix(vec3(0.76, 0.73, 0.68), vec3(0.66, 0.70, 0.74), sd.x);
            }
            float period = ${PATTERN_PERIOD.toFixed(1)} / floorH;
            vec2 g = vec2(u / colW, v / floorH);
            vec2 cell = floor(g);
            vec2 f = fract(g);
            float nF = mod(cell.y, period);
            float zone = floor(nF / 32.0);
            float fz = mod(nF, 32.0);
            vec3 hz = hash3(vec3(seed * 5.0 + faceId, zone + 1.0, 11.0));
            vec3 hc = hash3(vec3(cell.x + 60000.0 + faceId * 7919.0, nF + 1.0, seed));
            float litFrac = mix(0.06, 0.55, hz.x * hz.x + 0.15 * hz.y);

            vec2 fw = fwidth(g);
            vec2 aaw = fw * 0.75 + 0.002;
            float mask = boxMask(f, vec2(0.5 - wx * 0.5, wy0), vec2(0.5 + wx * 0.5, wy0 + wy), aaw);
            bool mech = fz < 1.0; // 32階ごとの設備階（ルーバー）
            if (mech) mask = 0.0;

            // 窓の外側（壁）
            vec3 wallC = wall * diff;
            if (st == 3) wallC *= 1.0 - 0.18 * (1.0 - smoothstep(0.1 - aaw.y, 0.1 + aaw.y, f.y)); // ベランダの影
            if (mech) wallC *= 0.72 + 0.12 * step(0.5, fract(f.y * 4.0));
            if (st == 2 && mech) wallC = hue2rgb(fract(hz.z + seed * 0.013)) * 0.9 + 0.1; // 商業ビルの帯状LED

            // 窓の内側
            vec3 refl = skyColor(reflect(V, n));
            vec3 unlit = st == 0 ? refl * 0.62 + vec3(0.02, 0.04, 0.06) : refl * 0.32 + vec3(0.05, 0.06, 0.09);
            vec3 lc = mix(vec3(1.0, 0.80, 0.52), vec3(0.86, 0.93, 1.0), step(0.62, hc.y));
            if (st == 2) lc = mix(lc, hue2rgb(hc.z) * 0.6 + 0.4, step(0.6, hz.y));
            lc *= 0.78 + 0.35 * hc.z;
            // 室内っぽさ：天井の照明、下側の家具の影
            vec2 wf = vec2((f.x - (0.5 - wx * 0.5)) / wx, (f.y - wy0) / wy);
            float ceilL = smoothstep(0.78, 0.95, wf.y);
            float furn = (1.0 - step(0.32, wf.y)) * step(0.45, fract(wf.x * 2.3 + hc.x * 5.0)) * step(0.35, hc.z);
            vec3 litC = lc * (0.82 + 0.45 * ceilL) * (1.0 - 0.55 * furn);
            bool lit = hc.x < litFrac;
            vec3 winC = lit ? litC : unlit;
            vec3 detail = mix(wallC, winC, mask);

            // 遠くて窓が1画素より小さくなったら平均色へ（モアレ防止）
            vec3 avgWin = mix(unlit, lc * 0.9, litFrac);
            vec3 avg = mix(mech ? wallC : wall * diff, avgWin, mech ? 0.0 : wx * wy);
            float aaF = smoothstep(0.18, 0.6, max(fw.x, fw.y));
            col = mix(detail, avg, aaF);

            // 屋上の縁（パラペット）
            if (vWorld.y > vTop - 1.4) col = wall * diff * 1.18;
          }
          col = mix(col, skyColor(V), fogAmount(vWorld));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.buildings = new THREE.Mesh(g, this.buildingMat);
    this.buildings.frustumCulled = false;
    this.scene.add(this.buildings);
  }

  // ---------- 屋上設備（開始直後に見下ろすもの） ----------
  _buildRoofProps() {
    const r = this.rng;
    const items = [];
    const add = (x, y, z, sx, sy, sz, kind, hue = 0) => items.push([x, y, z, sx, sy, sz, kind, hue, Math.floor(r() * 9999)]);
    const tierOf = new Map();
    for (const b of this.boxes) if (b.tier) tierOf.set(`${b.cx},${b.cz}`, b);
    for (const b of this.boxes) {
      const tier = b.tier ? null : tierOf.get(`${b.cx},${b.cz}`);
      const isTop = !tier;
      // 下の段の屋上では、上の段と重なる場所を避ける
      const blocked = (x, z, sx, sz) => !!tier && Math.abs(x - tier.cx) < tier.hw + sx / 2 + 1 && Math.abs(z - tier.cz) < tier.hd + sz / 2 + 1;
      if (b.dist < 750) {
        const cnt = 2 + Math.floor(r() * 4);
        for (let k = 0; k < cnt; k++) {
          const sx = 3 + r() * 7, sz = 3 + r() * 7, sy = 2 + r() * 4;
          const x = b.cx + (r() - 0.5) * (b.hw * 2 - sx - 4);
          const z = b.cz + (r() - 0.5) * (b.hd * 2 - sz - 4);
          if (blocked(x, z, sx, sz)) continue;
          add(x, b.top0 + sy / 2, z, sx, sy, sz, r() < 0.3 ? 5 : 0);
        }
        if (isTop && b.hw > 13 && b.hd > 13 && r() < 0.25) {
          add(b.cx, b.top0 + 0.3, b.cz, 22, 0.6, 22, 8); // ヘリポート
        } else if (isTop && r() < 0.4) {
          const h = 12 + r() * 30;
          add(b.cx + (r() - 0.5) * b.hw, b.top0 + h / 2, b.cz + (r() - 0.5) * b.hd, 0.8, h, 0.8, 7);
        }
      }
      // 航空障害灯（高いビルの角）
      if (isTop && b.dist < 1600 && (b.top0 > -100 || b.dist > 600) && r() < 0.45) {
        const s = 1.2 + b.dist * 0.0022;
        for (const [ux, uz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          add(b.cx + ux * (b.hw - 1), b.top0 + s / 2 + 1.2, b.cz + uz * (b.hd - 1), s, s, s, 6);
        }
      }
    }
    const g = instancedBox();
    const off = new Float32Array(items.length * 3), scl = new Float32Array(items.length * 3), info = new Float32Array(items.length * 4);
    items.forEach((it, k) => {
      off.set(it.slice(0, 3), k * 3);
      scl.set(it.slice(3, 6), k * 3);
      info.set([it[6], it[7], it[8], 0], k * 4);
    });
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
    g.setAttribute('aScl', new THREE.InstancedBufferAttribute(scl, 3));
    g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
    g.instanceCount = items.length;
    this.roofMat = makePropMaterial(this.shared, false);
    this.roofProps = new THREE.Mesh(g, this.roofMat);
    this.roofProps.frustumCulled = false;
    this.scene.add(this.roofProps);
  }

  // ---------- 壁面装飾（使い回し） ----------
  _buildDecorations() {
    const g = instancedBox();
    this.dOff = new THREE.InstancedBufferAttribute(new Float32Array(DECO_COUNT * 3), 3);
    this.dScl = new THREE.InstancedBufferAttribute(new Float32Array(DECO_COUNT * 3), 3);
    this.dInfo = new THREE.InstancedBufferAttribute(new Float32Array(DECO_COUNT * 4), 4);
    for (const a of [this.dOff, this.dScl, this.dInfo]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOff', this.dOff);
    g.setAttribute('aScl', this.dScl);
    g.setAttribute('aInfo', this.dInfo);
    g.instanceCount = DECO_COUNT;
    this.dWrap = new Float64Array(DECO_COUNT); // 何周目か（変わったら付け替え）
    this.decoMat = makePropMaterial(this.shared, true);
    this.decos = new THREE.Mesh(g, this.decoMat);
    this.decos.frustumCulled = false;
    this.scene.add(this.decos);
    this._resetDecorations();
  }

  _resetDecorations() {
    const r = this.rng;
    for (let i = 0; i < DECO_COUNT; i++) {
      const y = DECO_LO + ((i + r()) / DECO_COUNT) * DECO_SPAN; // 高さ方向に均等に散らす
      this.dOff.array[i * 3 + 1] = y;
      this.dWrap[i] = Math.floor((y + this.fall - DECO_LO) / DECO_SPAN);
      this._placeDeco(i, y);
    }
    for (const a of [this.dOff, this.dScl, this.dInfo]) a.needsUpdate = true;
  }

  _topNow(b) { return b.top0 + Math.min(this.fall, ROOF_CLAMP); }

  // i 番目の装飾を、現在の高さ yNow に置ける場所へ付け替える
  _placeDeco(i, yNow) {
    const r = this.rng;
    const off = this.dOff.array, scl = this.dScl.array, info = this.dInfo.array;
    const setTo = (x, z, sx, sy, sz, kind, hue) => {
      off[i * 3] = x; off[i * 3 + 2] = z;
      scl[i * 3] = sx; scl[i * 3 + 1] = sy; scl[i * 3 + 2] = sz;
      info[i * 4] = kind; info[i * 4 + 1] = hue; info[i * 4 + 2] = Math.floor(r() * 9999); info[i * 4 + 3] = 0;
    };
    for (let tries = 0; tries < 10; tries++) {
      const t = r();
      const kind = t < 0.38 ? 0 : t < 0.52 ? 3 : t < 0.68 ? 2 : t < 0.85 ? 1 : 4;
      if (kind === 4) {
        if (!this.bridges.length) continue;
        const br = this.bridges[Math.floor(r() * this.bridges.length)];
        const h = 5 + r() * 3, w = 7 + r() * 5;
        if (yNow + h / 2 > Math.min(this._topNow(br.a), this._topNow(br.b)) - 4) continue;
        const c = br.lo + w / 2 + r() * Math.max(br.hi - br.lo - w, 0);
        const len = br.x1 - br.x0 + 2;
        const m = (br.x0 + br.x1) / 2;
        if (br.axis === 0) setTo(m, c, len, h, w, 4, r());
        else setTo(c, m, w, h, len, 4, r());
        return;
      }
      const b = this.bases[Math.floor(Math.pow(r(), 1.6) * this.bases.length)]; // 近いビルほど選ばれやすい
      // プレイヤーから見える面だけを選ぶ
      const faces = [];
      if (b.cx - b.hw > 0) faces.push(0); // -x 面
      if (b.cx + b.hw < 0) faces.push(1); // +x 面
      if (b.cz - b.hd > 0) faces.push(2); // -z 面
      if (b.cz + b.hd < 0) faces.push(3); // +z 面
      if (!faces.length) continue;
      const face = faces[Math.floor(r() * faces.length)];
      const nx = face === 0 ? -1 : face === 1 ? 1 : 0, nz = face === 2 ? -1 : face === 3 ? 1 : 0;
      const halfW = nx ? b.hd : b.hw; // 面の横幅の半分
      let along, out, tang, height;   // along=面に沿う幅, out=張り出し, height=高さ
      let hue = r();
      if (kind === 0) { along = 2 + r() * 2.5; height = 1.2 + r() * 1.2; out = 1 + r() * 0.8; }
      else if (kind === 3) { along = 0.6 + r() * 0.7; height = 30 + r() * 110; out = 0.7 + r() * 0.6; }
      else if (kind === 2) { along = 0.5; height = 8 + r() * 14; out = 2.6 + r() * 1.2; }
      else { along = 10 + r() * 14; height = 12 + r() * 20; out = 0.6; }
      if (along > halfW * 2 - 3) continue;
      if (yNow + height / 2 > this._topNow(b) - 2) continue;
      tang = (r() - 0.5) * (halfW * 2 - along - 2);
      // 看板は壁から少し浮かせて取り付ける。同じ面で重なってもチラつかないよう距離をばらす
      const gap = kind === 1 ? 0.8 + r() * 1.2 : kind === 2 ? 0 : r() * 0.15;
      const dOut = out / 2 + gap;
      if (kind === 2) {
        // 縦型の突き出し看板：薄い板が壁から垂直に張り出す
        const x = nx ? b.cx + nx * (b.hw + dOut) : b.cx + tang;
        const z = nz ? b.cz + nz * (b.hd + dOut) : b.cz + tang;
        if (nx) setTo(x, z, out, height, along, 2, hue); else setTo(x, z, along, height, out, 2, hue);
      } else {
        const x = nx ? b.cx + nx * (b.hw + dOut) : b.cx + tang;
        const z = nz ? b.cz + nz * (b.hd + dOut) : b.cz + tang;
        if (nx) setTo(x, z, out, height, along, kind, hue); else setTo(x, z, along, height, out, kind, hue);
      }
      return;
    }
    // 置ける場所がない（まだ屋上より上の高さ）→ 次に一周するまで非表示
    scl[i * 3] = scl[i * 3 + 1] = scl[i * 3 + 2] = 0;
  }

  // ---------- 空 ----------
  _buildSky() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.shared },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${COMMON_GLSL}
        varying vec3 vDir;
        void main() { gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0); }`,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(7000, 32, 20), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 10; // 不透明物のあとに描く（隠れた画素を塗らない）
    this.scene.add(this.sky);
  }

  // ---------- 毎フレーム ----------
  // fall: 開始からの落下距離[m]（JSの倍精度で積算）。time: 経過秒
  update(fall, time) {
    this.fall = fall;
    this.shared.uTime.value = time % 3600;
    const fallC = Math.min(fall, ROOF_CLAMP);
    this.buildingMat.uniforms.uFallC.value = fallC;
    this.buildingMat.uniforms.uFallMod.value = fall % PATTERN_PERIOD;
    this.roofMat.uniforms.uShift.value = fallC;
    this.roofProps.visible = fall < ROOF_CLAMP;
    this.decoMat.uniforms.uScroll.value = fall % DECO_SPAN;

    // 上端を越えて下端へ戻った装飾だけを付け替える（1フレームあたり数個）
    const off = this.dOff.array;
    let changed = false;
    for (let i = 0; i < DECO_COUNT; i++) {
      const y0 = off[i * 3 + 1];
      const k = Math.floor((y0 + fall - DECO_LO) / DECO_SPAN);
      if (k !== this.dWrap[i]) {
        this.dWrap[i] = k;
        const yNow = DECO_LO + (((y0 + fall - DECO_LO) % DECO_SPAN) + DECO_SPAN) % DECO_SPAN;
        this._placeDeco(i, yNow);
        changed = true;
      }
    }
    if (changed) for (const a of [this.dOff, this.dScl, this.dInfo]) a.needsUpdate = true;
  }

  reset() {
    this.fall = 0;
    this.rng = mulberry32(20261009 + 77);
    this._resetDecorations();
    this.update(0, 0);
  }
}

// 屋上設備と壁面装飾の共通マテリアル。wrap=true なら高さ方向に巡回する
function makePropMaterial(shared, wrap) {
  return new THREE.ShaderMaterial({
    defines: wrap ? { WRAP: 1 } : {},
    uniforms: {
      ...shared,
      uShift: { value: 0 },
      uScroll: { value: 0 },
      uLo: { value: DECO_LO },
      uSpan: { value: DECO_SPAN },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aOff;
      attribute vec3 aScl;
      attribute vec4 aInfo;
      uniform float uShift;
      uniform float uScroll;
      uniform float uLo;
      uniform float uSpan;
      varying vec3 vWorld;
      varying vec3 vL;
      varying vec3 vN;
      varying vec3 vScl;
      varying vec4 vInfo;
      varying float vEdge;
      void main() {
        #ifdef WRAP
          float y = uLo + mod(aOff.y + uScroll - uLo, uSpan);
          // 巡回の上下端付近では霧に溶かす（出現・消滅を見せない）
          vEdge = clamp(1.0 - smoothstep(uLo, uLo + 300.0, y) + smoothstep(uLo + uSpan - 300.0, uLo + uSpan, y), 0.0, 1.0);
        #else
          float y = aOff.y + uShift;
          vEdge = 0.0;
        #endif
        vec3 wp = vec3(aOff.x, y, aOff.z) + position * aScl;
        vWorld = wp; vL = position; vN = normal; vScl = aScl; vInfo = aInfo;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${COMMON_GLSL}
      varying vec3 vWorld;
      varying vec3 vL;
      varying vec3 vN;
      varying vec3 vScl;
      varying vec4 vInfo;
      varying float vEdge;
      void main() {
        vec3 n = normalize(vN);
        vec3 V = normalize(vWorld - cameraPosition);
        float diff = 0.64 + 0.42 * max(dot(n, uSunDir), 0.0) + 0.12 * n.y;
        int kind = int(vInfo.x + 0.5);
        float hue = vInfo.y;
        float seed = vInfo.z;
        // 面上の 2D 座標（[0,1] と メートル）
        vec2 q, m;
        if (abs(n.x) > 0.5)      { q = vL.zy + 0.5; m = q * vScl.zy; }
        else if (abs(n.z) > 0.5) { q = vL.xy + 0.5; m = q * vScl.xy; }
        else                     { q = vL.xz + 0.5; m = q * vScl.xz; }
        // 一番薄い軸に垂直な面＝看板の「表」
        float thin = min(vScl.x, min(vScl.y, vScl.z));
        bool front = (abs(n.x) > 0.5 && vScl.x == thin) || (abs(n.z) > 0.5 && vScl.z == thin);
        vec3 col;

        if (kind == 0) {         // 室外機・設備
          col = vec3(0.56, 0.57, 0.58) * diff;
          col *= 0.85 + 0.15 * step(0.5, fract(m.y * 3.0));
        } else if (kind == 5) {  // 給水タンク
          col = vec3(0.74, 0.71, 0.64) * diff * (0.9 + 0.1 * step(0.5, fract(m.y * 0.8)));
        } else if (kind == 3) {  // 配管
          col = vec3(0.50, 0.50, 0.52) * diff * (0.75 + 0.25 * step(0.12, fract(m.y / 3.0)));
        } else if (kind == 6) {  // 航空障害灯（ゆっくり点滅）
          float b = 0.35 + 0.65 * smoothstep(0.2, 0.5, abs(fract(uTime * 0.4 + seed * 0.001) - 0.5) * 2.0);
          col = vec3(1.0, 0.18, 0.12) * (0.6 + 0.6 * b);
        } else if (kind == 7) {  // アンテナ
          col = vec3(0.78, 0.78, 0.80) * diff * (0.8 + 0.2 * step(0.5, fract(m.y / 4.0)));
        } else if (kind == 8) {  // ヘリポート
          col = vec3(0.30, 0.31, 0.33) * diff;
          if (n.y > 0.5) {
            vec2 c = q - 0.5;
            float r = length(c);
            float ring = smoothstep(0.02, 0.0, abs(r - 0.38));
            float H = (step(abs(c.x), 0.14) * step(abs(c.y), 0.2)) * (step(0.09, abs(c.x)) + step(abs(c.y), 0.03));
            col = mix(col, vec3(0.95, 0.80, 0.25), ring);
            col = mix(col, vec3(0.92), clamp(H, 0.0, 1.0));
          }
        } else if (kind == 4) {  // 渡り廊下
          col = vec3(0.60, 0.60, 0.62) * diff;
          if (abs(n.y) < 0.5) {
            float band = step(0.25, q.y) * step(q.y, 0.78);
            float mull = step(0.08, fract(m.x / 2.2));
            vec3 h = hash3(vec3(floor(m.x / 2.2) + 100.0, seed, 3.0));
            vec3 glass = h.x < 0.6 ? vec3(1.0, 0.86, 0.6) * (0.8 + 0.3 * h.y) : skyColor(reflect(V, n)) * 0.5;
            col = mix(col, glass, band * mull);
          }
        } else if (kind == 1) {  // 巨大広告
          col = vec3(0.16, 0.16, 0.18) * diff;
          if (front) {
            vec3 c1 = hue2rgb(hue), c2 = hue2rgb(fract(hue + 0.33 + seed * 0.0001));
            vec3 bg = mix(c1 * 0.45 + 0.08, c2 * 0.85 + 0.1, q.y);
            float asp = vScl.y / max(vScl.x + vScl.z - thin, 1.0);
            vec2 cc = (q - vec2(0.62, 0.6)) * vec2(1.0, asp);
            float circle = smoothstep(0.205, 0.195, length(cc));
            bg = mix(bg, vec3(1.0, 0.96, 0.9), circle * 0.9);
            // 文字列っぽい横棒
            float lines = step(0.08, q.y) * step(q.y, 0.34) * step(0.5, fract(q.y * 12.0)) * step(0.08, q.x) * step(q.x, 0.52 + 0.3 * fract(seed * 0.37));
            bg = mix(bg, vec3(1.0), lines * 0.85);
            // ゆっくり流れる光沢
            float sh = smoothstep(0.06, 0.0, abs(fract(q.x + q.y * 0.4 - uTime * 0.05 + seed * 0.01) - 0.5));
            bg += sh * 0.12;
            float frame = step(0.03, q.x) * step(q.x, 0.97) * step(0.03, q.y) * step(q.y, 0.97);
            col = mix(vec3(0.12), bg * 1.15, frame);
          }
        } else {                 // 縦型ネオン看板
          col = vec3(0.12, 0.11, 0.14) * diff;
          if (front) {
            vec3 hc = hue2rgb(hue) * 0.75 + 0.25;
            float rows = floor(vScl.y / 1.7);
            float ry = q.y * rows;
            vec2 g = vec2(q.x * 3.0, fract(ry) * 3.0);
            vec3 h = hash3(vec3(floor(g.x) + seed + 10.0, floor(g.y) + 1.0, floor(ry) + 1.0));
            float glyph = step(0.42, h.x) * step(0.12, fract(g.x)) * step(fract(g.x), 0.88) * step(0.12, fract(g.y)) * step(fract(g.y), 0.88);
            glyph *= step(0.12, q.x) * step(q.x, 0.88);
            float border = 1.0 - step(0.06, q.x) * step(q.x, 0.94) * step(0.02, q.y) * step(q.y, 0.98);
            col = mix(col, hc * 1.1, max(glyph, border));
            col *= 0.92 + 0.08 * sin(uTime * 1.3 + seed);
          }
        }
        float fog = max(fogAmount(vWorld), vEdge);
        col = mix(col, skyColor(V), fog);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
