'use client'

import { discardPendingRequest } from '../../global/util/apiClient'

export function discardBankAccountRequests() {
  discardPendingRequest('/api/me/bank-account', 'PUT')
  discardPendingRequest('/api/me/onboarding', 'POST')
}
