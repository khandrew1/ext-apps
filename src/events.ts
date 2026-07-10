/**
 * DOM-style notification event fan-out and double-set protection for
 * {@link App} / {@link AppBridge}, composed onto v2 Client/Server rather than
 * subclassing Protocol.
 *
 * ### Singular `on*` handler (like `el.onclick`)
 *
 * Assigning replaces the previous handler; assigning `undefined` clears it.
 * `addEventListener` listeners are unaffected.
 *
 * ### Multi-listener (`addEventListener` / `removeEventListener`)
 *
 * Append to a per-event listener array. Listeners fire in insertion order
 * after the singular `on*` handler.
 *
 * ### Dispatch order
 *
 * 1. Optional `onDispatch` side-effects (e.g. merge host context)
 * 2. The singular `on*` handler (if set)
 * 3. All `addEventListener` listeners in insertion order
 *
 * ### Double-set protection
 *
 * {@link MethodClaimRegistry} tracks methods claimed by event registration or
 * internal handlers. App/AppBridge shadow `setRequestHandler` /
 * `setNotificationHandler` to throw when the same method is claimed twice.
 */

import type { StandardSchemaV1 } from "@modelcontextprotocol/client";

/**
 * Request-handler context passed to App/AppBridge `on*` request callbacks.
 *
 * Preserves the v1-era `extra.signal` surface used by hosts and examples.
 * Mapped internally from the v2 handler context (`ctx`).
 */
export type RequestHandlerExtra = {
  signal: AbortSignal;
  sessionId?: string;
};

/**
 * Adapt v2 handler context to the public `extra` shape.
 */
export function toRequestHandlerExtra(ctx: {
  sessionId?: string;
  mcpReq: { signal: AbortSignal };
}): RequestHandlerExtra {
  return {
    signal: ctx.mcpReq.signal,
    sessionId: ctx.sessionId,
  };
}

/**
 * Deep-merge capability objects (replaces v1 `mergeCapabilities`).
 */
export function mergeCapabilities<T extends object>(base: T, additional: T): T {
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(additional)) {
    const existing = result[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key] = mergeCapabilities(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Tracks JSON-RPC methods claimed by event registration or internal handlers
 * so accidental double-registration via `setRequestHandler` /
 * `setNotificationHandler` throws instead of silently replacing.
 */
export class MethodClaimRegistry {
  private readonly _methods = new Set<string>();

  /** Record a claim without throwing (replace / first-register paths). */
  claim(method: string): void {
    this._methods.add(method);
  }

  /** Throw if already claimed, then claim. */
  assertAndClaim(method: string, via: string): void {
    if (this._methods.has(method)) {
      throw new Error(
        `Handler for "${method}" already registered (via ${via}). ` +
          `Use addEventListener() to attach multiple listeners, ` +
          `or the on* setter for replace semantics.`,
      );
    }
    this._methods.add(method);
  }

  has(method: string): boolean {
    return this._methods.has(method);
  }
}

interface EventSlot<T = unknown> {
  onHandler?: ((params: T) => void) | undefined;
  listeners: ((params: T) => void)[];
}

export type EventMethodSchema = {
  method: string;
  params: StandardSchemaV1;
};

/**
 * Registers one v2 notification handler per event method and fans out to
 * `on*` + `addEventListener` listeners.
 */
export class NotificationEventEmitter<
  EventMap extends Record<string, unknown>,
> {
  private readonly _eventSlots = new Map<keyof EventMap, EventSlot>();

  constructor(
    private readonly _eventSchemas: {
      [K in keyof EventMap]: EventMethodSchema;
    },
    /**
     * Called once per event on first use. Must register a v2
     * `setNotificationHandler(method, { params }, handler)` and claim the
     * method in the caller's {@link MethodClaimRegistry}.
     */
    private readonly _registerDispatcher: (
      method: string,
      paramsSchema: StandardSchemaV1,
      dispatch: (params: unknown) => void,
    ) => void,
    private readonly _onDispatch?: <K extends keyof EventMap>(
      event: K,
      params: EventMap[K],
    ) => void,
  ) {}

  private _ensureEventSlot<K extends keyof EventMap>(
    event: K,
  ): EventSlot<EventMap[K]> {
    let slot = this._eventSlots.get(event) as
      | EventSlot<EventMap[K]>
      | undefined;
    if (!slot) {
      const schema = this._eventSchemas[event];
      if (!schema) {
        throw new Error(`Unknown event: ${String(event)}`);
      }
      slot = { listeners: [] };
      this._eventSlots.set(event, slot as EventSlot);

      const s = slot;
      this._registerDispatcher(schema.method, schema.params, (params) => {
        const p = params as EventMap[K];
        this._onDispatch?.(event, p);
        s.onHandler?.(p);
        for (const l of [...s.listeners]) l(p);
      });
    }
    return slot;
  }

  setEventHandler<K extends keyof EventMap>(
    event: K,
    handler: ((params: EventMap[K]) => void) | undefined,
  ): void {
    const slot = this._ensureEventSlot(event);
    if (slot.onHandler && handler) {
      console.warn(
        `[MCP Apps] on${String(event)} handler replaced. ` +
          `Use addEventListener("${String(event)}", …) to add multiple listeners without replacing.`,
      );
    }
    slot.onHandler = handler;
  }

  getEventHandler<K extends keyof EventMap>(
    event: K,
  ): ((params: EventMap[K]) => void) | undefined {
    return (this._eventSlots.get(event) as EventSlot<EventMap[K]> | undefined)
      ?.onHandler;
  }

  addEventListener<K extends keyof EventMap>(
    event: K,
    handler: (params: EventMap[K]) => void,
  ): void {
    this._ensureEventSlot(event).listeners.push(handler);
  }

  removeEventListener<K extends keyof EventMap>(
    event: K,
    handler: (params: EventMap[K]) => void,
  ): void {
    const slot = this._eventSlots.get(event) as
      | EventSlot<EventMap[K]>
      | undefined;
    if (!slot) return;
    const idx = slot.listeners.indexOf(handler);
    if (idx !== -1) slot.listeners.splice(idx, 1);
  }
}

/**
 * Warn if a request-handler `on*` setter is replacing a previously-set
 * handler. Call from each request setter before updating the backing field.
 */
export function warnIfRequestHandlerReplaced(
  name: string,
  previous: unknown,
  next: unknown,
): void {
  if (previous && next) {
    console.warn(
      `[MCP Apps] ${name} handler replaced. ` +
        `Previous handler will no longer be called.`,
    );
  }
}

/**
 * Extract the `params` Zod schema from a generated `{ method, params }` schema.
 */
export function paramsSchemaOf<
  S extends { shape: { params: StandardSchemaV1 } },
>(schema: S): S["shape"]["params"] {
  return schema.shape.params;
}

/**
 * Extract the literal method string from a generated `{ method, params }` schema.
 */
export function methodOf<
  S extends { shape: { method: { value?: string; values?: Set<string> } } },
>(schema: S): string {
  const method = schema.shape.method;
  if (typeof method.value === "string") return method.value;
  if (method.values && method.values.size > 0) {
    return method.values.values().next().value as string;
  }
  throw new Error("Could not extract method literal from schema");
}
