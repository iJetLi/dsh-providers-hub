/**
 * Real Qoder Global + Qoder CN HungerG adapter smoke test.
 * Requires both explicit flags; sends one minimal free-model prompt per provider.
 * Reads existing DSH credentials without logging or changing them.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { fetchQoderRemoteModels, mergeQoderAppOnlyModels } from '../../src/qoder-catalog.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { qoderFetchForAccount, setQoderProxyPool } from '../../src/qoder-proxy.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const RUN = process.env.DSH_QODER_HUNGERG_E2E === '1'
  && process.env.DSH_QODER_HUNGERG_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip
const QUESTION = 'Reply exactly with the word OK.'
const TIMEOUT_MS = 180_000
const products = [{ product: QODER_CN, prefix: 'QODERCN' }, { product: QODER, prefix: 'QODER' }] as const

suite('Qoder / Qoder CN HungerG installed-adapter smoke test', () => {
  for (const { product, prefix } of products) {
    it(product.id + ': preserve CLI catalog and generate once via app-only HungerG', async () => {
      const entry = readQoderCredentialsFromDshStore({ refPrefix: prefix })[0]
      expect(entry?.credential.uid, 'no logged-in ' + product.displayName + ' account').toBeTruthy()
      expect(entry?.credential.machine_id).toBeTruthy()
      const state = JSON.parse(readFileSync(join(homedir(), '.dsh', 'jet-hub', 'state.json'), 'utf8')) as {
        accounts: Array<{ id: string; provider: string; credentialRef?: string; qoderProxy?: string }>
      }
      const account = state.accounts.find((row) => row.provider === product.id && row.credentialRef === entry.ref)
      const accountId = account?.id ?? ''
      setQoderProxyPool({ qoderProxyFor: (id) => state.accounts.find((row) => row.id === id)?.qoderProxy ?? '' })
      const fetchFor = (id: string) => qoderFetchForAccount(id)
      const fetcher = fetchFor(accountId)

      const cliModels = await fetchQoderRemoteModels(entry.credential, product, { fetcher, allowEmpty: true })
      expect(cliModels.some((model) => model.id === 'hmodel' || model.name.toLowerCase() === 'hungerg')).toBe(false)
      const appModels = await fetchQoderRemoteModels(entry.credential, product, {
        fetcher, metadata: product.appClientMetadata, allowEmpty: true,
      })
      const merged = mergeQoderAppOnlyModels(cliModels, appModels)
      const hmodel = merged.find((model) => model.id === 'hmodel')
      expect(hmodel, 'live app catalog did not return HungerG/hmodel').toBeDefined()
      expect(hmodel?.isFree).toBe(true)
      expect(hmodel?.priceFactor).toBe(0)
      expect(hmodel?.requiresAppIdentity).toBe(true)

      const adapter = new QoderAdapter({
        credentialRef: { name: prefix + '_ACCESS_TOKEN' },
        resolveCredential: async () => entry.credential,
        refresh: async () => {},
        product,
        fetchRemoteModels: async () => merged,
        fetchFor,
        currentAccountId: () => accountId,
        trafficGuardEnabled: () => false,
        warn: (message) => console.warn('[hungerG:' + product.id + '] ' + message),
      })
      const listed = await adapter.listModels(product.id)
      expect(listed.some((model) => model.id === 'hmodel' && model.isFree === true)).toBe(true)
      const chunks = []
      for await (const chunk of adapter.stream({
        model: 'hmodel',
        messages: [{ role: 'user', content: [{ type: 'text', text: QUESTION }] }],
        reasoningEffort: 'none',
        maxTokens: 64,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      } as never)) chunks.push(chunk)
      const output = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text ?? '').join('').trim()
      expect(output, 'HungerG returned no visible text; chunks=' + chunks.map((chunk) => chunk.type).join(',')).not.toBe('')
      console.log(JSON.stringify({ provider: product.id, model: 'hmodel', isFree: hmodel?.isFree, priceFactor: hmodel?.priceFactor, appIdentity: '10/app/app/app', reply: output.slice(0, 120), chunkCount: chunks.length }))
    }, TIMEOUT_MS + 30_000)
  }
})
