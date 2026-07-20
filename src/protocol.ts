import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { z } from "zod/v4";
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  MessageExtraInfo,
  OutboundNotification,
  OutboundRequest,
  ProtocolContext,
  ProtocolOptions,
  RequestId,
  RequestOptions,
  Result,
  StandardRequestForMethod,
  StandardResultForMethod,
  Transport,
} from "./mcp-types";

const DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Schema<T = unknown> = {
  parseAsync?: (value: unknown) => Promise<T>;
  parse?: (value: unknown) => T;
};

type RequestHandler = (
  requestOrParams: unknown,
  context: ProtocolContext,
) => Result | Promise<Result>;
type NotificationHandler = (
  notificationOrParams: unknown,
) => void | Promise<void>;

type HandlerEntry = {
  handler: RequestHandler;
  paramsSchema?: Schema;
};

type NotificationEntry = {
  handler: NotificationHandler;
  paramsSchema?: Schema;
};

type PendingRequest = {
  resolve: (value: Result) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  resultSchema?: Schema<Result>;
};

export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * Protocol-neutral JSON-RPC lifecycle used only for the iframe Apps channel.
 * It deliberately does not perform MCP Client/Server role negotiation.
 */
export class Protocol {
  private _transport?: Transport;
  private _closed = true;
  private _requestId = 0;
  private readonly _requests = new Map<RequestId, PendingRequest>();
  private readonly _requestHandlers = new Map<string, HandlerEntry>();
  private readonly _notificationHandlers = new Map<string, NotificationEntry>();
  private readonly _inboundControllers = new Map<RequestId, AbortController>();

  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(protected readonly protocolOptions: ProtocolOptions = {}) {}

  get transport(): Transport | undefined {
    return this._transport;
  }

  async connect(transport: Transport): Promise<void> {
    if (this._transport) throw new Error("Already connected");
    this._closed = false;
    this._transport = transport;
    transport.onmessage = (message, extra) => {
      this._onMessage(message, extra);
    };
    transport.onerror = (error) => this.onerror?.(error);
    transport.onclose = () => this._handleClose();
    try {
      await transport.start();
    } catch (error) {
      this._handleClose();
      throw error;
    }
  }

  async close(): Promise<void> {
    const transport = this._transport;
    if (!transport) return;
    try {
      await transport.close();
    } finally {
      this._handleClose();
    }
  }

