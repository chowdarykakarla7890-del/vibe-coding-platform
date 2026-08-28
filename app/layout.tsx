import { Toaster } from '@/components/ui/sonner'
import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { connection } from 'next/server'
import './globals.css'

const title = 'CodeTutor Studio — Learn by Building'
const description = `An AI coding tutor with editable sandbox projects, step-by-step lessons, live previews, a real terminal, tests, and evidence-based code assessment.`

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    images: [
      {
        url: 'https://assets.vercel.com/image/upload/v1754588799/OSSvibecodingplatform/OG.png',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    images: [
      {
        url: 'https://assets.vercel.com/image/upload/v1754588799/OSSvibecodingplatform/OG.png',
      },
    ],
  },
}

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // A per-request nonce must never be baked into a statically rendered shell.
  await connection()
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
