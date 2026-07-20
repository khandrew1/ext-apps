import type { z } from "zod/v4";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ClientCapabilitiesSchema,
  ContentBlockSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  EmbeddedResourceSchema,
  EmptyResultSchema,
  JSONRPCMessageSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  LoggingMessageNotificationSchema,
  PingRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceLinkSchema,
  ResourceListChangedNotificationSchema,
  ServerCapabilitiesSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/core";

export type CallToolRequest = z.infer<typeof CallToolRequestSchema>;
export type CallToolResult = z.infer<typeof CallToolResultSchema>;
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
export type CreateMessageResult = z.infer<typeof CreateMessageResultSchema>;
export type CreateMessageResultWithTools = z.infer<
  typeof CreateMessageResultWithToolsSchema
>;
export type EmbeddedResource = z.infer<typeof EmbeddedResourceSchema>;
export type EmptyResult = z.infer<typeof EmptyResultSchema>;
export type Implementation = {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  icons?: Array<Record<string, unknown>>;
};
export type JSONRPCMessage = z.infer<typeof JSONRPCMessageSchema>;
export type JSONRPCNotification = z.infer<typeof JSONRPCNotificationSchema>;
export type JSONRPCRequest = z.infer<typeof JSONRPCRequestSchema>;
export type ListPromptsRequest = z.infer<typeof ListPromptsRequestSchema>;
export type ListPromptsResult = z.infer<typeof ListPromptsResultSchema>;
export type ListResourcesRequest = z.infer<typeof ListResourcesRequestSchema>;
export type ListResourcesResult = z.infer<typeof ListResourcesResultSchema>;
export type ListResourceTemplatesRequest = z.infer<
  typeof ListResourceTemplatesRequestSchema
>;
export type ListResourceTemplatesResult = z.infer<
  typeof ListResourceTemplatesResultSchema
>;
export type ListToolsRequest = z.infer<typeof ListToolsRequestSchema>;
export type ListToolsResult = z.infer<typeof ListToolsResultSchema>;
export type LoggingMessageNotification = z.infer<
  typeof LoggingMessageNotificationSchema
>;
export type PingRequest = z.infer<typeof PingRequestSchema>;
export type PromptListChangedNotification = z.infer<
  typeof PromptListChangedNotificationSchema
>;
export type ReadResourceRequest = z.infer<typeof ReadResourceRequestSchema>;
export type ReadResourceResult = z.infer<typeof ReadResourceResultSchema>;
export type RequestId = string | number;
export type ResourceLink = z.infer<typeof ResourceLinkSchema>;
export type ResourceListChangedNotification = z.infer<
  typeof ResourceListChangedNotificationSchema
>;
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, JSONValue>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: { $schema?: string; [key: string]: unknown };
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  icons?: Array<{
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: "light" | "dark";
  }>;
  execution?: { taskSupport?: "forbidden" | "optional" | "required" };
};
export type ToolListChangedNotification = z.infer<
  typeof ToolListChangedNotificationSchema
>;

export type Result = Record<string, unknown>;

export type OutboundRequest = {
  method: string;
  params?: Record<string, unknown>;
};

export type OutboundNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type StandardRequestForMethod<M extends string> = M extends "tools/call"
  ? CallToolRequest
  : M extends "tools/list"
    ? ListToolsRequest
    : M extends "resources/read"
      ? ReadResourceRequest
      : M extends "resources/list"
        ? ListResourcesRequest
        : M extends "resources/templates/list"
          ? ListResourceTemplatesRequest
          : M extends "prompts/list"
            ? ListPromptsRequest
            : M extends "sampling/createMessage"
              ? CreateMessageRequest
              : M extends "ping"
                ? PingRequest
                : OutboundRequest & { method: M };

export type StandardResultForMethod<M extends string> = M extends "tools/call"
  ? CallToolResult
  : M extends "tools/list"
    ? ListToolsResult
    : M extends "resources/read"
      ? ReadResourceResult
      : M extends "resources/list"
        ? ListResourcesResult
        : M extends "resources/templates/list"
          ? ListResourceTemplatesResult
          : M extends "prompts/list"
            ? ListPromptsResult
            : M extends "sampling/createMessage"
              ? CreateMessageResult | CreateMessageResultWithTools
              : EmptyResult;

export type MessageExtraInfo = any;

export type TransportSendOptions = {
  relatedRequestId?: RequestId;
  resumptionToken?: string;
  onresumptiontoken?: (token: string) => void;
};

/** Transport contract used by the iframe protocol. */
export interface Transport {
  start(): Promise<void>;
  send(message: any, options?: any): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any, extra?: any) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

export type RequestOptions = TransportSendOptions & {
  signal?: AbortSignal;
  timeout?: number;
  onprogress?: (progress: unknown) => void;
  resetTimeoutOnProgress?: boolean;
  maxTotalTimeout?: number;
};

export type ProtocolOptions = {
  enforceStrictCapabilities?: boolean;
  debouncedNotificationMethods?: string[];
};

export type ProtocolContext = {
  mcpReq: {
    signal: AbortSignal;
    requestId: RequestId;
  };
  signal: AbortSignal;
  requestId: RequestId;
  sessionId?: string;
};

export type ClientContext = ProtocolContext;
export type ServerContext = ProtocolContext;
export type ClientOptions = ProtocolOptions;
export type ServerOptions = ProtocolOptions;

/** Minimal client surface consumed by AppBridge's optional proxy mode. */
export interface McpClientLike {
  getServerCapabilities(): ServerCapabilities | undefined;
  request(request: any, options?: any): Promise<any>;
  notification?(notification: any, options?: any): Promise<void>;
  setNotificationHandler(
    method: any,
    handler: (notification: any) => void | Promise<void>,
  ): void;
}

export {
  CallToolRequestSchema,
  CallToolResultSchema,
  EmptyResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  LoggingMessageNotificationSchema,
  PingRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
};
