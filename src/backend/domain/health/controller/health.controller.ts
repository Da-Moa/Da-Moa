import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  OverallHealthResponseDTO,
  LiveHealthResponseDTO,
  DatabaseHealthResponseDTO,
  MinioHealthResponseDTO,
  DependenciesHealthResponseDTO,
  WorkerHealthResponseDTO,
  WorkerReadyHealthResponseDTO,
} from '../dto/res/health.response.dto';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response as ServerResponse } from 'express';
import { RawApiResponse } from '../../../global/apiPayload/apiResponse.interceptor';
import { HealthService } from '../service/health.service';

@ApiTags('상태')
@RawApiResponse()
@Controller('api/health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}

  @Get('')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '전체 상태 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: OverallHealthResponseDTO,
  })
  @ApiResponse({
    status: 503,
    description: '하나 이상의 의존 서비스 장애',
    type: OverallHealthResponseDTO,
  })
  async overall(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkOverall();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '애플리케이션 응답 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: LiveHealthResponseDTO,
  })
  async live(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkLive();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('database')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PostgreSQL 연결 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: DatabaseHealthResponseDTO,
  })
  @ApiResponse({
    status: 503,
    description: '하나 이상의 의존 서비스 장애',
    type: DatabaseHealthResponseDTO,
  })
  async database(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkDatabase();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('minio')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'MinIO 저장소 읽기·쓰기 상태 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: MinioHealthResponseDTO,
  })
  @ApiResponse({
    status: 503,
    description: '하나 이상의 의존 서비스 장애',
    type: MinioHealthResponseDTO,
  })
  async minio(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkMinio();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('dependencies')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PostgreSQL·MinIO 저장소 읽기·쓰기 상태 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: DependenciesHealthResponseDTO,
  })
  @ApiResponse({
    status: 503,
    description: '하나 이상의 의존 서비스 장애',
    type: DependenciesHealthResponseDTO,
  })
  async dependencies(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkDependencies();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('worker')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '영수증 워커 실행 상태 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: WorkerHealthResponseDTO,
  })
  @ApiResponse({
    status: 503,
    description: '하나 이상의 의존 서비스 장애',
    type: WorkerHealthResponseDTO,
  })
  async worker(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkWorker();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('worker/readyz')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '영수증 워커 큐 조회·PostgreSQL·MinIO 처리 준비 상태 확인',
    description:
      '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description: '모든 검사 정상',
    type: WorkerReadyHealthResponseDTO,
  })
  @ApiResponse({
    status: 503,
    description: '하나 이상의 의존 서비스 장애',
    type: WorkerReadyHealthResponseDTO,
  })
  async workerReady(@Res({ passthrough: true }) response: ServerResponse) {
    const result = await this.service.checkWorkerReady();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}
