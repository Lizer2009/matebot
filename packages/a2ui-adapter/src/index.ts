export {
  dispatchInteractionAction,
  type InteractionActionPayload,
  type InteractionActionRecord,
  type InteractionDispatchDeps,
  type InteractionDispatchResult,
  type ParsedInteractionAction,
  parseInteractionAction,
  resetInteractionActionState,
} from "./action-bridge.js";
export {
  type CompileInteractionPlanInput,
  type CompileInteractionPlanResult,
  compileInteractionPlan,
  reconcilePlanToSchema,
} from "./compile.js";
export {
  type CompileInteractionSurfaceInput,
  type CompileInteractionSurfaceResult,
  compileInteractionSurface,
  INTERACTION_ACTION_EVENT,
  INTERACTION_ALLOWED_ACTIONS,
  type InteractionAllowedAction,
  type SurfaceDataModel,
  surfaceDataModel,
} from "./compile-surface.js";
export {
  A2UI_PNPM_GIT_SPEC,
  A2UI_UPSTREAM_COMMIT,
  A2UI_UPSTREAM_REPO,
  A2UI_WEB_CORE_NPM_VERSION,
  A2UI_WEB_CORE_PATH,
} from "./pin.js";
export {
  basicCatalogId,
  DEFAULT_PROTOCOL_FAMILY,
  protocolWireVersion,
  webCoreSchemaPath,
} from "./protocol.js";
export {
  type ValidateA2uiMessagesInput,
  type ValidateA2uiMessagesResult,
  validateA2uiMessage,
  validateA2uiMessages,
} from "./validate.js";
export { loadWebCoreSchemas } from "./web-core.js";
