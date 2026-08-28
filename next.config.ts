import type { NextConfig } from 'next'
import { withBotId } from 'botid/next/config'
import { assertDeploymentEnvironment } from './lib/deployment/environment'
import { securityHeaders } from './lib/security-headers'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants'
import { prepareMonaco } from './scripts/prepare-monaco.mjs'

assertDeploymentEnvironment(process.env, process.versions.node)

const nextConfig: NextConfig = {
  headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/playground',
        permanent: false,
      },
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'vercel.com',
        port: '',
        pathname: '/api/www/avatar/**',
      },
    ],
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
}

export default function config(phase: string) {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_BUILD) prepareMonaco()
  return withBotId(nextConfig)
}
