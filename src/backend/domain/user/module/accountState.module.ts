import { Module } from '@nestjs/common';
import { AccountStateRepository } from '../repository/accountState.repository';

@Module({
  providers: [AccountStateRepository],
  exports: [AccountStateRepository],
})
export class AccountStateModule {}
