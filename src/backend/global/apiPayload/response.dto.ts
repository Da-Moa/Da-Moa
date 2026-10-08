export type ApiSuccessCode = { code: string; message: string; detail: unknown };
export class ApiResponseDto<T> {
  constructor(
    readonly meta: ApiSuccessCode,
    readonly data: T,
  ) {}
}
