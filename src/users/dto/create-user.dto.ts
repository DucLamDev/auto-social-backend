import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { IsArray, IsEmail, IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ enum: RoleName, isArray: true })
  @IsArray()
  @IsEnum(RoleName, { each: true })
  roles!: RoleName[];
}