  request<M extends string>(
    request: OutboundRequest & { method: M },
    options?: RequestOptions,
  ): Promise<StandardResultForMethod<M>>;
  request<T extends Result>(
    request: OutboundRequest,
    resultSchema: Schema<T>,
    options?: RequestOptions,
  ): Promise<T>;
  request(
    request: OutboundRequest,
    schemaOrOptions?: Schema | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<any> {
    const transport = this._transport;
    if (!transport) return Promise.reject(new Error("Not connected"));
    const id = ++this._requestId;
    const resultSchema =
      schemaOrOptions &&
      ("parse" in schemaOrOptions || "parseAsync" in schemaOrOptions)
        ? (schemaOrOptions as Schema<Result>)
        : undefined;
    const options = resultSchema
      ? maybeOptions
      : (schemaOrOptions as RequestOptions | undefined);
    const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;

    return new Promise<any>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: Result) => void,
        reject,
        signal: options?.signal,
        resultSchema,
      };
      const cleanupAndReject = (reason: unknown) => {
        if (!this._requests.delete(id)) return;
        this._cleanupPending(pending);
        reject(reason);
      };
      this._requests.set(id, pending);
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          cleanupAndReject(new Error(`Request timed out after ${timeout}ms`));
          void this.notification({
            method: "notifications/cancelled",
            params: { requestId: id, reason: "Request timed out" },
          }).catch(() => {});
        }, timeout);
      }
      if (options?.signal) {
        pending.abortListener = () => {
          cleanupAndReject(
            options.signal?.reason ?? new DOMException("Aborted", "AbortError"),
          );
          void this.notification({
            method: "notifications/cancelled",
            params: { requestId: id, reason: "Request aborted" },
          }).catch(() => {});
        };
        if (options.signal.aborted) {
          pending.abortListener();
          return;
        }
        options.signal.addEventListener("abort", pending.abortListener, {
          once: true,
        });
      }
      void transport
        .send(
          {
            jsonrpc: "2.0",
            id,
            method: request.method,
            params: request.params,
          },
          options,
        )
        .catch(cleanupAndReject);
    });
  }

  async notification(
    notification: OutboundNotification,
    options?: RequestOptions,
  ): Promise<void> {
    if (!this._transport) throw new Error("Not connected");
    await this._transport.send(
      {
        jsonrpc: "2.0",
        method: notification.method,
        params: notification.params,
      },
      options,
    );
  }

  setRequestHandler<M extends string>(
    method: M,
    handler: (
      request: StandardRequestForMethod<M>,
      context: ProtocolContext,
    ) => StandardResultForMethod<M> | Promise<StandardResultForMethod<M>>,
  ): void;
  setRequestHandler<TParams, TResult extends Result>(
    method: string,
    schemas: { params?: Schema<TParams>; result?: Schema<TResult> },
    handler: (
      params: TParams,
      context: ProtocolContext,
    ) => TResult | Promise<TResult>,
  ): void;
  setRequestHandler(
    method: string,
    schemasOrHandler: any,
    maybeHandler?: any,
  ): void {
    const paramsSchema =
      typeof schemasOrHandler === "function"
        ? undefined
        : schemasOrHandler.params;
    const handler =
      typeof schemasOrHandler === "function" ? schemasOrHandler : maybeHandler;
    if (!handler) throw new Error(`Missing handler for ${method}`);
    this._requestHandlers.set(method, { handler, paramsSchema });
  }

  setNotificationHandler<M extends string>(
    method: M,
    handler: (
      notification: OutboundNotification & { method: M },
    ) => void | Promise<void>,
  ): void;
  setNotificationHandler<TParams>(
    method: string,
    schemas: { params?: Schema<TParams> },
    handler: (params: TParams) => void | Promise<void>,
  ): void;
  setNotificationHandler(
    method: string,
    schemasOrHandler: any,
    maybeHandler?: any,
  ): void {
    const paramsSchema =
      typeof schemasOrHandler === "function"
        ? undefined
        : schemasOrHandler.params;
    const handler =
      typeof schemasOrHandler === "function" ? schemasOrHandler : maybeHandler;
    if (!handler) throw new Error(`Missing handler for ${method}`);
    this._notificationHandlers.set(method, { handler, paramsSchema });
  }

  protected _wrapHandler(_method: string, handler: any): any {
    return handler;
  }

  protected assertCapabilityForMethod(_method: string): void {}
  protected assertRequestHandlerCapability(_method: string): void {}
  protected assertNotificationCapability(_method: string): void {}

  private _onMessage(
    rawMessage: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ): void {
    const parsed = JSONRPCMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      this.onerror?.(new Error("Received invalid JSON-RPC message"));
      return;
    }
    const message = parsed.data as JSONRPCMessage;
    if ("method" in message && "id" in message) {
      void this._onRequest(
        message as JSONRPCRequest & { id: RequestId },
        extra,
      );
    } else if ("method" in message) {
      this._onNotification(message as JSONRPCNotification);
    } else {
      this._onResponse(message);
    }
  }

  private async _onRequest(
    request: JSONRPCRequest & { id: RequestId },
    extra?: MessageExtraInfo,
  ): Promise<void> {
    const entry = this._requestHandlers.get(request.method);
    if (!entry) {
      await this._sendError(request.id, METHOD_NOT_FOUND, "Method not found");
      return;
    }
    const controller = new AbortController();
    this._inboundControllers.set(request.id, controller);
    const context: ProtocolContext = {
      mcpReq: { signal: controller.signal, requestId: request.id },
      signal: controller.signal,
      requestId: request.id,
      sessionId: extra?.sessionId ?? this._transport?.sessionId,
    };
    try {
      const input = entry.paramsSchema
        ? await this._parse(entry.paramsSchema, request.params ?? {})
        : request;
      const handler = this._wrapHandler(request.method, entry.handler);
      const result = await handler(input, context);
      await this._transport?.send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      await this._sendError(
        request.id,
        invalid ? INVALID_PARAMS : INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this._inboundControllers.delete(request.id);
    }
  }

  private _onNotification(notification: JSONRPCNotification): void {
    if (notification.method === "notifications/cancelled") {
      const id = (notification.params as { requestId?: RequestId } | undefined)
        ?.requestId;
      if (id !== undefined) this._inboundControllers.get(id)?.abort();
    }
    const entry = this._notificationHandlers.get(notification.method);
    if (!entry) return;
    try {
      const input = entry.paramsSchema?.parse
        ? entry.paramsSchema.parse(notification.params ?? {})
        : notification;
      const result = entry.handler(input);
      if (result instanceof Promise) {
        void result.catch((error) =>
          this.onerror?.(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private _onResponse(message: JSONRPCMessage): void {
    if (!("id" in message) || message.id === undefined) return;
    const pending = this._requests.get(message.id);
    if (!pending) return;
    this._requests.delete(message.id);
    this._cleanupPending(pending);
    if ("error" in message) {
      pending.reject(
        new ProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else if ("result" in message) {
      if (pending.resultSchema) {
        void this._parse<Result>(pending.resultSchema, message.result).then(
          (result) => pending.resolve(result),
          pending.reject,
        );
      } else {
        pending.resolve(message.result as Result);
      }
    }
  }

  private async _sendError(
    id: RequestId,
    code: number,
    message: string,
  ): Promise<void> {
    await this._transport?.send({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  private async _parse<T>(schema: Schema<T>, value: unknown): Promise<T> {
    if (schema.parseAsync) return schema.parseAsync(value);
    if (schema.parse) return schema.parse(value);
    return value as T;
  }

  private _cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  private _handleClose(): void {
    if (this._closed) return;
    this._closed = true;
    this._transport = undefined;
    for (const pending of this._requests.values()) {
      this._cleanupPending(pending);
      pending.reject(new Error("Connection closed"));
    }
    this._requests.clear();
    for (const controller of this._inboundControllers.values()) {
      controller.abort();
    }
    this._inboundControllers.clear();
    this.onclose?.();
  }
}
