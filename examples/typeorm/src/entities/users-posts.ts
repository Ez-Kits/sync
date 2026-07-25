import { Entity, PrimaryColumn } from "typeorm";

@Entity("users_posts")
export class UsersPosts {
  @PrimaryColumn("integer")
  userId!: number;

  @PrimaryColumn("integer")
  postId!: number;
}
