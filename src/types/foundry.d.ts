/**
 * Narrow ambient declarations for the parts of Foundry VTT v13/v14 and PIXI v7
 * that CanvasScribble touches. Keeping them small documents the exact API
 * surface the module depends on (see docs/COMPATIBILITY.md). Members that
 * differ between versions or may be absent during the canvas lifecycle are
 * optional.
 */

declare namespace PIXI {
  class Matrix {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
    apply<P extends { x: number; y: number }>(pos: { x: number; y: number }, newPos?: P): P;
    applyInverse<P extends { x: number; y: number }>(pos: { x: number; y: number }, newPos?: P): P;
  }
  class ObservablePoint {
    x: number;
    y: number;
    set(x: number, y?: number): void;
  }
  class Rectangle {
    constructor(x?: number, y?: number, width?: number, height?: number);
    x: number;
    y: number;
    width: number;
    height: number;
  }
  class BaseTexture {
    constructor(resource?: unknown, options?: Record<string, unknown>);
    resource: unknown;
    valid: boolean;
    width: number;
    height: number;
    update(): void;
    setSize(width: number, height: number, resolution?: number): this;
    destroy(): void;
  }
  class Texture {
    constructor(baseTexture: BaseTexture, frame?: Rectangle);
    static EMPTY: Texture;
    baseTexture: BaseTexture;
    frame: Rectangle;
    width: number;
    height: number;
    destroyed?: boolean;
    updateUvs(): void;
    destroy(destroyBase?: boolean): void;
  }
  class DisplayObject {
    position: ObservablePoint;
    scale: ObservablePoint;
    visible: boolean;
    renderable: boolean;
    destroyed: boolean;
    alpha: number;
    zIndex: number;
    eventMode: string;
    name: string | null;
    parent: Container | null;
    worldTransform: Matrix;
    destroy(options?: unknown): void;
  }
  class Container extends DisplayObject {
    children: DisplayObject[];
    sortableChildren: boolean;
    interactiveChildren: boolean;
    addChild<T extends DisplayObject>(child: T): T;
    removeChild<T extends DisplayObject>(child: T): T;
    removeChildren(): DisplayObject[];
    sortChildren(): void;
  }
  class Sprite extends Container {
    constructor(texture?: Texture);
    texture: Texture;
    width: number;
    height: number;
  }
  class Graphics extends Container {
    clear(): this;
    lineStyle(options: {
      width: number;
      color: number;
      alpha?: number;
      cap?: string;
      join?: string;
      alignment?: number;
    }): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    beginFill(color: number, alpha?: number): this;
    endFill(): this;
    drawCircle(x: number, y: number, r: number): this;
  }
  const LINE_CAP: { ROUND: string; BUTT: string };
  const LINE_JOIN: { ROUND: string };
  interface Renderer {
    resolution: number;
    screen: Rectangle;
  }
  class Ticker {
    add(fn: (dt: number) => void, context?: unknown, priority?: number): this;
    remove(fn: (dt: number) => void, context?: unknown): this;
  }
  const UPDATE_PRIORITY: { HIGH: number; NORMAL: number; LOW: number; UTILITY: number };
}

interface FoundryColor {
  css?: string;
  toString(): string;
}

interface FoundryUser {
  id: string;
  name: string;
  isGM: boolean;
  active: boolean;
  role: number;
  color: FoundryColor | string;
  isSelf?: boolean;
}

interface FoundryScene {
  id: string;
  name: string;
  flags: Record<string, Record<string, unknown> | undefined>;
  getFlag(scope: string, key: string): unknown;
  update(data: object, options?: object): Promise<unknown>;
  canUserModify(user: FoundryUser, action: "update"): boolean;
}

interface CanvasDimensions {
  size: number;
  sceneX: number;
  sceneY: number;
  sceneWidth: number;
  sceneHeight: number;
  width: number;
  height: number;
  rect: PIXI.Rectangle;
  scale?: { min: number; max: number; default?: number };
}

interface FoundryInteractionLayer extends PIXI.Container {
  readonly active: boolean;
  options: { name: string; zIndex?: number };
  activate(options?: { tool?: string }): FoundryInteractionLayer;
  deactivate(): FoundryInteractionLayer;
}

