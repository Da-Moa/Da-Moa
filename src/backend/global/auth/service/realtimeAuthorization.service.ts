import { Inject, Injectable } from '@nestjs/common';
import { TokenService } from './token.service';
import { RealtimeUserRepository } from '../../../domain/user/native';

@Injectable()
export class RealtimeAuthorizationService {
  constructor(
    @Inject(RealtimeUserRepository)
    private readonly accounts: RealtimeUserRepository,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}
  async authenticate(token: string | null) {
    const access = this.tokens.verifyAccessToken(token ?? undefined);
    if (!access) return { status: 401 };
    if ((access.purpose ?? 'app') !== 'app') return { status: 403 };
    const account = await this.accounts.findState(access.userId);
    if (!account || account.deleted_at !== null) return { status: 401 };
    return account.onboarding_completed_at !== null
      ? { status: 200, id: account.id }
      : { status: 403 };
  }
}
