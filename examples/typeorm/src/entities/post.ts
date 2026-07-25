import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("posts")
export class Post {
  @PrimaryColumn("integer")
  id!: number;

  @Column("text", { nullable: true })
  title!: string | null;

  @Column("text", { nullable: true })
  content!: string | null;
}
