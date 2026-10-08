import { Module } from '@nestjs/common';
import { HealthController } from '../controller/health.controller';
import { HealthService } from '../service/health.service';
import { HealthRepository } from '../repository/health.repository';
import { PrismaModule } from '../../../global/database/prisma.module';
@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [HealthService, HealthRepository],
})
export class HealthModule {}
