/**
 * Phase 0 gating spike: migrate ext-apps View/Host JSON-RPC off v1 SDK onto
 * v2 `@modelcontextprotocol/client` + `@modelcontextprotocol/server` WITHOUT
 * ever negotiating an MCP protocol version on the view↔host link.
 *
 * Background (v2 Client, packages/client/src/client/client.ts):
 * - `Client.connect()` always runs MCP `initialize` (legacy) or `server/discover`
 *   (auto/pin) unless a reconnect path is taken.
 * - `Client._shouldDropInbound` silently drops ALL inbound requests when
 *   `_negotiatedProtocolVersion` is a modern (2026-07-28) version. If the
 *   negotiated version stays `undefined`, the drop never arms.
 *
 * Strategy under test (public API only — no protected/private overrides):
 * set `transport.sessionId` before `Client.connect()`. Documented in
 * typescript-sdk `docs/migration/upgrade-to-v2.md` ("connect() skips the
 * initialize handshake when the transport already exposes a sessionId").
 *
 * Transport: published `InMemoryTransport` from `@modelcontextprotocol/client`
 * (also re-exported by `@modelcontextprotocol/server`). Additionally exercises
 * ext-apps `PostMessageTransport` with the fake-window harness from
 * `message-transport.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  Client,
  InMemoryTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  captureProtocolVersion,
  createFakeWindow,
  createLinkedPostMessagePair,
} from "./test-transport-harness";

// ---------------------------------------------------------------------------
// Custom method schemas (vendor-prefixed; 3-arg setRequestHandler / request)
// ---------------------------------------------------------------------------

const UiInitializeParams = z.object({
  appInfo: z.object({ name: z.string(), version: z.string() }),
});
const UiInitializeResult = z.object({
  hostCapabilities: z.object({ openLinks: z.boolean().optional() }).optional(),
});

const UiResourceTeardownParams = z.object({
  reason: z.string(),
});
const UiResourceTeardownResult = z.object({
  closed: z.literal(true),
});

// ---------------------------------------------------------------------------
// Subclasses — public API only (no underscore / protected overrides)
// ---------------------------------------------------------------------------

class SpikeAppClient extends Client {
  /** Counts how many times the ui/resource-teardown handler ran. */
  teardownHits = 0;
  pingHits = 0;
  toolsCallHits = 0;

  wireHostFacingHandlers(): void {
    this.setRequestHandler(
      "ui/resource-teardown",
      { params: UiResourceTeardownParams, result: UiResourceTeardownResult },
      async (params) => {
        this.teardownHits += 1;
        expect(params.reason).toBeTruthy();
        return { closed: true as const };
      },
    );

    // Spec method — 2-arg form (no schema bundle).
    this.setRequestHandler("ping", async () => {
      this.pingHits += 1;
      return {};
    });

    // Host also sends tools/call toward the view in production; confirm the
    // Client will accept a handler and answer without MCP initialize.
    this.setRequestHandler("tools/call", async (request) => {
      this.toolsCallHits += 1;
      return {
        content: [
          {
            type: "text" as const,
            text: `called:${String(request.params.name)}`,
          },
        ],
      };
    });
  }
}

