import { expect, test } from '@playwright/test'
import { routeRuntimeConfig } from './runtimeConfig'
import { cleanupVisualAccounts, createVisualAccount } from './visualAccount'

const createdUserEmails = new Set<string>()

const createAccount = (page: import('@playwright/test').Page) => (
  createVisualAccount(page, createdUserEmails, 'user')
)

test.beforeEach(async ({ page }) => {
  await routeRuntimeConfig(page)
})

test.afterEach(async () => {
  await cleanupVisualAccounts(createdUserEmails)
})

test('renders configured authentication methods', async ({ page }) => {
  await page.goto('/sign-in')

  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Password/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Magic link/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /One-time code/ })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /One-time code/ }).click()
  await expect(page.getByLabel('Password', { exact: true })).not.toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible()

  await page.getByRole('button', { name: /Magic link/ }).click()
  await expect(page.getByLabel('Password', { exact: true })).not.toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Send magic link' })).toBeVisible()

  await page.getByRole('button', { name: 'Create an account' }).click()
  await expect(page.getByRole('heading', { name: 'Create Account' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Password/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Magic link/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /One-time code/ })).toBeVisible()

  await page.getByRole('button', { name: /One-time code/ }).click()
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible()

  await page.getByRole('button', { name: /Magic link/ }).click()
  await expect(page.getByRole('button', { name: 'Send magic link' })).toBeVisible()

  await page.getByRole('button', { name: /Password/ }).click()
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).not.toBeVisible()
})

test('keeps explicitly disabled auth capabilities unavailable', async ({ page }) => {
  await routeRuntimeConfig(page, {
    publicSignup: false,
    supportedTypes: {
      emailPassword: false,
      magicLink: false,
      otp: false,
      passkey: false
    }
  })
  await page.goto('/sign-in')

  await expect(page.getByRole('alert')).toHaveText('No authentication methods are enabled.')
  await expect(page.getByRole('button', { name: 'Create an account' })).not.toBeVisible()
})

test('routes enabled passwordless methods through signup-aware auth state', async ({ page }) => {
  const otpRequests: { body: { create_user?: boolean }; url: string }[] = []

  await page.route('**/auth/v1/otp*', (route) => {
    otpRequests.push({
      body: JSON.parse(route.request().postData() ?? '{}') as { create_user?: boolean },
      url: route.request().url()
    })

    return route.fulfill({ body: '{}', contentType: 'application/json', status: 200 })
  })
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email', { exact: true }).fill('passwordless@example.test')
  await page.getByRole('button', { name: /One-time code/ }).click()
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect.poll(() => otpRequests.length).toBe(1)

  await page.getByRole('button', { name: /Magic link/ }).click()
  await page.getByRole('button', { name: 'Send magic link' }).click()
  await expect.poll(() => otpRequests.length).toBe(2)

  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: /One-time code/ }).click()
  await page.getByLabel('Email', { exact: true }).fill('existing@example.test')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect.poll(() => otpRequests.length).toBe(3)

  expect(otpRequests.map((request) => request.body.create_user)).toEqual([true, true, false])
  expect(otpRequests[0].url).not.toContain('redirect_to=')
  expect(otpRequests[1].url).toContain('redirect_to=')
})

test('reports backend-disabled public signup without authenticating', async ({ page }) => {
  await page.route('**/auth/v1/signup*', (route) => route.fulfill({
    body: JSON.stringify({
      error_code: 'signup_disabled',
      msg: 'Signups not allowed for this instance'
    }),
    contentType: 'application/json',
    status: 422
  }))
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email', { exact: true }).fill('disabled-signup@example.test')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByRole('alert')).toHaveText('Account creation is disabled.')
  await expect(page).toHaveURL(/\/sign-in$/)
})

test('protects app routes until the user signs in', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
})

test('shows the empty authenticated group state after account creation', async ({ page }) => {
  const email = await createAccount(page)

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible()
  await expect(page.getByText('You do not belong to any groups yet.')).toBeVisible()
  await expect(page.getByRole('link', { name: `Open profile for ${email}` })).toBeVisible()
})

test('hides passkey account controls when the capability is disabled', async ({ page }) => {
  await routeRuntimeConfig(page, {
    supportedTypes: {
      emailPassword: true,
      magicLink: false,
      otp: false,
      passkey: false
    }
  })
  await createAccount(page)
  await page.getByRole('link', { name: /Open profile for/ }).click()

  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Passkeys' })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Add passkey' })).not.toBeVisible()
})
