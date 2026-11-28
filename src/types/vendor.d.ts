declare module "roughjs/bundled/rough.esm.js" {
  export interface RoughOptions {
    seed?: number;
    roughness?: number;
    bowing?: number;
    stroke?: string;
    strokeWidth?: number;
    fill?: string;
    fillStyle?: "hachure" | "solid" | "zigzag" | "cross-hatch" | "dots" | "dashed" | "zigzag-line";
    fillWeight?: number;
    hachureAngle?: number;
    hachureGap?: number;
    strokeLineDash?: number[];
    curveStepCount?: number;
    disableMultiStroke?: boolean;
    disableMultiStrokeFill?: boolean;
  }

  export interface RoughOp {
    op: "move" | "bcurveTo" | "lineTo";
    data: number[];
  }

  export interface RoughOpSet {
    type: "path" | "fillPath" | "fillSketch";
    ops: RoughOp[];
  }

  export interface RoughDrawable {
    shape: string;
    sets: RoughOpSet[];
    options: RoughOptions;
  }

  export interface RoughGenerator {
    line(x1: number, y1: number, x2: number, y2: number, options?: RoughOptions): RoughDrawable;
    rectangle(x: number, y: number, w: number, h: number, options?: RoughOptions): RoughDrawable;
    ellipse(x: number, y: number, w: number, h: number, options?: RoughOptions): RoughDrawable;
    polygon(points: [number, number][], options?: RoughOptions): RoughDrawable;
    linearPath(points: [number, number][], options?: RoughOptions): RoughDrawable;
    curve(points: [number, number][], options?: RoughOptions): RoughDrawable;
  }

  const rough: {
    generator(config?: { options?: RoughOptions }): RoughGenerator;
  };
  export default rough;
}
