/**
 * Shared test harness for view↔host transport pairs.
 *
 * Used by the v2 migration spike and Phase 3 invariant regression tests.
 * Prefer {@link createLinkedPostMessagePair} when exercising production
 * PostMessageTransport wiring; fall back to InMemoryTransport for speed.
 */
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

import { PostMessageTransport } from "./message-transport";

export type Listener = (event: MessageEvent) => void;

/** Minimal `window` stub for bun's DOM-less test environment. */
export function createFakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: unknown) {
      listeners.get(type)?.forEach((l) => l(event as MessageEvent));
    },
  };
}

/**
 * Two PostMessageTransports sharing one fake `window`, cross-wired so each
 * side's postMessage arrives as a MessageEvent with the peer as `source`.
 */
export function createLinkedPostMessagePair(): {
  viewTransport: PostMessageTransport;
  hostTransport: PostMessageTransport;
} {
  const viewWindow = { id: "view" };
  const hostWindow = { id: "host" };

  const hostAsTarget = {
    postMessage(data: unknown) {
      (
        globalThis as unknown as { window: ReturnType<typeof createFakeWindow> }
      ).window.dispatch("message", { source: viewWindow, data });
    },
  };
  const viewAsTarget = {
    postMessage(data: unknown) {
      (
        globalThis as unknown as { window: ReturnType<typeof createFakeWindow> }
      ).window.dispatch("message", { source: hostWindow, data });
    },
  };

  const viewTransport = new PostMessageTransport(
    hostAsTarget as unknown as Window,
    hostWindow as unknown as MessageEventSource,
  );
  const hostTransport = new PostMessageTransport(
    viewAsTarget as unknown as Window,
    viewWindow as unknown as MessageEventSource,
  );

  return { viewTransport, hostTransport };
}

export type ProtocolVersionCapture = {
  versions: string[];
};

/** Spy `transport.setProtocolVersion` and record every call. */
export function captureProtocolVersion(
  transport: Transport,
): ProtocolVersionCapture {
  const versions: string[] = [];
  const previous = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    versions.push(version);
    previous?.(version);
  };
  return { versions };
}

export type WireCapture = {
  messages: JSONRPCMessage[];
  methods: () => Array<string | undefined>;
};

/** Spy `transport.send` and record every outbound JSON-RPC message. */
export function captureWire(transport: Transport): WireCapture {
  const messages: JSONRPCMessage[] = [];
  const previous = transport.send.bind(transport);
  transport.send = async (message, options) => {
    messages.push(message);
    return previous(message, options);
  };
  return {
    messages,
    methods: () =>
      messages
        .map((m) =>
          "method" in m ? (m.method as string | undefined) : undefined,
        )
        .filter((m): m is string => typeof m === "string"),
  };
}
