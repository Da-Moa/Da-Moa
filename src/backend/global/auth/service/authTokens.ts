export type AuthSession = {
  userId: string;
  purpose: 'app' | 'onboarding';
  accessToken: string;
  refreshToken: string;
  accessMaxAge: number;
  refreshMaxAge: number;
};
