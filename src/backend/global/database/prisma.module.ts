import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MutationRepository } from './mutation.repository';
@Global()
@Module({
  providers: [PrismaService, MutationRepository],
  exports: [PrismaService, MutationRepository],
})
export class PrismaModule {}
