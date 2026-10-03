'use client'

import { discardPendingRequest } from '../../../lib/api-client'

export function discardBankAccountRequests() {
  discardPendingRequest('/api/me/bank-account', 'PUT')
  discardPendingRequest('/api/me/onboarding', 'POST')
}
