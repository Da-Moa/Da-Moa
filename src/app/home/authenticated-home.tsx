import HomeClient from './home-client'

export type HomeTab = 'home' | 'groups' | 'history' | 'all'

export function renderAuthenticatedHome(tab: HomeTab) {
  return <HomeClient tab={tab} />
}
