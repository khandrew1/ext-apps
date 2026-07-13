import { OptionDefaults } from "typedoc";

/** MCP TypeScript SDK v2 documentation site (per-symbol pages not available). */
const V2_SDK_DOCS = "https://ts.sdk.modelcontextprotocol.io/v2/";

/** @type {Partial<import('typedoc').TypeDocOptions>} */
const config = {
  name: "MCP Apps",
  readme: "README.md",
  headings: {
    readme: false,
  },
  gitRevision: "main",
  projectDocuments: [
    "docs/overview.md",
    "docs/quickstart.md",
    "docs/agent-skills.md",
    "docs/testing-mcp-apps.md",
    "docs/patterns.md",
    "docs/authorization.md",
    "docs/csp-cors.md",
    "docs/migrate_from_openai_apps.md",
  ],
  entryPoints: [
    "src/server/index.ts",
    "src/app.ts",
    "src/react/index.tsx",
    "src/app-bridge.ts",
    "src/message-transport.ts",
    "src/types.ts",
  ],
  excludePrivate: true,
  excludeInternal: false,
  intentionallyNotExported: [
    "src/server/index.ts:ZodRawShape",
    "src/server/index.ts:AppToolCallback",
  ],
  // v2 SDK symbols referenced by inherited JSDoc ({@link}s in
  // @modelcontextprotocol/client-server declaration comments) that are not
  // part of the ext-apps documentation. Point at the v2 SDK docs site.
  externalSymbolLinkMappings: {
    "@modelcontextprotocol/client": {
      ClientOptions: V2_SDK_DOCS,
      ConnectOptions: V2_SDK_DOCS,
      DiscoverResult: V2_SDK_DOCS,
      ProtocolError: V2_SDK_DOCS,
      "Protocol.close": V2_SDK_DOCS,
      "Protocol.notification": V2_SDK_DOCS,
      ResponseCacheStore: V2_SDK_DOCS,
      SdkError: V2_SDK_DOCS,
      "SdkErrorCode.MethodNotSupportedByProtocolVersion": V2_SDK_DOCS,
      TransportSendOptions: V2_SDK_DOCS,
      "__type.enforceStrictCapabilities": V2_SDK_DOCS,
    },
    "@modelcontextprotocol/server": {
      LoggingMessageNotification: V2_SDK_DOCS,
      "MessageExtraInfo.classification": V2_SDK_DOCS,
      "Protocol.close": V2_SDK_DOCS,
      "Protocol.notification": V2_SDK_DOCS,
      ResourceTemplate: V2_SDK_DOCS,
      "SdkErrorCode.UnsupportedResultType": V2_SDK_DOCS,
      Server: V2_SDK_DOCS,
      Transport: V2_SDK_DOCS,
    },
  },
  blockTags: [...OptionDefaults.blockTags, "@description"],
  jsDocCompatibility: {
    exampleTag: false,
  },
  includeVersion: false,
  categorizeByGroup: true,
  groupOrder: ["Getting Started", "Security", "Modules", "*"],
  navigation: {
    includeGroups: true,
  },
  navigationLinks: {
    GitHub: "https://github.com/modelcontextprotocol/ext-apps",
    Specification:
      "https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx",
  },
  hostedBaseUrl: "https://apps.extensions.modelcontextprotocol.io/api/",
  customCss: "./docs/mcp-theme.css",
  out: "docs/api",
  plugin: [
    "typedoc-github-theme",
    "./scripts/typedoc-plugin-v2-sdk-links.mjs",
    "./scripts/typedoc-plugin-fix-mermaid-entities.mjs",
    "./scripts/typedoc-plugin-seo.mjs",
    "./scripts/typedoc-plugin-mcpstyle.mjs",
    "@boneskull/typedoc-plugin-mermaid",
  ],
  ignoredHighlightLanguages: ["mermaid"],
  locales: {
    en: {
      kind_plural_document: "Getting Started",
      kind_plural_module: "API Documentation",
    },
  },
};

export default config;
