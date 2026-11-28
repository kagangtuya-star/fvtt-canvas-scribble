import type { SimBackend } from "./backend.ts";
import { CpuBackend } from "./cpu.ts";
import { GpuBackend, gpuSelfTest } from "./gpu.ts";

/**
 * Pick the simulation backend. The GPU backend is only used after it passed a
 * self-test against the CPU reference on this device; otherwise the CPU
 * backend runs (same physics, lower throughput).
 */
export function createBackend(pref: "auto" | "cpu" | "gpu"): { backend: SimBackend; note?: string } {
  if (pref === "cpu") return { backend: new CpuBackend() };
  let gpu: (SimBackend & GpuBackend) | null = null;
  try {
    // "auto" skips software rasterisers (slower than the CPU backend); an explicit "gpu" allows them.
    gpu = GpuBackend.create({ allowSoftware: pref === "gpu" });
  } catch (err) {
    return { backend: new CpuBackend(), note: `GPU unavailable: ${(err as Error)?.message ?? err}` };
  }
  if (!gpu) return { backend: new CpuBackend(), note: `GPU unavailable: ${GpuBackend.lastError || "no WebGL2"}` };
  const result = gpuSelfTest(gpu);
  if (!result.ok) {
    gpu.destroy();
    return { backend: new CpuBackend(), note: `GPU self-test failed: ${result.detail}` };
  }
  gpu.clear();
  return { backend: gpu, note: result.detail };
}
