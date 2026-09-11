import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HOMEOSTASIS_EXPORT_REQUIREMENTS,
  LIFECYCLE_HOOKS,
  ORGAN_MANIFEST_SCHEMA,
  ORGAN_TIERS,
  PERMISSION_KINDS,
  TIER_POLICY,
  defaultInstallSet,
  validateOrganManifest,
} from '../src/index.mjs'

const valid = {
  id: 'eyes',
  label: '眼睛（网页抓取）',
  tier: 'general',
  group: 'sensory',
  purpose: '把网页变成可判断的文本',
  capabilities: ['webcrawl', 'webcrawl_*'],
  permissions: ['net:http', 'fs:write'],
  sdkVersion: '^0.1.0',
  signals: ['tools/result'],
  handles: ['network', 'timeout'],
}

test('validateOrganManifest: 合法清单通过', () => {
  const r = validateOrganManifest(valid)
  assert.deepEqual(r.errors, [])
  assert.ok(r.ok)
})

test('validateOrganManifest: 缺字段 / 未知字段 / 非法枚举都被拒', () => {
  assert.ok(!validateOrganManifest({ ...valid, id: undefined }).ok, '缺 id')
  assert.ok(!validateOrganManifest({ ...valid, purpose: undefined }).ok, '缺 purpose')
  assert.ok(!validateOrganManifest({ ...valid, extra: 1 }).ok, '未知字段')
  assert.ok(!validateOrganManifest({ ...valid, id: 'Bad-Id' }).ok, 'id 格式')
  assert.ok(!validateOrganManifest({ ...valid, tier: 'whatever' }).ok, '未知分级')
  assert.ok(!validateOrganManifest({ ...valid, group: 'nowhere' }).ok, '未知系统')
  assert.ok(!validateOrganManifest({ ...valid, capabilities: [] }).ok, '空能力')
  assert.ok(!validateOrganManifest({ ...valid, permissions: ['net:telepathy'] }).ok, '未声明的权限')
  assert.ok(!validateOrganManifest({ ...valid, sdkVersion: 'latest' }).ok, '非 semver')
})

test('validateOrganManifest: 高风险权限的额外约束', () => {
  const risky = { ...valid, capabilities: ['ida'], permissions: ['exec:process'], tier: 'professional' }
  delete risky.handles
  const r = validateOrganManifest(risky)
  assert.ok(!r.ok)
  assert.ok(r.errors.some((e) => e.path === 'handles'), '高风险器官必须声明处置的病因')

  const asCore = { ...valid, permissions: ['exec:process'], tier: 'core' }
  assert.ok(!validateOrganManifest(asCore).ok, '高风险权限不得标 core')
})

test('defaultInstallSet: 默认只装 core + general', () => {
  const manifests = ORGAN_TIERS.map((tier, i) => ({ ...valid, id: `organ_${i}`, tier }))
  const set = defaultInstallSet(manifests)
  assert.deepEqual(set, ['organ_0', 'organ_1'])
  assert.deepEqual(set, manifests.filter((m) => TIER_POLICY[m.tier].defaultInstall).map((m) => m.id))
})

test('契约自描述：分级/权限/钩子/稳态要求都不为空且是四类分级', () => {
  assert.deepEqual([...ORGAN_TIERS], ['core', 'general', 'professional', 'experimental'])
  for (const t of ORGAN_TIERS) assert.ok(TIER_POLICY[t].description.length > 10)
  assert.ok(Object.keys(PERMISSION_KINDS).length >= 8)
  assert.ok(Object.keys(LIFECYCLE_HOOKS).length >= 6)
  assert.equal(HOMEOSTASIS_EXPORT_REQUIREMENTS.length, 4)
  assert.equal(ORGAN_MANIFEST_SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema')
})
