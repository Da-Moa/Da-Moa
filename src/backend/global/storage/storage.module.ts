import { Module } from '@nestjs/common';
import { ReceiptStorage } from '../util/minio.util';

@Module({ providers: [ReceiptStorage], exports: [ReceiptStorage] })
export class StorageModule {}
