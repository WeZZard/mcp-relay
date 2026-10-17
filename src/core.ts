/**
 * The host-agnostic core of mcp-relay: everything a front end needs to
 * offer the relay to an agent, with no dependency on any agent runtime. The
 * MCP server (`src/server.ts`) and any other runtime's binding are thin
 * wrappers over these exports.
 */
export { RelayManager, instructions, RELAY_RUN_OUTPUTS, GUEST_NAME } from './manager.js';
export type { ManagerOptions, AcquireInput, StageInput, RunInput, RunResult, Extraction, ConsoleAttemptInput, ConsoleOpenInput, GuestSelector, GuestStatus } from './manager.js';
export { Registry, RegistryError, resolveRegistry, validateRegistryText } from './registry.js';
export type { RegistryRow, RegistryOptions, RegistryResolution } from './registry.js';
export { relayContract, relayParameters, relayActions, validateRelayInput, toolInputSchema } from './schema.js';
export type { RelayInput, RelayAction, RunKind, RunTarget } from './schema.js';
export { TARGETS, TARGET_PACKAGES, DEFAULT_AFTER_INTERVAL_MS, targetLaunches } from './targets.js';
export type { Target, TargetLaunch, PinnedPackage } from './targets.js';
export { relayTools, relayToolInput, relayToolInputSchema, relayResultKind, relayJsonSchema, relayCall, renderRelayResult } from './surface.js';
export type { RelayTool, RelayToolAnnotations, RelayCallResult, RelayRendered, RelayImageContent } from './surface.js';
export { deliverPackage, verifyDeliveredPackage } from './package.js';
export type { DeliverPackageOptions, DeliveryResult } from './package.js';
export { VmService, VmServiceError, AcquireIndeterminateError } from './vm-service.js';
export type { VmLease, VmList, VmImages, VmServiceOptions, VmBackend } from './vm-service.js';
export { probeLocal } from './probe.js';
export { relayStateRoot, guestNetwork, GUEST_NETWORKS, maxGuests, DEFAULT_MAX_GUESTS } from './config.js';
export type { GuestNetwork } from './config.js';
export { loadEnvironment, selectedEnvironment, environmentVariables, matchesEnvironment, canonicalPath } from './environment.js';
export type { VmEnvironment, EnvironmentIdentity, SelectedEnvironment } from './environment.js';
export { consoleStatus, acquisitionCapabilities } from './console.js';
export type { ConsoleStatus, ConsoleAttemptStatus } from './console.js';
export { ImageStore, imageCapability, imageFailure } from './images.js';
export type { ImageTarget, ImageStatus, ImageDescriptor, ImageResult, ImageStoreOptions } from './images.js';
export { prepareImage, IMAGE_PRESENTATION_POLICY, PresentationUnavailableError } from './image-presentation.js';
export type { PreparedImage } from './image-presentation.js';
export { refreshEvidenceState } from './evidence-merge.js';
export { ImageTransferError } from './transfer.js';
export type { ImageTransferErrorCode, ImageTransferOptions } from './transfer.js';
