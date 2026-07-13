/**
 * TypeDoc plugin that resolves {@link} declaration references inherited from
 * MCP TypeScript SDK v2 declaration comments (e.g. `index.inputRequired` in
 * `@modelcontextprotocol/server`'s Server.createMessage JSDoc).
 *
 * These references are module-local (`index.<symbol>`), so TypeDoc's
 * `externalSymbolLinkMappings` — which only matches `package!symbol`
 * references — cannot resolve them. Without this plugin they fail validation
 * (`--treatValidationWarningsAsErrors`).
 */

const V2_SDK_DOCS = "https://ts.sdk.modelcontextprotocol.io/v2/";

/** Declaration references, as written in v2 SDK comments, mapped to docs URLs. */
const KNOWN_V2_REFS = new Map([["index.inputRequired", V2_SDK_DOCS]]);

/**
 * TypeDoc plugin entry point.
 * @param {import('typedoc').Application} app
 */
export function load(app) {
  app.converter.addUnknownSymbolResolver((ref) => {
    const name = ref.symbolReference?.path?.map((p) => p.path).join(".");
    if (name && KNOWN_V2_REFS.has(name)) {
      return KNOWN_V2_REFS.get(name);
    }
  });
}
