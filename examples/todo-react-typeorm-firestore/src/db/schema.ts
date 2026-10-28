import "reflect-metadata";
import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("todos")
export class Todo {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  title!: string;

  @Column("boolean", { default: false })
  completed!: boolean;

  @Column("integer")
  updatedAt!: number;
}
