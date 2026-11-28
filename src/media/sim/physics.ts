/**
 * Physics constants of one simulation step (STEP_MS of real time). Shared by
 * the CPU reference backend and the GLSL backend, which must implement the
 * same equations (see `cpu.ts` for the reference formulation).
 */
export const PHYS = {
  /** Pipe model: flux gain per unit of pressure difference (≤ 0.25 for stability). */
  flowGain: 0.2,
  /** Pipe model: flux kept from the previous step (inertia). */
  flowDamping: 0.88,
  /** Extra head needed to push water onto a dry cell (surface tension keeps wash edges). */
  tension: 0.035,
  /** Suspended pigment / water ratio that halves the flow (thick paint does not run). */
  viscosity: 2,
  /** Capillary flow needs at least this saturation on the wetter side. */
  capillaryMin: 0.03,
  /** Upper bound of a capillary conductance (explicit diffusion stability). */
  capillaryMax: 0.24,
  /** Most suspended pigment that capillary flow carries out of a cell per step. */
  carryMax: 0.5,
  /** Surface water evaporated per step (× drying speed × paper evaporation). */
  evaporate: 0.002,
  /** Evaporation boost at the edge of a wet area (drives edge darkening). */
  edgeBoost: 3,
  /** Capillary water evaporated per step once the surface is dry. */
  evaporateCapillary: 0.0015,
  /** Oil medium drying per step. */
  evaporateOil: 0.0002,
  /** Base settling rate of suspended pigment while wet. */
  settle: 0.01,
  /** Settling once the cell has dried out. */
  settleDry: 0.3,
  /** Passive re-wetting lift of non-staining deposited pigment. */
  rewetLift: 0.002,
  /** Wet sheen: wet paint looks darker. */
  wetDarken: 0.22,
} as const;

/** Seconds of wetness a chunk keeps after the last dab (before × drying speed). */
export const WET_SECONDS = { water: 45, oil: 260 } as const;
