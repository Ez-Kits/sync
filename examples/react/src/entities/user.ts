import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("users")
export class User {
  @PrimaryColumn("integer")
  id!: number;

  @Column("text")
  name!: string;

  @Column("text", { nullable: true })
  email!: string | null;
}
