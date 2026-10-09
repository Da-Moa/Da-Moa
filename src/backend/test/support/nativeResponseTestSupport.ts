import { EventEmitter } from 'node:events';
import { response as expressResponseMethods } from 'express';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { writeErrorResponse } from '../../global/apiPayload/errors';

// Direct-handler fixtures capture native writes; real HTTP suites verify the wire.
export function captureResponse(
  request: ExpressRequest,
  headers = new Headers(),
  initialStatus = 200,
) {
  const emitter = new EventEmitter();
  let status = initialStatus;
  let result: Response | undefined;
  const response = Object.assign(emitter, {
    req: request,
    cookie: expressResponseMethods.cookie,
    append: expressResponseMethods.append,
    set: expressResponseMethods.set,
    get(key: string) {
      return key.toLowerCase() === 'set-cookie'
        ? headers.getSetCookie()
        : (headers.get(key) ?? undefined);
    },
    status(value: number) {
      status = value;
      return this;
    },
    setHeader(key: string, value: string | string[]) {
      headers.delete(key);
      if (Array.isArray(value))
        for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    },
    json(body: unknown) {
      headers.set('content-type', 'application/json; charset=utf-8');
      this.end(Buffer.from(JSON.stringify(body)));
      return this;
    },
    end(body: Buffer) {
      result = new Response(
        request.method === 'HEAD' ? null : new Uint8Array(body),
        { status, headers },
      );
      emitter.emit('finish');
    },
  }) as unknown as ExpressResponse;
  return {
    response,
    get result() {
      return result;
    },
  };
}

export function errorResponse(error: unknown) {
  const captured = captureResponse({ method: 'GET' } as ExpressRequest);
  writeErrorResponse(captured.response, error);
  return captured.result!;
}
