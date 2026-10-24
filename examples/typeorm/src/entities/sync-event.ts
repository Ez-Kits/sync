import type { StoredChangeBusEvent } from "@ez-kits/sync-client-core";
import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("ez_sync_events")
export class SyncEvent {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  type!: StoredChangeBusEvent["type"];

  @Column("text")
  collection!: string;

  @Column("simple-json", { nullable: true })
  data!: unknown;

  @Column("text")
  recordId!: string;

  @Column("integer")
  createdAt!: number;
}
