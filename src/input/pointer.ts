import type { Modifiers } from "../brush/shapes.ts";
import type { Session } from "../session.ts";
import type { ClientSample } from "../tools/gestures.ts";

/**
 * Pointer capture on the game board.
 *
 * Listeners run in the window's capture phase, before PIXI and Foundry see
 * the event. Only the primary button (left mouse, pen tip, one finger) is
 * taken, and only while CanvasScribble is active or a hold key is down: the
 * right/middle buttons keep panning the canvas, and clicks on HTML UI are
 * never touched. High-frequency input comes from `getCoalescedEvents()`.
 *
 * Palm rejection: once a pen has been used, touch input is left to Foundry
 * (panning/zooming) instead of drawing.
 */
export class PointerInput {
  readonly #session: Session;
  readonly #board: () => HTMLElement | null;
  readonly #enabled: () => boolean;
  #active: number | null = null;
  #penSeen = false;
  #touches = new Set<number>();
  #last: ClientSample | null = null;
  /** Latest pointer position over the board (cursor preview). */
  onPointer: ((cx: number, cy: number, over: boolean, pointerType: string) => void) | null = null;
  readonly #handlers: [string, EventListener, AddEventListenerOptions][];

  constructor(session: Session, board: () => HTMLElement | null, enabled: () => boolean) {
    this.#session = session;
    this.#board = board;
    this.#enabled = enabled;
    this.#handlers = [
      ["pointerdown", (e) => this.#down(e as PointerEvent), { capture: true }],
      ["pointermove", (e) => this.#move(e as PointerEvent), { capture: true }],
      ["pointerup", (e) => this.#up(e as PointerEvent), { capture: true }],
      ["pointercancel", (e) => this.#cancel(e as PointerEvent), { capture: true }],
      [
        "dblclick",
        (e) => {
          const event = e as MouseEvent;
          if (
            !this.#onBoard(event) ||
            !this.#enabled() ||
            event.button !== 0 ||
            this.#session.effective().tool !== "select"
          )
            return;
          if (
            this.#session.editTextAt({
              cx: event.clientX,
              cy: event.clientY,
              time: event.timeStamp,
              pressure: 0.5,
              pointerType: "mouse",
            })
          )
            this.#swallow(event);
        },
        { capture: true },
      ],
      ["wheel", (e) => this.#wheel(e as WheelEvent), { capture: true, passive: false }],
      ["contextmenu", (e) => this.#context(e as MouseEvent), { capture: true }],
      ["blur", () => this.#abort(), {}],
    ];
    for (const [type, fn, opts] of this.#handlers) window.addEventListener(type, fn, opts);
  }

  get busy(): boolean {
    return this.#active !== null;
  }

  #onBoard(e: Event): boolean {
    const board = this.#board();
    return !!board && e.target === board;
  }

  static sample(e: PointerEvent): ClientSample {
    // Mice report 0.5 while a button is down (0 when hovering); pens report real pressure, tilt & twist.
    return {
      cx: e.clientX,
      cy: e.clientY,
      time: e.timeStamp,
      pressure: e.pressure,
      pointerType: e.pointerType || "mouse",
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      twist: e.twist,
    };
  }

  static mods(e: MouseEvent | KeyboardEvent): Modifiers {
    return { shift: e.shiftKey, alt: e.altKey };
  }

  #swallow(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  #down(e: PointerEvent): void {
    if (e.pointerType === "touch") this.#touches.add(e.pointerId);
    if (!this.#onBoard(e) || !this.#enabled()) return;
    if (e.pointerType === "pen") this.#penSeen = true;
    // A second finger: the user is pinching or panning. Give the gesture back to Foundry.
    if (e.pointerType === "touch" && this.#touches.size > 1) {
      if (this.#active !== null) {
        this.#session.cancelGesture();
        this.#active = null;
      }
      return;
    }
    if (e.pointerType === "touch" && this.#penSeen) return;
    if (this.#active !== null && this.#active !== e.pointerId) return;
    // Pen eraser end (button 5) acts as an eraser stroke.
    if (e.button !== 0 && !(e.pointerType === "pen" && e.button === 5)) return;
    const s = PointerInput.sample(e);
    const prevHold = this.#session.hold;
    if (e.pointerType === "pen" && e.button === 5) this.#session.hold = "eraser";
    const started = this.#session.pointerDown(s, PointerInput.mods(e));
    if (e.pointerType === "pen" && e.button === 5 && !started) this.#session.hold = prevHold;
    if (!started) return;
    this.#swallow(e);
    this.#active = e.pointerId;
    this.#last = s;
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an optimisation */
    }
  }

  #move(e: PointerEvent): void {
    const over = this.#onBoard(e);
    if (this.#active === null) {
      this.onPointer?.(e.clientX, e.clientY, over && this.#enabled(), e.pointerType);
      if (over && this.#enabled() && this.#session.drawing)
        this.#session.pointerHover(PointerInput.sample(e), PointerInput.mods(e));
      return;
    }
    if (e.pointerId !== this.#active) return;
    this.#swallow(e);
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples = (events.length ? events : [e]).map((ev) => PointerInput.sample(ev));
    this.#last = samples.at(-1) ?? this.#last;
    this.#session.pointerMove(samples, PointerInput.mods(e));
    this.onPointer?.(e.clientX, e.clientY, true, e.pointerType);
  }

  #up(e: PointerEvent): void {
    if (e.pointerType === "touch") this.#touches.delete(e.pointerId);
    if (this.#active === null || e.pointerId !== this.#active) return;
    this.#swallow(e);
    this.#active = null;
    const s = PointerInput.sample(e);
    this.#session.pointerUp(s, PointerInput.mods(e));
    if (this.#session.hold === "eraser" && e.pointerType === "pen" && e.button === 5) this.#session.hold = null;
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  #cancel(e: PointerEvent): void {
    if (e.pointerType === "touch") this.#touches.delete(e.pointerId);
    if (this.#active === null || e.pointerId !== this.#active) return;
    this.#active = null;
    this.#session.cancelGesture();
  }

  /** Lost focus mid-stroke (alt-tab): finish the stroke where it was rather than dropping it. */
  #abort(): void {
    if (this.#active === null) return;
    this.#active = null;
    if (this.#last) this.#session.pointerUp(this.#last, { shift: false, alt: false });
    else this.#session.cancelGesture();
  }

  #wheel(e: WheelEvent): void {
    if (!this.#onBoard(e) || !this.#enabled() || e.ctrlKey || e.metaKey) return;
    if (e.shiftKey && !e.altKey) {
      this.#swallow(e);
      const delta = e.deltaY || e.deltaX;
      if (delta) this.#session.nudgeSize(delta < 0 ? 1 : -1);
      return;
    }
    if (e.altKey) {
      this.#swallow(e);
      const delta = e.deltaY || e.deltaX;
      if (delta) this.#session.nudgeAngle(delta < 0 ? 1 : -1, e.shiftKey ? 5 : 15);
    }
  }

  /** Right-click while placing a polygon finishes it (instead of opening a context menu). */
  #context(e: MouseEvent): void {
    if (!this.#onBoard(e) || !this.#session.drawing || this.#active !== null) return;
    if (this.#session.finishGesture()) this.#swallow(e);
  }

  destroy(): void {
    for (const [type, fn, opts] of this.#handlers) window.removeEventListener(type, fn, opts);
  }
}
