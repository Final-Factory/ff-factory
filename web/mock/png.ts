// Procedural PNGs for the mock backend: game-like screenshots (a space scene with a black hole and a
// factory floor) so transcripts, the lightbox and the Screenshots drawer have real images to show.
import zlib from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** RGB pixels (3 bytes each, row-major) → PNG bytes. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SceneOpts {
  width: number;
  height: number;
  seed: number;
  /** Strength of the belt glow: 0 = off, 1 = the "neon" look Ben complained about. */
  beltGlow?: number;
  /** Bloom on the disk and stars. */
  bloom?: number;
  /** Where the black hole sits, as fractions of the frame. */
  hole?: { x: number; y: number; r: number };
  /** Tint of the nebula. */
  tint?: [number, number, number];
}

/** A space scene: nebula, stars, a black hole with a Doppler-bright accretion disk, belts along the bottom. */
export function spaceScene(o: SceneOpts): Buffer {
  const { width: w, height: h } = o;
  const rand = rng(o.seed);
  const px = new Float32Array(w * h * 3);
  const tint = o.tint ?? [0.35, 0.22, 0.6];
  const blobs = Array.from({ length: 5 }, () => ({ x: rand() * w, y: rand() * h * 0.8, r: (0.18 + rand() * 0.25) * Math.max(w, h), a: 0.05 + rand() * 0.08 }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const g = 0.02 + 0.03 * (1 - y / h);
      let r = g * 0.6, gg = g * 0.8, b = g * 1.4;
      for (const bl of blobs) {
        const d2 = ((x - bl.x) ** 2 + (y - bl.y) ** 2) / (bl.r * bl.r);
        const f = Math.exp(-d2 * 2.2) * bl.a;
        r += f * tint[0] * 3;
        gg += f * tint[1] * 3;
        b += f * tint[2] * 3;
      }
      px[i] = r;
      px[i + 1] = gg;
      px[i + 2] = b;
    }
  }
  // Stars.
  const bloom = o.bloom ?? 0.6;
  for (let n = 0; n < (w * h) / 900; n++) {
    const x = Math.floor(rand() * w);
    const y = Math.floor(rand() * h * 0.85);
    const m = rand() ** 3 * (0.6 + bloom);
    const rad = m > 0.5 ? 2 : 1;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const f = m / (1 + (dx * dx + dy * dy) * 1.5);
        const i = (yy * w + xx) * 3;
        px[i] += f * 0.95;
        px[i + 1] += f * 0.97;
        px[i + 2] += f;
      }
  }
  // Black hole and accretion disk.
  const hole = o.hole ?? { x: 0.62, y: 0.38, r: 0.09 };
  const cx = hole.x * w, cy = hole.y * h, R = hole.r * Math.min(w, h) * 1.6;
  for (let y = Math.max(0, Math.floor(cy - R * 4)); y < Math.min(h, cy + R * 4); y++) {
    for (let x = Math.max(0, Math.floor(cx - R * 5)); x < Math.min(w, cx + R * 5); x++) {
      const dx = (x - cx) / R, dy = (y - cy) / R;
      const i = (y * w + x) * 3;
      const d = Math.hypot(dx, dy);
      // Disk: a thin ellipse, brighter on the approaching (left) side.
      const e = Math.hypot(dx / 2.6, dy / 0.42);
      const ring = Math.exp(-((e - 1) ** 2) / 0.05);
      const doppler = 1 + 0.9 * Math.max(-1, Math.min(1, -dx / 2.6));
      // Photon ring and lensed glow.
      const photon = Math.exp(-((d - 1.05) ** 2) / 0.004) * 1.2;
      const halo = Math.exp(-((d - 1.1) ** 2) / 0.4) * 0.35 * bloom;
      const k = ring * doppler * (0.8 + bloom * 0.4) + photon + halo;
      px[i] += k * 1.25;
      px[i + 1] += k * 0.72;
      px[i + 2] += k * 0.32;
      if (d < 0.98 && !(ring > 0.5 && dy > 0)) {
        px[i] *= 0.02;
        px[i + 1] *= 0.02;
        px[i + 2] *= 0.02;
      }
    }
  }
  // Factory floor: dark plates, belts with emissive strips, a few machines.
  const floorY = Math.floor(h * 0.78);
  const glow = o.beltGlow ?? 0.3;
  for (let y = floorY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const plate = ((Math.floor(x / 48) + Math.floor((y - floorY) / 48)) & 1) ? 0.09 : 0.075;
      px[i] = plate;
      px[i + 1] = plate * 1.05;
      px[i + 2] = plate * 1.15;
    }
  }
  const belts = [floorY + Math.floor(h * 0.06), floorY + Math.floor(h * 0.14)];
  for (const by of belts) {
    for (let y = by - 7; y <= by + 7; y++) {
      if (y >= h) continue;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const edge = Math.abs(y - by) >= 6;
        const stripe = ((x + by * 3) % 22) < 3 ? 0.06 : 0;
        const base = edge ? 0.22 : 0.14 + stripe;
        px[i] = base;
        px[i + 1] = base;
        px[i + 2] = base * 1.1;
        if (Math.abs(y - by) <= 1) {
          px[i] += 0.2 * glow;
          px[i + 1] += 1.1 * glow;
          px[i + 2] += 1.3 * glow;
        }
      }
    }
    // Belt glow bleeding upwards.
    for (let y = Math.max(0, by - 40); y < Math.min(h, by + 40); y++) {
      const f = Math.exp(-Math.abs(y - by) / 9) * glow * 0.5;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        px[i + 1] += f * 0.8;
        px[i + 2] += f;
      }
    }
  }
  for (let m = 0; m < 4; m++) {
    const mx = Math.floor(w * (0.12 + m * 0.22)), my = floorY - Math.floor(h * 0.05);
    const mw = Math.floor(w * 0.08), mh = Math.floor(h * 0.09);
    for (let y = my; y < Math.min(h, my + mh); y++)
      for (let x = mx; x < Math.min(w, mx + mw); x++) {
        const i = (y * w + x) * 3;
        const top = y < my + 4;
        const v = top ? 0.32 : 0.16 + ((x - mx) / mw) * 0.06;
        px[i] = v;
        px[i + 1] = v * 0.98;
        px[i + 2] = v * 1.05;
        if (x > mx + mw * 0.4 && x < mx + mw * 0.6 && y > my + mh * 0.3 && y < my + mh * 0.45) {
          px[i] = 1.1;
          px[i + 1] = 0.55;
          px[i + 2] = 0.12;
        }
      }
  }
  // Tone map (Reinhard-ish) and gamma.
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < px.length; i++) {
    const v = px[i] / (1 + px[i] * 0.55);
    out[i] = Math.max(0, Math.min(255, Math.round(Math.pow(Math.min(1, v), 1 / 2.1) * 255)));
  }
  return encodePng(w, h, out);
}

/** A phone photo of the game on a monitor: the scene, a bit rotated in feel via a darker frame. */
export function phoneShot(seed: number): Buffer {
  return spaceScene({ width: 720, height: 1280, seed, beltGlow: 1, bloom: 0.9, hole: { x: 0.5, y: 0.32, r: 0.16 }, tint: [0.25, 0.3, 0.6] });
}
