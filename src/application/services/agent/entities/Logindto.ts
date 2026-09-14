import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class LoginDto {
  @ApiProperty({
    description: 'User name'
   
  })
  @IsString()
  @IsNotEmpty()
  username: string;
  @ApiProperty({
    description: 'Password',

  })
  @IsString()
  @IsNotEmpty()
  password: string;
}