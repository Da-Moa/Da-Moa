import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiHeader,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiSuccessCode } from './response.dto';
import { ApiErrorResponseDTO } from './error.response.dto';

export function ApiDataResponse(
  type: Type<unknown>,
  description = '요청 성공',
) {
  return applyDecorators(
    ApiExtraModels(type, ApiSuccessCode),
    ApiResponse({
      status: 200,
      description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { $ref: getSchemaPath(type) },
          meta: { $ref: getSchemaPath(ApiSuccessCode) },
        },
      },
    }),
  );
}

export function ApiErrors(
  statuses: readonly number[] = [400, 401, 403, 404, 409, 422, 424, 429, 503],
) {
  return applyDecorators(
    ApiExtraModels(ApiErrorResponseDTO),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description:
          status === 429
            ? '전체 또는 사용자별 요청량 제한. Retry-After 초 뒤 재시도하며 저장 요청의 기존 Idempotency-Key와 본문을 유지합니다.'
            : '요청 오류. 409는 상태·버전·제외·인원 제한·미종료 회차·멱등 키 충돌, 503은 같은 키로 재시도할 저장소·외부 서비스 오류입니다.',
        type: ApiErrorResponseDTO,
        ...(status === 429
          ? {
              headers: {
                'Retry-After': {
                  description: '다음 요청까지 대기할 초',
                  schema: { type: 'integer', minimum: 1 },
                },
              },
              example: {
                error: 'rate_limited',
                message: '요청이 많아요. 2초 후 다시 시도해 주세요.',
                details: { retryAfterSeconds: 2 },
              },
            }
          : {}),
      }),
    ),
  );
}

export const ApiOrigin = () =>
  ApiHeader({
    name: 'Origin',
    required: true,
    schema: { type: 'string', format: 'uri' },
    description: '현재 서비스 origin과 정확히 일치해야 합니다.',
  });

export function ApiMutationHeaders(
  description = '한 제출당 한 UUID. 네트워크·토큰 갱신 후 재시도에도 같은 키와 본문을 사용합니다.',
) {
  return applyDecorators(
    ApiOrigin(),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description,
    }),
  );
}
