import { Protocol } from "@modelcontextprotocol/core/protocol";
import type {
  BaseContext,
  StandardSchemaV1,
} from "@modelcontextprotocol/core/protocol";

export type ProtocolEventSchemas<EventMap extends Record<string, unknown>> = {
  [K in keyof EventMap]: {
    method: string;
    params: StandardSchemaV1;
  };
};

interface EventSlot<T = unknown> {
  onHandler?: ((params: T) => void) | undefined;
  listeners: ((params: T) => void)[];
}

/**
 * Intermediate base class that adds DOM-style event support on top of the
 * role-neutral MCP SDK `Protocol` engine.
 *
 * Subclasses provide a map from event names to generated v2 notification
 * schemas. The first listener for an event installs one Protocol notification
 * handler, which fans out to the singular `on*` handler and all listeners.
 * Direct handler registration remains double-set protected.
 */
export abstract class ProtocolWithEvents<
  ContextT extends BaseContext,
  EventMap extends Record<string, unknown>,
> extends Protocol<ContextT> {
  private readonly _registeredMethods = new Set<string>();
  private readonly _eventSlots = new Map<keyof EventMap, EventSlot>();

  protected abstract readonly eventSchemas: ProtocolEventSchemas<EventMap>;

  protected onEventDispatch<K extends keyof EventMap>(
    _event: K,
    _params: EventMap[K],
  ): void {}

  private _ensureEventSlot<K extends keyof EventMap>(
    event: K,
  ): EventSlot<EventMap[K]> {
    let slot = this._eventSlots.get(event) as
      EventSlot<EventMap[K]> | undefined;
    if (!slot) {
      const schema = this.eventSchemas[event];
      if (!schema) {
        throw new Error(`Unknown event: ${String(event)}`);
      }

      slot = { listeners: [] };
      this._eventSlots.set(event, slot as EventSlot);

      this._registeredMethods.add(schema.method);
      const stableSlot = slot;
      super.setNotificationHandler(
        schema.method,
        { params: schema.params },
        (params) => {
          const eventParams = params as EventMap[K];
          this.onEventDispatch(event, eventParams);
          stableSlot.onHandler?.(eventParams);
          for (const listener of [...stableSlot.listeners]) {
            listener(eventParams);
          }
        },
      );
    }
    return slot;
  }

  protected setEventHandler<K extends keyof EventMap>(
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

  protected getEventHandler<K extends keyof EventMap>(
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
      EventSlot<EventMap[K]> | undefined;
    if (!slot) return;
    const index = slot.listeners.indexOf(handler);
    if (index !== -1) slot.listeners.splice(index, 1);
  }

  // Arrow fields intentionally initialize after Protocol's constructor. Its
  // built-in ping/cancelled/progress registrations therefore reach the base
  // methods before our duplicate-registration state exists.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override setRequestHandler = (...args: any[]): void => {
    const method = args[0] as string;
    this._assertMethodNotRegistered(method, "setRequestHandler");
    (Protocol.prototype.setRequestHandler as Function).apply(this, args);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override setNotificationHandler = (...args: any[]): void => {
    const method = args[0] as string;
    this._assertMethodNotRegistered(method, "setNotificationHandler");
    (Protocol.prototype.setNotificationHandler as Function).apply(this, args);
  };

  /**
   * Replace a request handler while retaining `on*` replace semantics.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected replaceRequestHandler = (...args: any[]): void => {
    this._registeredMethods.add(args[0] as string);
    (Protocol.prototype.setRequestHandler as Function).apply(this, args);
  };

  protected warnIfRequestHandlerReplaced(
    name: string,
    previous: unknown,
    next: unknown,
  ): void {
    warnIfRequestHandlerReplaced(name, previous, next);
  }

  private _assertMethodNotRegistered(method: string, via: string): void {
    if (this._registeredMethods.has(method)) {
      throw new Error(
        `Handler for "${method}" already registered (via ${via}). ` +
          `Use addEventListener() to attach multiple listeners, ` +
          `or the on* setter for replace semantics.`,
      );
    }
    this._registeredMethods.add(method);
  }
}

export type RequestHandlerExtra = {
  signal: AbortSignal;
  sessionId?: string;
};

export function toRequestHandlerExtra(ctx: {
  sessionId?: string;
  mcpReq: { signal: AbortSignal };
}): RequestHandlerExtra {
  return {
    signal: ctx.mcpReq.signal,
    sessionId: ctx.sessionId,
  };
}

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

export function paramsSchemaOf(schema: unknown): StandardSchemaV1 {
  return (schema as { shape: { params: StandardSchemaV1 } }).shape.params;
}
