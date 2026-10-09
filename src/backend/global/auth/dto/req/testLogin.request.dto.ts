import { IsOptional, IsString } from 'class-validator';

export class TestLoginRequestDTO {
  @IsString()
  key!: string;

  @IsOptional()
  @IsString()
  returnTo?: string;
}

// The global pipe skips this erased type; the route pipe validates the DTO once
// with the existing login error contract instead of the general field error.
export type TestLoginInput = Pick<TestLoginRequestDTO, 'key' | 'returnTo'>;
