'use client'

const accessTokenKey = 'da_moa_access'
export const getAccessToken = () => window.localStorage.getItem(accessTokenKey)
export const setAccessToken = (token: string) => window.localStorage.setItem(accessTokenKey, token)
export const clearAccessToken = () => window.localStorage.removeItem(accessTokenKey)
