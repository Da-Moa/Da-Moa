import { Module } from '@nestjs/common';
import { RealtimePublisher } from '../../util/invalidationUtil';

@Module({ providers: [RealtimePublisher], exports: [RealtimePublisher] })
export class RealtimeModule {}
