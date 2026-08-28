import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

export function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  // Public, versioned editor code contains no user data and must not depend on
  // an auth refresh (or redirect a worker/script request into a sign-in page).
  matcher: ['/((?!api|_next/static|_next/image|vendor/monaco/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
