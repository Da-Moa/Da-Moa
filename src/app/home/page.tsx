import { renderAuthenticatedHome } from './authenticated-home'

export default async function HomePage() {
  return renderAuthenticatedHome('home')
}
