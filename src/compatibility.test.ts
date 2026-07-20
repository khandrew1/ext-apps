import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";

import type { McpClientLike } from "./mcp-types";
import type { McpServerLike } from "./server";

type Assert<T extends true> = T;
type _OfficialClientIsCompatible = Assert<
  Client extends McpClientLike ? true : false
>;
type _OfficialServerIsCompatible = Assert<
  McpServer extends McpServerLike ? true : false
>;

describe("official v2 structural compatibility", () => {
  it("accepts official client and server classes without role-package exports", () => {
    expect(true).toBe(true);
  });
});
