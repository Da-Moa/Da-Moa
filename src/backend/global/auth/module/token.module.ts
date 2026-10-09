import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { getSessionSecret } from '../authConfig';
import { TokenService } from '../service/token.service';

@Module({
  // Resolve lazily as before: health/bootstrap can start without an auth key,
  // while every sign/verify call uses the current configured secret.
  imports: [JwtModule.register({ secretOrKeyProvider: getSessionSecret })],
  providers: [TokenService],
  exports: [TokenService],
})
export class TokenModule {}
