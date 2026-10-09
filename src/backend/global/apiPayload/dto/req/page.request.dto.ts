import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class PageQueryDTO {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ maxLength: 512 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(512, {
    context: { code: 'invalid_cursor', message: '목록을 다시 불러와 주세요' },
  })
  cursor?: string;
}

export class SearchPageQueryDTO extends PageQueryDTO {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  q?: string;
}
