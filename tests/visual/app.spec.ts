import { expect, test } from '@playwright/test'
import { routeRuntimeConfig } from './runtimeConfig'
import { deleteSupabaseUsersByEmail } from './supabaseTestAuth'

const createdUserEmails = new Set<string>()

const createAccount = async (page: import('@playwright/test').Page) => {
  const email = `agora.user@visual-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`
  createdUserEmails.add(email)

  await page.goto('/')
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create account' }).click()

  return email
}

test.beforeEach(async ({ page }) => {
  await routeRuntimeConfig(page)
})

test.afterEach(async () => {
  const emails = [...createdUserEmails]
  createdUserEmails.clear()
  await deleteSupabaseUsersByEmail(emails)
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

test('protects app routes until the user signs in', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
})

test('shows the empty authenticated shell after account creation', async ({ page }) => {
  const email = await createAccount(page)

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Welcome to Agora' })).toBeVisible()
  await expect(page.getByText('Your account is ready.')).toBeVisible()
  await expect(page.getByRole('link', { name: `Open profile for ${email}` })).toBeVisible()
})
