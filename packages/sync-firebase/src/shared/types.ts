import type { ChangeBusEventDataMap } from "@ez-kits/sync-client-core";

export type CollectionKey<C extends ChangeBusEventDataMap> = Extract<keyof C, string>;
