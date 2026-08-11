/// <reference types="vite/client" />

interface Window {
  config?: {
    appName?: string
    auth?: {
      supportedTypes?: {
        emailPassword?: boolean
        magicLink?: boolean
        otp?: boolean
        passkey?: boolean
      }
    }
    buildVersion?: string
    environment?: string
    supabase?: {
      url?: string
      publishableKey?: string
    }
  }
}
