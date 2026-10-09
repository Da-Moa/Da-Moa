import { ApiProperty, PickType } from '@nestjs/swagger';

export type HealthCheck = 'application' | 'database' | 'minio' | 'worker';
export type HealthStatus = 'ok' | 'down';
export class HealthResponseDTO {
  @ApiProperty({ enum: ['ok', 'down'] })
  status!: HealthStatus;
  checks!: Partial<Record<HealthCheck, HealthStatus>>;
}
class HealthChecksDTO {
  @ApiProperty({ enum: ['ok'] })
  application!: 'ok';
  @ApiProperty({ enum: ['ok', 'down'] })
  database!: HealthStatus;
  @ApiProperty({ enum: ['ok', 'down'] })
  minio!: HealthStatus;
  @ApiProperty({ enum: ['ok', 'down'] })
  worker!: HealthStatus;
}

class OverallChecksDTO extends PickType(HealthChecksDTO, [
  'application',
  'database',
  'minio',
] as const) {}
export class OverallHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ type: OverallChecksDTO })
  declare checks: OverallChecksDTO;
}

class LiveChecksDTO extends PickType(HealthChecksDTO, [
  'application',
] as const) {}
export class LiveHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ required: true, enum: ['ok'] })
  declare status: 'ok';
  @ApiProperty({ type: LiveChecksDTO })
  declare checks: LiveChecksDTO;
}

class DatabaseChecksDTO extends PickType(HealthChecksDTO, [
  'database',
] as const) {}
export class DatabaseHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ type: DatabaseChecksDTO })
  declare checks: DatabaseChecksDTO;
}

class MinioChecksDTO extends PickType(HealthChecksDTO, ['minio'] as const) {}
export class MinioHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ type: MinioChecksDTO })
  declare checks: MinioChecksDTO;
}

class DependenciesChecksDTO extends PickType(HealthChecksDTO, [
  'database',
  'minio',
] as const) {}
export class DependenciesHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ type: DependenciesChecksDTO })
  declare checks: DependenciesChecksDTO;
}

class WorkerChecksDTO extends PickType(HealthChecksDTO, ['worker'] as const) {}
export class WorkerHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ type: WorkerChecksDTO })
  declare checks: WorkerChecksDTO;
}

class WorkerReadyChecksDTO extends PickType(HealthChecksDTO, [
  'worker',
  'database',
  'minio',
] as const) {}
export class WorkerReadyHealthResponseDTO extends HealthResponseDTO {
  @ApiProperty({ type: WorkerReadyChecksDTO })
  declare checks: WorkerReadyChecksDTO;
}
