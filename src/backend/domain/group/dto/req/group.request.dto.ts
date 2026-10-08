import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { SearchPageQueryDTO } from '../../../../global/apiPayload/dto/req/page.request.dto';

export class CreateGroupRequestDTO {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  name!: string;
  [key: string]: unknown;
}
export class CreateInviteRequestDTO {
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  replaceInviteId?: string;
  [key: string]: unknown;
}
export class GroupListQueryDTO extends SearchPageQueryDTO {}
