import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Currency, Expense } from '../../../../../shared/domain/settle';
import { CURRENCY_CODES } from '../../../../../shared/domain/settle/money';
import { MAX_GROUP_MEMBERS } from '../../../../../shared/domain/group/constants';
import { SearchPageQueryDTO } from '../../../../global/apiPayload/dto/req/page.request.dto';
import { settleErrors } from '../../code/settle.error.code';
import type { RoundListQuery } from '../../service/roundList.query';
import { parseSearchPageQuery } from '../../../../global/apiPayload/pageQuery';

export class CreateRoundRequestDTO {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    type: [String],
    minItems: 2,
    maxItems: MAX_GROUP_MEMBERS,
    uniqueItems: true,
  })
  @IsArray({ context: settleErrors.INVALID_PARTICIPANTS })
  @ArrayMinSize(2, { context: settleErrors.MINIMUM_PARTICIPANTS })
  @ArrayMaxSize(MAX_GROUP_MEMBERS, {
    context: settleErrors.INVALID_PARTICIPANTS,
  })
  @ArrayUnique({ context: settleErrors.INVALID_PARTICIPANTS })
  @IsString({ each: true, context: settleErrors.INVALID_PARTICIPANTS })
  @Matches(/^[\w-]{1,128}$/, {
    each: true,
    context: settleErrors.INVALID_PARTICIPANTS,
  })
  participantIds!: string[];
}
export class VersionRequestDTO {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  @IsInt({ context: settleErrors.VERSION_REQUIRED })
  @Min(1, { context: settleErrors.VERSION_REQUIRED })
  @Max(Number.MAX_SAFE_INTEGER, { context: settleErrors.VERSION_REQUIRED })
  expectedVersion!: number;
  [key: string]: unknown;
}
export class CustomShareRequestDTO {
  @ApiProperty({ maxLength: 128 })
  @IsString({ context: settleErrors.INVALID_PARTICIPANTS })
  @Matches(/^[\w-]{1,128}$/, { context: settleErrors.INVALID_PARTICIPANTS })
  userId!: string;

  @ApiProperty({ type: String, example: '10.25' })
  @IsString({ context: settleErrors.INVALID_CUSTOM_SHARE_AMOUNT })
  @Matches(/^\d+(\.\d{1,2})?$/, {
    context: settleErrors.INVALID_CUSTOM_SHARE_AMOUNT,
  })
  amount!: string;
}
export class ExpenseRequestDTO extends VersionRequestDTO {
  @ApiPropertyOptional({ enum: CURRENCY_CODES })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(CURRENCY_CODES, { context: settleErrors.UNSUPPORTED_EXPENSE_CURRENCY })
  currency?: Currency;

  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  description?: string;

  @ApiPropertyOptional({ type: String, example: '10.25' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ context: settleErrors.INVALID_AMOUNT })
  @Matches(/^\d+(\.\d{1,2})?$/, { context: settleErrors.INVALID_AMOUNT })
  amount?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ context: settleErrors.INVALID_PARTICIPANTS })
  @MaxLength(128, { context: settleErrors.INVALID_PARTICIPANTS })
  payerId?: string;

  @ApiPropertyOptional({ enum: ['ALL', 'SELECTED', 'CUSTOM'] })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['ALL', 'SELECTED', 'CUSTOM'], {
    context: settleErrors.INVALID_SPLIT_MODE,
  })
  splitMode?: Expense['splitMode'];

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: MAX_GROUP_MEMBERS,
    uniqueItems: true,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ context: settleErrors.INVALID_PARTICIPANTS })
  @ArrayMinSize(1, { context: settleErrors.INVALID_PARTICIPANTS })
  @ArrayMaxSize(MAX_GROUP_MEMBERS, {
    context: settleErrors.INVALID_PARTICIPANTS,
  })
  @ArrayUnique({ context: settleErrors.INVALID_PARTICIPANTS })
  @Matches(/^[\w-]{1,128}$/, {
    each: true,
    context: settleErrors.INVALID_PARTICIPANTS,
  })
  participantIds?: string[];

  @ApiPropertyOptional({
    type: () => [CustomShareRequestDTO],
    minItems: 1,
    maxItems: MAX_GROUP_MEMBERS,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ context: settleErrors.CUSTOM_SHARES_REQUIRED })
  @ArrayMinSize(1, { context: settleErrors.CUSTOM_SHARES_REQUIRED })
  @ArrayMaxSize(MAX_GROUP_MEMBERS, {
    context: settleErrors.CUSTOM_SHARES_REQUIRED,
  })
  @ValidateNested({ each: true, context: settleErrors.CUSTOM_SHARES_REQUIRED })
  @Type(() => CustomShareRequestDTO)
  customShares?: CustomShareRequestDTO[];
}
export class CreateExpenseRequestDTO extends ExpenseRequestDTO {
  @ApiProperty({ enum: CURRENCY_CODES })
  @ValidateIf(() => true)
  @IsIn(CURRENCY_CODES, { context: settleErrors.UNSUPPORTED_EXPENSE_CURRENCY })
  declare currency: Currency;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @ValidateIf(() => true)
  @IsString()
  @Matches(/\S/)
  declare description: string;

  @ApiProperty({ type: String, example: '10.25' })
  @ValidateIf(() => true)
  @IsString({ context: settleErrors.INVALID_AMOUNT })
  @Matches(/^\d+(\.\d{1,2})?$/, { context: settleErrors.INVALID_AMOUNT })
  declare amount: string;

  @ApiProperty({ maxLength: 128 })
  @ValidateIf(() => true)
  @IsString({ context: settleErrors.INVALID_PARTICIPANTS })
  @MaxLength(128, { context: settleErrors.INVALID_PARTICIPANTS })
  declare payerId: string;

  @ApiProperty({ enum: ['ALL', 'SELECTED', 'CUSTOM'] })
  @ValidateIf(() => true)
  @IsIn(['ALL', 'SELECTED', 'CUSTOM'], {
    context: settleErrors.INVALID_SPLIT_MODE,
  })
  declare splitMode: Expense['splitMode'];
}
export class SettlementCheckRequestDTO extends VersionRequestDTO {
  @ApiProperty({ type: Boolean })
  @IsBoolean({ context: settleErrors.CHECK_STATE_REQUIRED })
  checked!: boolean;

  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ context: settleErrors.INVALID_SENDER })
  @Matches(/^[\w-]{1,128}$/, { context: settleErrors.INVALID_SENDER })
  senderId?: string;

  @ApiPropertyOptional({ enum: CURRENCY_CODES })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(CURRENCY_CODES, { context: settleErrors.UNSUPPORTED_TRANSFER_CURRENCY })
  currency?: Currency;
}
export class RoundListQueryDTO extends SearchPageQueryDTO {
  @ApiPropertyOptional({
    enum: ['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'],
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'])
  status?: Exclude<RoundListQuery['status'], null>;
}

export function parseRoundListQuery(query: RoundListQueryDTO): RoundListQuery {
  return { ...parseSearchPageQuery(query), status: query.status ?? null };
}
