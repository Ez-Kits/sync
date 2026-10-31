import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ConflictResolution,
} from "@ez-kits/sync-client-core";

export type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ConflictResolution,
} from "@ez-kits/sync-client-core";

export type ConflictContext<C extends ChangeBusEventDataMap> = Parameters<ConflictResolution<C>>[0];

export type ConflictDecision = "local" | "remote" | { data: unknown };

/**
 * The collection names a policy resolves. Every policy's data map `C` defaults to `any`: inline
 * in `createSyncClient` it is inferred from the collections, and a policy stored in a variable
 * first (`const policy = mergeFields({ ... })`) fits any client. For such an untyped map the
 * names widen to `any` too, as `keyof any` would not fit a client's names.
 */
type PolicyNames<C extends ChangeBusEventDataMap> = string extends keyof C ? any : keyof C;

/** Always preserve the local record when a remote conflict is received. */
export function localWins<C extends ChangeBusEventDataMap = any>(): ConflictResolution<
  C,
  PolicyNames<C>
> {
  return () => "local";
}

/** Always apply the incoming remote event when a conflict is received. */
export function remoteWins<C extends ChangeBusEventDataMap = any>(): ConflictResolution<
  C,
  PolicyNames<C>
> {
  return () => "remote";
}

export type ConflictVersion = number | string | Date;
export type ComparableConflictVersion = number | string;

export interface LastWriteWinsOptions<C extends ChangeBusEventDataMap> {
  getLocalVersion: (local: ConflictContext<C>["local"]) => ConflictVersion | undefined;
  getRemoteVersion: (remote: ChangeBusEvent<C>) => ConflictVersion | undefined;
  onMissingVersion: "local" | "remote";
  onTie: "local" | "remote";
}

/** Compare caller-selected version metadata; strings are compared lexicographically. */
export function lastWriteWins<C extends ChangeBusEventDataMap = any>(
  options: LastWriteWinsOptions<C>,
): ConflictResolution<C, PolicyNames<C>> {
  return ({ remote, local }) => {
    const localVersion = normalizeVersion(options.getLocalVersion(local));
    const remoteVersion = normalizeVersion(options.getRemoteVersion(remote));

    if (localVersion === undefined || remoteVersion === undefined) {
      return options.onMissingVersion;
    }

    if (typeof localVersion !== typeof remoteVersion) {
      return options.onMissingVersion;
    }

    if (localVersion === remoteVersion) {
      return options.onTie;
    }

    return localVersion > remoteVersion ? "local" : "remote";
  };
}

export type FieldMerge = (localValue: unknown, remoteValue: unknown) => unknown;

export interface FieldMergeOptions {
  fields: Readonly<Record<string, FieldMerge>>;
  onMissingLocal: "local" | "remote";
  onRemoteDelete: "local" | "remote";
}

/**
 * Use remote data as the base and apply only the explicitly configured field merges.
 * This is a shallow merge; it does not recursively combine nested objects or arrays.
 */
export function mergeFields<C extends ChangeBusEventDataMap = any>(
  options: FieldMergeOptions,
): ConflictResolution<C, PolicyNames<C>> {
  return ({ remote, local }) => {
    if (remote.type === "delete") return options.onRemoteDelete;
    if (!isRecord(local)) return options.onMissingLocal;
    if (!isRecord(remote.data)) return "remote";

    const localRecord: Record<string, unknown> = local;
    const remoteRecord: Record<string, unknown> = remote.data;
    let data: Record<string, unknown> = { ...localRecord, ...remoteRecord };
    for (const [field, merge] of Object.entries(options.fields)) {
      data = { ...data, [field]: merge(localRecord[field], remoteRecord[field]) };
    }
    return { data };
  };
}

export interface DeleteUpdateOptions {
  /** Resolution when the incoming event deletes a record with a local row. */
  onRemoteDelete: "local" | "remote";
  /** Resolution when a remote upsert arrives but the local row is absent. */
  onMissingLocal: "local" | "remote";
}

/**
 * Resolve delete-versus-update cases visible from the current core hook.
 * An absent local row is treated as a possible local delete; the hook cannot distinguish
 * that from an unavailable row read, so configure `onMissingLocal` deliberately.
 */
export function deleteVsUpdate<C extends ChangeBusEventDataMap = any>(
  options: DeleteUpdateOptions,
): ConflictResolution<C, PolicyNames<C>> {
  return ({ remote, local }) => {
    if (remote.type === "delete") return options.onRemoteDelete;
    if (local === undefined) return options.onMissingLocal;
    return "remote";
  };
}

export interface ManualResolutionOptions<C extends ChangeBusEventDataMap> {
  onConflict: (
    context: ConflictContext<C>,
  ) => ConflictDecision | undefined | Promise<ConflictDecision | undefined>;
  /** Used when the application callback has no decision yet. */
  fallback: ConflictDecision;
}

/**
 * Delegate a conflict decision to the application and use the explicit fallback when it
 * returns undefined. The application owns any persistence/replay of deferred conflicts.
 */
export function manualResolution<C extends ChangeBusEventDataMap = any>(
  options: ManualResolutionOptions<C>,
): ConflictResolution<C, PolicyNames<C>> {
  return async (context) => (await options.onConflict(context)) ?? options.fallback;
}

function normalizeVersion(
  version: ConflictVersion | undefined,
): ComparableConflictVersion | undefined {
  if (version instanceof Date) {
    const timestamp = version.getTime();
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  if (typeof version === "number") {
    return Number.isFinite(version) ? version : undefined;
  }
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
