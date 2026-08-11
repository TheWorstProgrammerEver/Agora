import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createLocalAdminClient,
  findSupabaseUsersByEmail
} from '../../visual/supabaseTestAuth'

const localStatus = {
  API_URL: 'http://127.0.0.1:54321',
  SERVICE_ROLE_KEY: 'example-local-admin-value'
}

describe('visual Supabase admin cleanup', () => {
  it('rejects a hosted admin target before constructing a client', () => {
    const clientFactory = vi.fn(() => ({} as SupabaseClient))

    expect(() => createLocalAdminClient(
      'http://127.0.0.1:54321',
      {
        ...localStatus,
        API_URL: 'https://example-project.supabase.co'
      },
      clientFactory
    )).toThrow('explicit local HTTP loopback origin')

    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('rejects mismatched browser and admin origins', () => {
    const clientFactory = vi.fn(() => ({} as SupabaseClient))

    expect(() => createLocalAdminClient(
      'http://localhost:54321',
      localStatus,
      clientFactory
    )).toThrow('origins must match exactly')

    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('finds a test account on a later page', async () => {
    const listUsers = vi.fn(async ({ page }: { page: number }) => page === 1
      ? {
          data: { nextPage: 2, users: [{ email: 'someone@example.test', id: 'first' }] },
          error: null
        }
      : {
          data: { nextPage: null, users: [{ email: 'target@example.test', id: 'target' }] },
          error: null
        })

    await expect(findSupabaseUsersByEmail(
      listUsers,
      ['target@example.test'],
      { pageSize: 50 }
    )).resolves.toEqual([{ email: 'target@example.test', id: 'target' }])

    expect(listUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 50 })
    expect(listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 50 })
  })

  it('rejects no-progress pagination', async () => {
    const listUsers = vi.fn(async () => ({
      data: { nextPage: 1, users: [] },
      error: null
    }))

    await expect(findSupabaseUsersByEmail(
      listUsers,
      ['target@example.test']
    )).rejects.toThrow('did not advance safely')
  })

  it('rejects missing pagination metadata', async () => {
    const listUsers = vi.fn(async () => ({
      data: { users: [] },
      error: null
    }))

    await expect(findSupabaseUsersByEmail(
      listUsers,
      ['target@example.test']
    )).rejects.toThrow('did not advance safely')
  })
})
