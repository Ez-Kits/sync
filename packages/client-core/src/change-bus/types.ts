import type {
  CollectionConfigMap,
  CollectionNames,
  ConfigForName,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "../collection";

type ChangeBusEventUnion<C extends ChangeBusEventDataMap> = {
  [N in keyof C]:
    | {
        type: "create";
        collection: N;
        data: C[N]["create"];
        /** Persisted local event id; used to ack after push. */
        eventId?: string;
      }
    | {
        type: "update";
        collection: N;
        data: C[N]["update"];
        /** Persisted local event id; used to ack after push. */
        eventId?: string;
      }
    | {
        type: "delete";
        collection: N;
        id: C[N]["delete"];
        /** Epoch milliseconds when the record was deleted, when known. */
        deletedAt?: number;
        /** Persisted local event id; used to ack after push. */
        eventId?: string;
      };
}[keyof C];

export type ChangeBusEventDataMap = {
  [key: string]: {
    create: any;
    update: any;
    delete: any;
  };
};

export type ChangeBusEventDataMapFromCollectionConfigMap<C extends CollectionConfigMap> = {
  [N in CollectionNames<C>]: {
    create: InferCollectionInsertModel<ConfigForName<C, N>>;
    update: InferCollectionUpdateModel<ConfigForName<C, N>>;
    delete: InferCollectionPrimaryFieldType<ConfigForName<C, N>>;
    record: InferCollectionSelectModel<ConfigForName<C, N>>;
  };
};

export type ChangeBusEvent<C extends ChangeBusEventDataMap, N extends keyof C = keyof C> = Extract<
  ChangeBusEventUnion<C>,
  { collection: N }
>;

export type ChangeBusListener<C extends ChangeBusEventDataMap, N extends keyof C = keyof C> = (
  events: ChangeBusEvent<C, N>[],
) => void;

export type ChangeBusStream = "local" | "remote";
export type ChangeBusSubscribeStream = ChangeBusStream | "both";

export interface ChangeBusSubscribeOptions {
  stream?: ChangeBusSubscribeStream;
}
