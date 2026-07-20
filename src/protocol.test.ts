import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod/v4";

import { Protocol, ProtocolError } from "./protocol";

const connected: Protocol[] = [];

async function connectPair(): Promise<[Protocol, Protocol]> {
  const left = new Protocol();
  const right = new Protocol();
  const [leftTransport, rightTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    left.connect(leftTransport),
    right.connect(rightTransport),
  ]);
  connected.push(left, right);
  return [left, right];
}

afterEach(async () => {
  await Promise.all(connected.splice(0).map((protocol) => protocol.close()));
});

describe("Protocol", () => {
  it("correlates JSON-RPC requests and validates custom schemas", async () => {
    const [client, server] = await connectPair();
    server.setRequestHandler(
      "test/double",
      { params: z.object({ value: z.number() }) },
      ({ value }) => ({ value: value * 2 }),
    );

    const result = await client.request(
      { method: "test/double", params: { value: 21 } },
      z.object({ value: z.number() }),
    );

    expect(result).toEqual({ value: 42 });
  });

  it("returns JSON-RPC method and parameter errors", async () => {
    const [client, server] = await connectPair();
    server.setRequestHandler(
      "test/number",
      { params: z.object({ value: z.number() }) },
      () => ({}),
    );

    await expect(
      client.request({ method: "test/missing", params: {} }),
    ).rejects.toMatchObject({ code: -32601 } satisfies Partial<ProtocolError>);
    await expect(
      client.request({ method: "test/number", params: { value: "no" } }),
    ).rejects.toMatchObject({ code: -32602 } satisfies Partial<ProtocolError>);
  });

  it("propagates cancellation to an active request handler", async () => {
    const [client, server] = await connectPair();
    let resolveSignal!: (signal: AbortSignal) => void;
    const receivedSignal = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    server.setRequestHandler("test/wait", async (_request, context) => {
      resolveSignal(context.signal);
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return {};
    });

    const controller = new AbortController();
    const request = client.request(
      { method: "test/wait", params: {} },
      { signal: controller.signal },
    );
    const signal = await receivedSignal;
    controller.abort(new Error("cancelled by test"));

    await expect(request).rejects.toThrow("cancelled by test");
    await Bun.sleep(0);
    expect(signal.aborted).toBe(true);
  });

  it("rejects an already-aborted request without sending it", async () => {
    const [client, server] = await connectPair();
    let handled = false;
    server.setRequestHandler("test/pre-aborted", () => {
      handled = true;
      return {};
    });
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    await expect(
      client.request(
        { method: "test/pre-aborted", params: {} },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("already aborted");
    await Bun.sleep(0);
    expect(handled).toBe(false);
  });

  it("times out requests and rejects pending work when closed", async () => {
    const [client, server] = await connectPair();
    server.setRequestHandler(
      "test/never",
      async () => new Promise<Record<string, never>>(() => {}),
    );

    await expect(
      client.request({ method: "test/never", params: {} }, { timeout: 5 }),
    ).rejects.toThrow("Request timed out");

    const pending = client.request(
      { method: "test/never", params: {} },
      { timeout: 0 },
    );
    await client.close();
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("can reconnect after close and fires onclose once", async () => {
    const protocol = new Protocol();
    connected.push(protocol);
    let closes = 0;
    protocol.onclose = () => closes++;

    const [first] = InMemoryTransport.createLinkedPair();
    await protocol.connect(first);
    await protocol.close();

    const [second] = InMemoryTransport.createLinkedPair();
    await protocol.connect(second);
    await protocol.close();

    expect(closes).toBe(2);
  });
});