interface FoundryCanvas {
  ready: boolean;
  scene: FoundryScene | null;
  app: { renderer: PIXI.Renderer; ticker: PIXI.Ticker; view: HTMLCanvasElement };
  stage: PIXI.Container & { pivot: PIXI.ObservablePoint; scale: PIXI.ObservablePoint };
  dimensions: CanvasDimensions;
  primary: PIXI.Container & { sortDirty?: boolean };
  interface: PIXI.Container;
  overlay: PIXI.Container;
  activeLayer: FoundryInteractionLayer | null;
  screenDimensions: [number, number];
  /** v14: the viewed Level, or null. */
  level?: { id: string } | null;
  canvasCoordinatesFromClient(point: { x: number; y: number }): { x: number; y: number };
  clientCoordinatesFromCanvas(point: { x: number; y: number }): { x: number; y: number };
  [layer: string]: unknown;
}

interface FoundryNotifications {
  info(message: string, options?: object): unknown;
  warn(message: string, options?: object): unknown;
  error(message: string, options?: object): unknown;
}

interface FoundrySettingConfig {
  name?: string;
  hint?: string;
  scope: "world" | "client" | "user";
  config: boolean;
  type: unknown;
  default: unknown;
  choices?: Record<string | number, string>;
  range?: { min: number; max: number; step: number };
  restricted?: boolean;
  requiresReload?: boolean;
  onChange?: (value: unknown) => void;
}

interface KeyboardEventContext {
  key: string;
  event: KeyboardEvent;
  isShift: boolean;
  isControl: boolean;
  isAlt: boolean;
  up: boolean;
  repeat: boolean;
}

interface FoundryGame {
  ready: boolean;
  user: FoundryUser;
  userId: string;
  users: Iterable<FoundryUser> & {
    get(id: string): FoundryUser | undefined;
    activeGM?: FoundryUser | null;
    contents?: FoundryUser[];
  };
  release: { generation: number; build?: number };
  version: string;
  time: { serverTime: number };
  i18n: {
    lang: string;
    localize(key: string): string;
    format(key: string, data?: Record<string, unknown>): string;
    has(key: string): boolean;
  };
  settings: {
    register(module: string, key: string, config: FoundrySettingConfig): void;
    get(module: string, key: string): unknown;
    set(module: string, key: string, value: unknown): Promise<unknown>;
  };
  keybindings: {
    register(
      module: string,
      key: string,
      config: {
        name: string;
        hint?: string;
        editable?: { key: string; modifiers?: string[] }[];
        onDown?: (context: KeyboardEventContext) => boolean | void;
        onUp?: (context: KeyboardEventContext) => boolean | void;
        restricted?: boolean;
        repeat?: boolean;
        precedence?: number;
      },
    ): void;
  };
  socket: {
    on(event: string, fn: (...args: any[]) => void): void;
    off?(event: string, fn: (...args: any[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
    connected?: boolean;
  };
  modules: { get(id: string): { api?: unknown; version?: string; active?: boolean } | undefined };
  scenes?: { get(id: string): FoundryScene | undefined };
}

interface FoundryHooks {
  on(hook: string, fn: (...args: any[]) => unknown): number;
  once(hook: string, fn: (...args: any[]) => unknown): number;
  off(hook: string, idOrFn: number | ((...args: any[]) => unknown)): void;
  callAll(hook: string, ...args: unknown[]): boolean;
}

interface DialogV2Static {
  confirm(options: {
    window?: { title?: string; icon?: string };
    content?: string;
    rejectClose?: boolean;
    modal?: boolean;
    yes?: { label?: string; icon?: string; default?: boolean };
    no?: { label?: string; icon?: string; default?: boolean };
  }): Promise<boolean | null>;
}

interface InteractionLayerClass {
  new (): FoundryInteractionLayer;
  readonly layerOptions: { name: string; zIndex: number };
}

declare const game: FoundryGame;
declare const canvas: FoundryCanvas;
declare const ui: {
  notifications: FoundryNotifications;
  controls?: {
    control?: { name: string } | null;
    tool?: { name: string } | null;
    render(options?: object): unknown;
    activate?(options: object): unknown;
  };
};
declare const Hooks: FoundryHooks;
declare const CONFIG: {
  Canvas: { layers: Record<string, { layerClass: unknown; group: string }> };
};
declare const CONST: {
  USER_ROLES: { NONE: number; PLAYER: number; TRUSTED: number; ASSISTANT: number; GAMEMASTER: number };
  KEYBINDING_PRECEDENCE: { PRIORITY: number; NORMAL: number; DEFERRED: number };
};
declare const foundry: {
  utils: {
    debounce<F extends (...args: any[]) => void>(fn: F, delay: number): F;
    escapeHTML?(text: string): string;
  };
  canvas: { layers: { InteractionLayer: InteractionLayerClass } };
  applications: { api: { DialogV2: DialogV2Static } };
};
