import type { Page } from '@playwright/test'
import { deleteSupabaseUsersByEmail } from './supabaseTestAuth'

export const createVisualAccount = async (page: Page, createdEmails: Set<string>, label: string) => {
  const email = `agora.${label}@visual-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`
  createdEmails.add(email)

  await page.goto('/sign-in')
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create account' }).click()

  return email
}

export const cleanupVisualAccounts = async (createdEmails: Set<string>) => {
  const emails = [...createdEmails]
  await deleteSupabaseUsersByEmail(emails)
  emails.forEach((email) => createdEmails.delete(email))
}
