import type {
  ChangeBusEventDataMap,
  CollectionConfig,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";

export type CollectionKey<C extends ChangeBusEventDataMap> = Extract<keyof C, string>;

/** `deserializeDeleteId` is required for a composite key (an object), optional otherwise. */
export type DeleteIdHookRequirement<Key, Hook> = Key extends string | number
  ? unknown
  : { deserializeDeleteId: Hook };

/** The event map of one collection config, keyed by the collection's name. */
export type EventMapFromCollectionConfig<
  Col extends CollectionConfig<any, any, any, any, any, any>,
> = Record<
  Col["name"],
  {
    create: InferCollectionInsertModel<Col>;
    update: InferCollectionUpdateModel<Col>;
    delete: InferCollectionPrimaryFieldType<Col>;
    record: InferCollectionSelectModel<Col>;
  }
>;
