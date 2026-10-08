import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response as ServerResponse } from 'express';
import { RawApiResponse } from '../../../global/apiPayload/apiResponse.interceptor';
import { HealthService } from '../service/health.service';

@RawApiResponse()
@Controller('api/health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}

  @Get('')
  @Header('Cache-Control', 'no-store')
  async overall(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkOverall();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('live')
  @Header('Cache-Control', 'no-store')
  async live(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkLive();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('database')
  @Header('Cache-Control', 'no-store')
  async database(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkDatabase();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('minio')
  @Header('Cache-Control', 'no-store')
  async minio(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkMinio();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('dependencies')
  @Header('Cache-Control', 'no-store')
  async dependencies(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkDependencies();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('worker')
  @Header('Cache-Control', 'no-store')
  async worker(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkWorker();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('worker/readyz')
  @Header('Cache-Control', 'no-store')
  async workerReady(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkWorkerReady();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}
