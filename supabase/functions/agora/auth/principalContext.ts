export type PrincipalContext = {
  kind: 'agent' | 'human'
  principalId: string
}

type DatabaseResult = {
  data: unknown
  error: unknown
}

type RlsRpcClient = {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<DatabaseResult>
}

export type PrincipalDatabase = Pick<RlsRpcClient, 'rpc'>

export type AuthorizedPrincipalContext = {
  database: PrincipalDatabase
  principal: PrincipalContext
}

export const createPrincipalDatabase = (client: RlsRpcClient): PrincipalDatabase => Object.freeze({
  rpc: (name: string, params?: Record<string, unknown>) => client.rpc(name, params)
})
