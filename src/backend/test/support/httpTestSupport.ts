import { testTokens } from './guardRequestTestSupport';
import { testProvider } from './domainTestSupport';
import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { Readable } from 'node:stream';
import {
  PATH_METADATA,
  METHOD_METADATA,
  ROUTE_ARGS_METADATA,
  HTTP_CODE_METADATA,
  HEADERS_METADATA,
} from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { defer, lastValueFrom } from 'rxjs';
import { RequestBodyInterceptor } from '../../global/apiPayload/requestBody.interceptor';
import { OriginGuard } from '../../global/apiPayload/origin.guard';
import { JwtGuard } from '../../global/auth/guard/jwt.guard';
import { writeErrorResponse } from '../../global/apiPayload/errors';
import { captureResponse, errorResponse } from './nativeResponseTestSupport';
import { createValidationPipe } from '../../global/apiPayload/validation.pipe';
import { ApiResponseInterceptor } from '../../global/apiPayload/apiResponse.interceptor';
import { type ExecutionContext, RequestMethod } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { AppError } from '../../global/apiPayload/errors';
import { GroupController } from '../../domain/group/controller/group.controller';
import { SettleController } from '../../domain/settle/controller/settle.controller';
import { HealthController } from '../../domain/health/controller/health.controller';

import { UserController } from '../../domain/user/controller/user.controller';

const validationPipe = createValidationPipe();
const bodyInterceptor = new RequestBodyInterceptor(new Reflector());
const originGuard = new OriginGuard(new Reflector());
const jwtGuard = new JwtGuard(testTokens);
const interceptor = new ApiResponseInterceptor(new Reflector());
// Test transport follows the actual Nest route and parameter decorators; no second API dispatch tree.
export async function dispatch(
  request: Request,
  _context: { params: Promise<{ path: string[] }> },
) {
  const controllers = await Promise.all(
    [UserController, GroupController, SettleController, HealthController].map(
      (type) => testProvider(type as new (...args: any[]) => object),
    ),
  );
  const pathname = new URL(request.url).pathname.slice(1);
  for (const controller of controllers)
    for (const name of Object.getOwnPropertyNames(
      Object.getPrototypeOf(controller),
    )) {
      const handler = (controller as unknown as Record<string, Function>)[name];
      if (typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      const method =
        RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
      if (
        path === undefined ||
        (method !== request.method &&
          !(request.method === 'HEAD' && method === 'GET'))
      )
        continue;
      const names: string[] = [];
      const match = new RegExp(
        '^' +
          [Reflect.getMetadata(PATH_METADATA, controller.constructor), path]
            .map((value) => String(value ?? '').replace(/^\/+|\/+$/g, ''))
            .filter(Boolean)
            .join('/')
            .replace(/:([^/]+)/g, (_, key) => {
              names.push(key);
              return '([^/]+)';
            }) +
          '$',
      ).exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        names.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
      );
      const bytes = request.body
        ? Buffer.from(await request.arrayBuffer())
        : null;
      const stream = Readable.from(bytes ? [bytes] : []);
      const url = new URL(request.url);
      const nodeRequest = Object.assign(stream, {
        originalUrl: url.pathname + url.search,
        protocol: url.protocol.slice(0, -1),
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          host: url.host,
          ...(bytes ? { 'content-length': String(bytes.length) } : {}),
        },
      }) as unknown as ExpressRequest;
      const headers = new Headers();
      const status = Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? 200;
      for (const { name, value } of Reflect.getMetadata(
        HEADERS_METADATA,
        handler,
      ) ?? [])
        headers.set(name, value);
      const captured = captureResponse(nodeRequest, headers, status);
      const response = captured.response;
      const metadata = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        controller.constructor,
        name,
      ) as Record<
        string,
        {
          index: number;
          data?: string;
          pipes: { transform(value: unknown): unknown }[];
          factory?: (data: unknown, context: ExecutionContext) => unknown;
        }
      >;
      const context = {
        getClass: () => controller.constructor,
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => nodeRequest,
          getResponse: () => response,
        }),
      } as unknown as ExecutionContext;
      try {
        cookieParser()(nodeRequest, response, () => {});
        jwtGuard.canActivate(context);
        originGuard.canActivate(context);
        await bodyInterceptor.intercept(context, {
          handle: () => defer(async () => undefined),
        });
        const output = await lastValueFrom(
          await interceptor.intercept(context, {
            handle: () =>
              defer(async () => {
                const args: unknown[] = [];
                for (const [key, argument] of Object.entries(metadata)) {
                  let value: unknown = argument.factory
                    ? argument.factory(argument.data, context)
                    : key.startsWith('0:')
                      ? nodeRequest
                      : key.startsWith('1:')
                        ? response
                        : key.startsWith('6:')
                          ? nodeRequest.headers[argument.data!]
                          : key.startsWith('3:')
                            ? nodeRequest.body
                            : key.startsWith('4:')
                              ? Object.fromEntries(url.searchParams)
                              : params[argument.data!];
                  if (key.startsWith('3:') || key.startsWith('4:')) {
                    const types = Reflect.getMetadata(
                      'design:paramtypes',
                      Object.getPrototypeOf(controller),
                      name,
                    );
                    if (!types?.[argument.index])
                      throw new Error(
                        'DTO metadata missing: use the SWC test runner',
                      );
                    value = await validationPipe.transform(value, {
                      type: key.startsWith('3:') ? 'body' : 'query',
                      metatype: types[argument.index],
                    });
                  }
                  for (const pipe of argument.pipes ?? [])
                    value = pipe.transform(value);
                  args[argument.index] = value;
                }
                return handler.apply(controller, args);
              }),
          }),
        );
        if (!captured.result) response.end(Buffer.from(JSON.stringify(output)));
      } catch (error) {
        writeErrorResponse(response, error);
      }

      return captured.result!;
    }
  return errorResponse(
    new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요'),
  );
}
export async function health(
  request: Request,
  _context: { params: Promise<{ check?: string[] }> },
) {
  return dispatch(request, {
    params: Promise.resolve({ path: [] }),
  });
}

export function getMeResponse(request: Request) {
  return dispatch(request, { params: Promise.resolve({ path: [] }) });
}
export function getBankAccountResponse(request: Request) {
  return dispatch(request, { params: Promise.resolve({ path: [] }) });
}
