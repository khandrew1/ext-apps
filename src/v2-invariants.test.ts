/**
 * Phase 3 regression guards for the v2 SDK migration.
 *
 * Load-bearing invariant: the view↔host iframe link must NEVER negotiate an
 * MCP protocol version. App and AppBridge extend the role-neutral Protocol,
 * whose connect() only wires the transport; ui/initialize remains the sole
 * handshake on this channel.
 *
 * Coverage note (vs src/app-bridge.test.ts):
 * - Teardown round-trips, bridge→app ping, registerTool/listTools/callTool,
 *   and createSamplingMessage are already covered there — not duplicated here.
 * - This file focuses on the no-negotiation CI guard, the missing app→bridge
 *   ping direction, App→bridge tools/list_changed, and the modern-era drop
 *   canary (bare Client, not App).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  Client,
  InMemoryTransport,
  type DiscoverResult,
  type Transport,
} from "@modelcontextprotocol/client";

import { App } from "./app";
import { AppBridge, type McpUiHostCapabilities } from "./app-bridge";
import {
  captureProtocolVersion,
  captureWire,
  createFakeWindow,
  createLinkedPostMessagePair,
} from "./test-transport-harness";

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const testHostInfo = { name: "InvariantHost", version: "1.0.0" };
const testAppInfo = { name: "InvariantApp", version: "1.0.0" };
const testHostCapabilities: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  logging: {},
};

/** Modern protocol revision that arms Client._shouldDropInbound. */
const MODERN_PROTOCOL_VERSION = "2026-07-28";

function modernPrior(): DiscoverResult {
  return {
    supportedVersions: [MODERN_PROTOCOL_VERSION],
    capabilities: {},
    serverInfo: { name: "canary-server", version: "1.0.0" },
  };
}

// ---------------------------------------------------------------------------
// 1. No-negotiation invariant (CI guard) — real App + AppBridge
// ---------------------------------------------------------------------------

describe("v2 invariants — no MCP negotiation on App↔AppBridge", () => {
  let restoreConsole: () => void;
  let app: App;
  let bridge: AppBridge;
  let viewTransport: Transport;
  let hostTransport: Transport;
  let viewWire: ReturnType<typeof captureWire>;
  let hostWire: ReturnType<typeof captureWire>;
  let viewVersions: string[];
  let hostVersions: string[];

  beforeEach(async () => {
    (globalThis as { window?: unknown }).window = createFakeWindow();
    const origDebug = console.debug;
    const origError = console.error;
    console.debug = () => {};
    console.error = () => {};
    restoreConsole = () => {
      console.debug = origDebug;
      console.error = origError;
    };

    const pair = createLinkedPostMessagePair();
    viewTransport = pair.viewTransport as unknown as Transport;
    hostTransport = pair.hostTransport as unknown as Transport;

    viewWire = captureWire(viewTransport);
    hostWire = captureWire(hostTransport);
    viewVersions = captureProtocolVersion(viewTransport).versions;
    hostVersions = captureProtocolVersion(hostTransport).versions;

    app = new App(
      testAppInfo,
      { tools: { listChanged: true } },
      { autoResize: false },
    );
    bridge = new AppBridge(null, testHostInfo, testHostCapabilities);

    await bridge.connect(hostTransport);
    await app.connect(viewTransport);
  });

  afterEach(async () => {
    await app.close().catch(() => {});
    await bridge.close().catch(() => {});
    restoreConsole();
    delete (globalThis as { window?: unknown }).window;
  });

  it("negotiates only UI capabilities after ui/initialize", () => {
    expect(app.getHostCapabilities()).toEqual(testHostCapabilities);
    expect(bridge.getAppCapabilities()).toEqual({
      tools: { listChanged: true },
    });
  });

  it("never sends MCP initialize or notifications/initialized on the wire", () => {
    const methods = [...viewWire.methods(), ...hostWire.methods()];

    expect(methods).toContain("ui/initialize");
    expect(methods).toContain("ui/notifications/initialized");
    expect(methods).not.toContain("initialize");
    expect(methods).not.toContain("notifications/initialized");
    expect(methods).not.toContain("server/discover");
  });

  it("never calls transport.setProtocolVersion", () => {
    expect(viewVersions).toEqual([]);
    expect(hostVersions).toEqual([]);
  });

  it("still delivers host→view tools/call (drop hazard not armed)", async () => {
    app.registerTool("echo", {}, async () => ({
      content: [{ type: "text" as const, text: "pong-tool" }],
    }));

    const list = await bridge.listTools({});
    expect(list.tools.map((t) => t.name)).toContain("echo");

    const result = await bridge.callTool({ name: "echo", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "pong-tool" }]);
  });
});

// ---------------------------------------------------------------------------
// Gaps vs app-bridge.test.ts: app→bridge ping + App→bridge list_changed
// ---------------------------------------------------------------------------

describe("v2 invariants — coverage gaps (App↔AppBridge)", () => {
  let app: App;
  let bridge: AppBridge;
  let appTransport: InMemoryTransport;
  let bridgeTransport: InMemoryTransport;

  beforeEach(async () => {
    [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
    app = new App(
      testAppInfo,
      { tools: { listChanged: true } },
      { autoResize: false },
    );
    bridge = new AppBridge(null, testHostInfo, testHostCapabilities);
    await bridge.connect(bridgeTransport);
    await app.connect(appTransport);
  });

  afterEach(async () => {
    await appTransport.close();
    await bridgeTransport.close();
  });

  it("app.ping() round-trips to the bridge (app→bridge direction)", async () => {
    // bridge→app ping is covered in app-bridge.test.ts; this is the reverse.
    const result = await app.ping();
    expect(result).toEqual({});
  });

  it("notifications/tools/list_changed from App reaches the bridge", async () => {
    let listChangedHits = 0;
    bridge.setNotificationHandler("notifications/tools/list_changed", () => {
      listChangedHits += 1;
    });

    const tool = app.registerTool("changing", {}, async () => ({
      content: [],
    }));
    await flush();
    // registerTool notifies when already initialized.
    expect(listChangedHits).toBeGreaterThanOrEqual(1);

    const afterRegister = listChangedHits;
    tool.disable();
    await flush();
    expect(listChangedHits).toBeGreaterThan(afterRegister);
  });
});

// ---------------------------------------------------------------------------
// 6. Drop-hazard canary — documents the danger App.connect() avoids
// ---------------------------------------------------------------------------

describe("v2 invariants — modern-era inbound drop canary", () => {
  it("connect({ prior }) modern era drops inbound requests (onerror)", async () => {
    // Public API only: ConnectOptions.prior adopts a DiscoverResult and sets
    // _negotiatedProtocolVersion to a modern revision without poking privates.
    // Against a live v2 Server, versionNegotiation:'auto' also works, but
    // prior is the zero-round-trip public path that deterministically arms
    // the drop (see typescript-sdk modernEraInboundDrop.test.ts).
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "drop-canary", version: "1.0.0" });
    const errors: Error[] = [];
    client.onerror = (error) => {
      errors.push(error);
    };

    await client.connect(clientTx, { prior: modernPrior() });
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);

    // Misbehaving "modern" peer sends a server→client request. The channel
    // is deleted in the 2026 era — Client must drop it, not answer.
    await serverTx.send({
      jsonrpc: "2.0",
      id: "rogue-1",
      method: "ping",
      params: {},
    });
    await flush();

    expect(
      errors.some((e) => e.message.includes("Dropped inbound request")),
    ).toBe(true);

    await client.close();
  });
});
