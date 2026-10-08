import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response as ServerResponse } from 'express';
import { sendResponse } from '../../../global/apiPayload/httpContext';
import type {
  HealthRequestDTO,
  HealthScope,
} from '../dto/res/health.response.dto';
import {
  HealthService,
  checkHealth,
  type HealthProbes,
} from '../service/health.service';

export async function getHealthResponse(
  check?: string[],
  probes?: HealthProbes,
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  const scope = check?.join('/') || 'overall';
  if (
    ![
      'overall',
      'live',
      'database',
      'minio',
      'dependencies',
      'worker',
      'worker/readyz',
    ].includes(scope) ||
    (scope === 'overall' && check?.length)
  ) {
    return Response.json({ error: 'not_found' }, { status: 404, headers });
  }
  const request: HealthRequestDTO = { scope: scope as HealthScope };
  const result = await checkHealth(request, probes);
  return Response.json(result, {
    status: result.status === 'ok' ? 200 : 503,
    headers,
  });
}

@Controller('api/health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}
  @Get('')
  overall(@Res() response: ServerResponse) {
    return this.respond(response, 'overall');
  }
  @Get('live')
  live(@Res() response: ServerResponse) {
    return this.respond(response, 'live');
  }
  @Get('database')
  database(@Res() response: ServerResponse) {
    return this.respond(response, 'database');
  }
  @Get('minio')
  minio(@Res() response: ServerResponse) {
    return this.respond(response, 'minio');
  }
  @Get('dependencies')
  dependencies(@Res() response: ServerResponse) {
    return this.respond(response, 'dependencies');
  }
  @Get('worker')
  worker(@Res() response: ServerResponse) {
    return this.respond(response, 'worker');
  }
  @Get('worker/readyz')
  workerReady(@Res() response: ServerResponse) {
    return this.respond(response, 'worker/readyz');
  }
  private respond(response: ServerResponse, scope: HealthScope) {
    return sendResponse(response, async () => {
      const result = await this.service.checkHealth({ scope });
      return Response.json(result, {
        status: result.status === 'ok' ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    });
  }
}
