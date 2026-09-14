import { Column, Entity, Index, OneToMany } from "typeorm";



@Index("Users_pkey", ["id"], { unique: true })
@Entity("Users", { schema: "public" })
export class Users {
  @Column("uuid", { primary: true, name: "Id", generated: "uuid" })
  id: string;

  @Column("character varying", { name: "ImageSrc", nullable: true })
  imageSrc: string;

  @Column("character varying", { name: "Username", length: 150 })
  username: string;

  @Column("character varying", { name: "Password" })
  password: string;

  @Column("timestamp with time zone", { name: "CreateAt" })
  createAt: Date;

  @Column("smallint", { name: "RecordStatus" })
  recordStatus: number;

  @Column("uuid", { name: "UserId", nullable: true })
  userId: string;


  
}
