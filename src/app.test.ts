import { afterEach, describe, expect, it } from "bun:test";
import {
  InMemoryTransport,
  Server,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { App } from "./app";
import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeRequestSchema,
  McpUiInitializeResultSchema,
  McpUiInitializedNotificationSchema,
} from "./types";

const INNER_MCP_PROTOCOL_VERSION = "2025-11-25";

type ConnectedPair = {
  app: App;
  server: Server;
  sentByApp: JSONRPCMessage[];
  appsInitialized: Promise<void>;
};

async function connectPair(
  app = new App(
    { name: "view-app", version: "1.0.0" },
    { tools: { listChanged: true } },
    { autoResize: false },
  ),
): Promise<ConnectedPair> {
  const server = new Server(
    { name: "inner-mcp-server", version: "0.0.0" },
    {
      capabilities: { resources: {}, tools: {} },
      supportedProtocolVersions: [INNER_MCP_PROTOCOL_VERSION],
    },
  );
  const [appTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sentByApp: JSONRPCMessage[] = [];
  const send = appTransport.send.bind(appTransport);
  appTransport.send = async (message, options) => {
    sentByApp.push(message);
    await send(message, options);
  };

  let resolveAppsInitialized!: () => void;
  const appsInitialized = new Promise<void>((resolve) => {
    resolveAppsInitialized = resolve;
  });

  server.setRequestHandler(
    "ui/initialize",
    {
      params: McpUiInitializeRequestSchema.shape.params,
      result: McpUiInitializeResultSchema,
    },
    (params) => {
      expect(params.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      return {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        hostCapabilities: { openLinks: {} },
        hostInfo: { name: "apps-host", version: "2.0.0" },
        hostContext: { theme: "dark" as const, locale: "en-US" },
      };
    },
  );
  server.setNotificationHandler(
    "ui/notifications/initialized",
    { params: McpUiInitializedNotificationSchema.shape.params },
    () => resolveAppsInitialized(),
  );
  server.setRequestHandler("tools/call", (request) => ({
    content: [{ type: "text", text: `called ${request.params.name}` }],
  }));
  server.setRequestHandler("resources/read", (request) => ({
    contents: [{ uri: request.params.uri, text: "resource body" }],
  }));
  server.setRequestHandler("resources/list", () => ({
    resources: [{ uri: "test://resource", name: "Test resource" }],
  }));
  server.setRequestHandler("sampling/createMessage", () => ({
    model: "test-model",
    role: "assistant",
    content: { type: "text", text: "sampled" },
  }));

  await server.connect(serverTransport);
  await app.connect(appTransport);
  await appsInitialized;

  return { app, server, sentByApp, appsInitialized };
}

const connected: Array<Pick<ConnectedPair, "app" | "server">> = [];

afterEach(async () => {
  await Promise.all(
    connected
      .splice(0)
      .flatMap(({ app, server }) => [app.close(), server.close()]),
  );
});

describe("App base MCP SDK v2 Client migration", () => {
  it("completes the legacy MCP handshake before the authoritative Apps handshake", async () => {
    const pair = await connectPair();
    connected.push(pair);

    const lifecycleMethods = pair.sentByApp
      .filter(
        (message): message is JSONRPCMessage & { method: string } =>
          "method" in message,
      )
      .map((message) => message.method)
      .filter((method) =>
        [
          "initialize",
          "notifications/initialized",
          "ui/initialize",
          "ui/notifications/initialized",
        ].includes(method),
      );

    expect(lifecycleMethods).toEqual([
      "initialize",
      "notifications/initialized",
      "ui/initialize",
      "ui/notifications/initialized",
    ]);
    expect(pair.app.getNegotiatedProtocolVersion()).toBe(
      INNER_MCP_PROTOCOL_VERSION,
    );
  });

  it("uses ui/initialize as the authority for Apps host state", async () => {
    const pair = await connectPair();
    connected.push(pair);

    expect(pair.app.getServerVersion()).toEqual({
      name: "inner-mcp-server",
      version: "0.0.0",
    });
    expect(pair.app.getHostVersion()).toEqual({
      name: "apps-host",
      version: "2.0.0",
    });
    expect(pair.app.getHostCapabilities()).toEqual({ openLinks: {} });
    expect(pair.app.getHostContext()).toEqual({
      theme: "dark",
      locale: "en-US",
    });
  });

  it("preserves registered App tools with the base MCP SDK v2 Client handler context", async () => {
    const pair = await connectPair();
    connected.push(pair);
    let receivedSignal: AbortSignal | undefined;

    pair.app.registerTool(
      "greet",
      { description: "Greets a person" },
      async (extra) => {
        receivedSignal = extra.mcpReq.signal;
        return { content: [{ type: "text", text: "hello" }] };
      },
    );

    const listed = await pair.server.request({
      method: "tools/list",
      params: {},
    });
    const result = await pair.server.request({
      method: "tools/call",
      params: { name: "greet", arguments: {} },
    });

    expect(listed.tools.map((tool) => tool.name)).toEqual(["greet"]);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("uses base MCP SDK v2 method-keyed sends for standard MCP requests", async () => {
    const pair = await connectPair();
    connected.push(pair);

    const toolResult = await pair.app.callServerTool({
      name: "refresh",
      arguments: {},
    });
    const resource = await pair.app.readServerResource({
      uri: "test://resource",
    });
    const resources = await pair.app.listServerResources();
    const sample = await pair.app.createSamplingMessage({
      messages: [{ role: "user", content: { type: "text", text: "hello" } }],
      maxTokens: 20,
    });

    expect(toolResult.content).toEqual([
      { type: "text", text: "called refresh" },
    ]);
    expect(resource.contents[0]).toEqual({
      uri: "test://resource",
      text: "resource body",
    });
    expect(resources.resources.map(({ uri }) => uri)).toEqual([
      "test://resource",
    ]);
    expect(sample.content).toEqual({ type: "text", text: "sampled" });
  });

  it("preserves reconnect behavior after close", async () => {
    const first = await connectPair();
    await first.app.close();
    await first.server.close();

    const second = await connectPair(first.app);
    connected.push(second);

    expect(second.app.getNegotiatedProtocolVersion()).toBe(
      INNER_MCP_PROTOCOL_VERSION,
    );
    expect(second.app.getHostVersion()).toEqual({
      name: "apps-host",
      version: "2.0.0",
    });
  });

  it("preserves auto-resize setup after Apps initialization", async () => {
    const app = new App(
      { name: "view-app", version: "1.0.0" },
      {},
      { autoResize: true },
    );
    let setupCalls = 0;
    app.setupSizeChangedNotifications = () => {
      setupCalls += 1;
      return () => {};
    };

    const pair = await connectPair(app);
    connected.push(pair);

    expect(setupCalls).toBe(1);
  });

  it("preserves strict late-handler timing errors", async () => {
    const app = new App(
      { name: "view-app", version: "1.0.0" },
      {},
      { autoResize: false, strict: true },
    );
    const pair = await connectPair(app);
    connected.push(pair);

    expect(() => {
      app.ontoolinput = () => {};
    }).toThrow(/handler registered after connect/);
  });

  it("uses base MCP SDK replacement semantics for request handlers", async () => {
    const pair = await connectPair();
    connected.push(pair);
    let handledBy = 0;

    pair.app.setRequestHandler("ping", () => {
      handledBy = 1;
      return {};
    });
    pair.app.setRequestHandler("ping", () => {
      handledBy = 2;
      return {};
    });

    await pair.server.request({ method: "ping", params: {} });
    expect(handledBy).toBe(2);
  });

  it("uses base MCP SDK replacement semantics for non-event notifications", async () => {
    const pair = await connectPair();
    connected.push(pair);
    const calls: number[] = [];
    const params = z.object({});

    pair.app.setNotificationHandler("test/notification", { params }, () => {
      calls.push(1);
    });
    pair.app.setNotificationHandler("test/notification", { params }, () => {
      calls.push(2);
    });
    await pair.server.notification({
      method: "test/notification",
      params: {},
    });

    expect(calls).toEqual([2]);
  });
});
