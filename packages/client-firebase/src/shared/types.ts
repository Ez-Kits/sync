import type { ChangeBusEventDataMap } from "@ez-kits/sync-client-core";

export type CollectionKey<C extends ChangeBusEventDataMap> = Extract<keyof C, string>;

/** `deserializeDeleteId` is required for a composite key (an object), optional otherwise. */
export type DeleteIdHookRequirement<Key, Hook> = Key extends string | number
  ? unknown
  : { deserializeDeleteId: Hook };
