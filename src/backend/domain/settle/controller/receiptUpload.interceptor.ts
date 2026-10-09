import {
  Injectable,
  Inject,
  createParamDecorator,
  type ExecutionContext,
  type CallHandler,
  type NestInterceptor,
  HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedRequest } from '../../../global/auth/decorator/currentUser.decorator';
import { readIdempotencyKey } from '../../../global/apiPayload/requiredHeader.decorator';
import { AppError } from '../../../global/apiPayload/errors';
import {
  SettleService,
  type ReceiptAdmission,
} from '../service/settle.service';
import { SettleException } from '../exception/settle.exception';
import { settleErrors } from '../code/settle.error.code';
import {
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_REQUEST_BYTES,
} from '../../../../shared/domain/settle';

export type ReceiptFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};
type ReceiptRequest = AuthenticatedRequest & {
  receiptAdmission?: ReceiptAdmission;
  file?: ReceiptFile;
};
const limits = {
  fileSize: MAX_RECEIPT_BYTES,
  fieldSize: MAX_RECEIPT_REQUEST_BYTES,
  fields: 1,
  files: 1,
  parts: 2,
  fieldNestingDepth: 0,
};
const ReceiptFileInterceptor = FileInterceptor('file', {
  limits,
  defParamCharset: 'utf8',
  preservePath: true,
});

export const CurrentReceiptAdmission = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ReceiptAdmission => {
    const admission = context
      .switchToHttp()
      .getRequest<ReceiptRequest>().receiptAdmission;
    if (!admission) throw new Error('Receipt upload was not admitted');
    return admission;
  },
);

@Injectable()
export class ReceiptUploadInterceptor
  extends ReceiptFileInterceptor
  implements NestInterceptor
{
  constructor(@Inject(SettleService) private readonly service: SettleService) {
    super();
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<ReceiptRequest>();
    const key = readIdempotencyKey(request);
    request.receiptAdmission = await this.service.admitReceipt(
      request.user ?? null,
      key,
      String(request.params.roundId),
      String(request.params.expenseId),
    );
    const tooLarge = () =>
      new AppError(413, 'receipt_too_large', '요청 크기가 너무 커요');
    if (Number(request.headers['content-length']) > MAX_RECEIPT_REQUEST_BYTES)
      throw tooLarge();
    if (!request.is('multipart/form-data'))
      throw new SettleException(settleErrors.INVALID_RECEIPT_FORM);
    let size = 0;
    let exceeded = false;
    const countBytes = (chunk: Buffer) => {
      size += chunk.length;
      if (!exceeded && size > MAX_RECEIPT_REQUEST_BYTES) {
        exceeded = true;
        // Multer owns abort/partial-file cleanup. Do not destroy the HTTP socket:
        // it still carries the application's JSON error response.
        request.emit('error', tooLarge());
      }
    };
    request.on('data', countBytes);
    try {
      const handling = await super.intercept(context, next);
      if (
        !request.file ||
        !Object.hasOwn(request.body ?? {}, 'expectedVersion')
      )
        throw new SettleException(settleErrors.SINGLE_RECEIPT_REQUIRED);
      return handling;
    } catch (error) {
      if (exceeded) throw tooLarge();
      if (error instanceof SettleException) throw error;
      if (error instanceof HttpException && error.getStatus() === 413)
        throw new SettleException(settleErrors.RECEIPT_TOO_LARGE);
      const message = error instanceof Error ? error.message : '';
      throw new SettleException(
        /multipart|unexpected end|malformed/i.test(message)
          ? settleErrors.INVALID_RECEIPT_FORM
          : settleErrors.SINGLE_RECEIPT_REQUIRED,
      );
    } finally {
      request.off('data', countBytes);
    }
  }
}
