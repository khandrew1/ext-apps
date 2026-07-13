import { describe, it, expect } from "bun:test";
import type { Transport as TransportV2 } from "@modelcontextprotocol/client";

import { PostMessageTransport } from "./message-transport";

/**
 * Compile-time assertion: PostMessageTransport must remain assignable to the
 * v2 SDK `Transport` interface exported from `@modelcontextprotocol/client`.
 * If this line errors under `tsc`, a v1/v2 shape regression was introduced.
 */
const _postMessageTransportIsV2Transport: TransportV2 =
  null as unknown as PostMessageTransport;
void _postMessageTransportIsV2Transport;

describe("PostMessageTransport v2 Transport compat", () => {
  it("exposes the v2-only optional Transport members as unset", () => {
    // Minimal runtime smoke test so this file is not type-only empty.
    // postMessage is a shared channel — hasPerRequestStream stays undefined.
    const transport = new PostMessageTransport(
      { postMessage() {} } as unknown as Window,
      {} as MessageEventSource,
    );

    expect(transport.hasPerRequestStream).toBeUndefined();
    expect(transport.setSupportedProtocolVersions).toBeUndefined();
  });
});
