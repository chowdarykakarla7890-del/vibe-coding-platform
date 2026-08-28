import type { NextConfig } from 'next'
import { withBotId } from 'botid/next/config'
import { assertDeploymentEnvironment } from './lib/deployment/environment'
import { securityHeaders } from './lib/security-headers'

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

export default withBotId(nextConfig)
