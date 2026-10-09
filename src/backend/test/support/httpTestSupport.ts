import { testApplication } from './domainTestSupport';
import { injectMockRequest } from './mockHttpTestSupport';

// Request metadata and the complete pipeline are interpreted by Nest itself.
export async function dispatch(request: Request, _context?: unknown) {
  return injectMockRequest(await testApplication(), request);
}
export const health = dispatch;
export const getMeResponse = dispatch;
export const getBankAccountResponse = dispatch;
