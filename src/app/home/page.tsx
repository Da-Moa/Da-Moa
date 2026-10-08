import { renderAuthenticatedHome } from '../../frontend/page/home/authenticatedHome'

export default async function HomePage() {
  return renderAuthenticatedHome('home')
}