class SpikeAppServer extends Server {
  wireViewFacingHandlers(): void {
    this.setRequestHandler(
      "ui/initialize",
      { params: UiInitializeParams, result: UiInitializeResult },
      async (params) => {
        expect(params.appInfo.name).toBeTruthy();
        return { hostCapabilities: { openLinks: true } };
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Public escape hatch: pretends this is a session resume so Client.connect
 * attaches the transport via Protocol.connect and returns WITHOUT running
 * `_legacyHandshake` / `_connectNegotiated`.
 *
 * Source: Client.connect sessionId branch
 * (typescript-sdk packages/client/src/client/client.ts ~941–952).
 */
function skipMcpInitialize(transport: Transport): void {
  transport.sessionId = transport.sessionId ?? "ext-apps-spike-no-mcp-init";
}

async function connectWithoutMcpInitialize(
  client: SpikeAppClient,
  server: SpikeAppServer,
  clientTransport: Transport,
  serverTransport: Transport,
): Promise<{ clientVersions: string[]; serverVersions: string[] }> {
  const clientCapture = captureProtocolVersion(clientTransport);
  const serverCapture = captureProtocolVersion(serverTransport);

  skipMcpInitialize(clientTransport);

  client.wireHostFacingHandlers();
  server.wireViewFacingHandlers();

  // Server.connect is Protocol.connect (Server does not override) — attach only.
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    clientVersions: clientCapture.versions,
    serverVersions: serverCapture.versions,
  };
}

async function assertNoNegotiationRoundTrip(
  client: SpikeAppClient,
  server: SpikeAppServer,
  protocolVersionsSet: string[],
): Promise<void> {
  // Q2: negotiated version / capabilities stay undefined; setProtocolVersion never fired.
  expect(client.getServerCapabilities()).toBeUndefined();
  expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
  expect(server.getClientCapabilities()).toBeUndefined();
  expect(server.getNegotiatedProtocolVersion()).toBeUndefined();
  expect(protocolVersionsSet).toEqual([]);

  // Custom ui/initialize: client → server (replaces MCP initialize for Apps).
  const initResult = await client.request(
    {
      method: "ui/initialize",
      params: { appInfo: { name: "spike-app", version: "0.0.0" } },
    },
    UiInitializeResult,
  );
  expect(initResult).toEqual({ hostCapabilities: { openLinks: true } });

  // Still no MCP negotiation after custom handshake.
  expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
  expect(server.getNegotiatedProtocolVersion()).toBeUndefined();
  expect(protocolVersionsSet).toEqual([]);

  // Server → client custom request must REACH the Client handler.
  const teardown = await server.request(
    {
      method: "ui/resource-teardown",
      params: { reason: "unmount" },
    },
    UiResourceTeardownResult,
  );
  expect(teardown).toEqual({ closed: true });
  expect(client.teardownHits).toBe(1);

  // Server → client ping (spec method).
  const pingResult = await server.ping();
  expect(pingResult).toEqual({});
  expect(client.pingHits).toBe(1);

  // Server → client tools/call (spec method the host proxies in production).
  const toolResult = await server.request({
    method: "tools/call",
    params: { name: "demo", arguments: {} },
  });
  expect(toolResult).toMatchObject({
    content: [{ type: "text", text: "called:demo" }],
  });
  expect(client.toolsCallHits).toBe(1);
}

// ---------------------------------------------------------------------------
// Q1 — Does Client.connect auto-send MCP initialize?
// ---------------------------------------------------------------------------

describe("v2 migration spike — Q1 Client.connect initialize behavior", () => {
  it("auto-sends MCP initialize on a fresh connect (no public skip option on ConnectOptions)", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const outbound: Array<{ method?: string }> = [];
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) => {
      outbound.push(message as { method?: string });
      return originalSend(message, options);
    };

    const client = new Client({ name: "q1-client", version: "1.0.0" });
    const server = new Server(
      { name: "q1-server", version: "1.0.0" },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const methods = outbound.map((m) => m.method).filter(Boolean);
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(client.getNegotiatedProtocolVersion()).toBeDefined();
    expect(client.getServerCapabilities()).toBeDefined();

    // Documented public ConnectOptions / ClientOptions surface (no skipInitialize):
    // - ConnectOptions.prior → adopts DiscoverResult (SETS modern negotiated version)
    // - ClientOptions.versionNegotiation → 'legacy' | 'auto' | { pin } (all handshake)
    // - transport.sessionId already set → reconnect path skips handshake (see next test)
    await client.close();
    await server.close();
  });

  it("skips MCP initialize when transport.sessionId is already set (documented reconnect guard)", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const outbound: Array<{ method?: string }> = [];
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) => {
      outbound.push(message as { method?: string });
      return originalSend(message, options);
    };

    clientTransport.sessionId = "preexisting-session";

    const client = new Client({ name: "q1-skip-client", version: "1.0.0" });
    const server = new Server(
      { name: "q1-skip-server", version: "1.0.0" },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const methods = outbound.map((m) => m.method).filter(Boolean);
    expect(methods).not.toContain("initialize");
    expect(methods).not.toContain("server/discover");
    expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
    expect(client.getServerCapabilities()).toBeUndefined();

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Q2 + Q3 — no-negotiation custom handshake + server→client requests
// ---------------------------------------------------------------------------

describe("v2 migration spike — Q2/Q3 no-negotiation strategy (InMemoryTransport)", () => {
  it("exchanges ui/initialize then delivers server→client ui/resource-teardown + ping without MCP initialize", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new SpikeAppClient({
      name: "spike-view",
      version: "0.0.0",
    });
    const server = new SpikeAppServer(
      { name: "spike-host", version: "0.0.0" },
      { capabilities: {} },
    );

    const { clientVersions, serverVersions } =
      await connectWithoutMcpInitialize(
        client,
        server,
        clientTransport,
        serverTransport,
      );

    await assertNoNegotiationRoundTrip(client, server, [
      ...clientVersions,
      ...serverVersions,
    ]);

    // Q3: Server accepted inbound ui/initialize and sent outbound requests with
    // getClientCapabilities() still undefined — no v1-style "must initialize"
    // gate on Server.request / inbound custom handlers.
    expect(server.getClientCapabilities()).toBeUndefined();

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Same checks over PostMessageTransport (fake-window harness)
// ---------------------------------------------------------------------------

describe("v2 migration spike — PostMessageTransport (fake window)", () => {
  let restoreConsole: () => void;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = createFakeWindow();
    const origDebug = console.debug;
    const origError = console.error;
    console.debug = () => {};
    console.error = () => {};
    restoreConsole = () => {
      console.debug = origDebug;
      console.error = origError;
    };
  });

  afterEach(() => {
    restoreConsole();
    delete (globalThis as { window?: unknown }).window;
  });

  it("same no-negotiation round-trip over PostMessageTransport", async () => {
    const { viewTransport, hostTransport } = createLinkedPostMessagePair();

    const client = new SpikeAppClient({
      name: "spike-view-pm",
      version: "0.0.0",
    });
    const server = new SpikeAppServer(
      { name: "spike-host-pm", version: "0.0.0" },
      { capabilities: {} },
    );

    const { clientVersions, serverVersions } =
      await connectWithoutMcpInitialize(
        client,
        server,
        viewTransport as unknown as Transport,
        hostTransport as unknown as Transport,
      );

    await assertNoNegotiationRoundTrip(client, server, [
      ...clientVersions,
      ...serverVersions,
    ]);

    await client.close();
    await server.close();
  });
});
