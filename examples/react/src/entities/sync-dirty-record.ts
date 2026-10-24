import type { DirtyRecord } from "@ez-kits/sync-client-core";
import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity("ez_sync_dirty_records")
@Index("ez_sync_dirty_record_key", ["collection", "recordId"], { unique: true })
export class SyncDirtyRecord {
  @PrimaryColumn("text")
  collection!: string;

  @PrimaryColumn("text")
  recordId!: string;

  @Column("text")
  state!: DirtyRecord["state"];

  @Column("integer")
  updatedAt!: number;
}
