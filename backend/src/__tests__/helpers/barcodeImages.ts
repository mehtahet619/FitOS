import bwipjs from "bwip-js";
import { PNG } from "pngjs";

export type Frame = { data: Uint8ClampedArray; width: number; height: number };
// Renders a real barcode with bwip-js, then composes it onto a camera-sized noisy background.
export async function barcodeFrame(bcid: string, text: string, opts: { scale?: number; rotate?: "N" | "R" | "L"; width?: number; height?: number; noise?: number } = {}): Promise<Frame> {
  const png = await bwipjs.toBuffer({ bcid, text, scale: opts.scale ?? 3, height: 14, includetext: false, paddingwidth: 12, paddingheight: 8, backgroundcolor: "FFFFFF", rotate: opts.rotate ?? "N" });
  const bar = PNG.sync.read(png);
  const W = opts.width ?? 640, H = opts.height ?? 480;
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < W * H; i++) { const v = 205 + Math.floor(rnd() * (opts.noise ?? 20)); data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v - 4; data[i * 4 + 3] = 255; }
  const ox = Math.floor((W - bar.width) / 2), oy = Math.floor((H - bar.height) / 2);
  for (let y = 0; y < bar.height; y++) for (let x = 0; x < bar.width; x++) {
    const s = (y * bar.width + x) * 4, d = ((oy + y) * W + ox + x) * 4;
    if (ox + x < 0 || ox + x >= W || oy + y < 0 || oy + y >= H) continue;
    data[d] = bar.data[s]; data[d + 1] = bar.data[s + 1]; data[d + 2] = bar.data[s + 2];
  }
  return { data, width: W, height: H };
}
export function blankFrame(W = 640, H = 480): Frame {
  const data = new Uint8ClampedArray(W * H * 4).fill(200);
  return { data, width: W, height: H };
}
