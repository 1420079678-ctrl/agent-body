#!/usr/bin/env node
/**
 * Deterministic repository health check for this Agent-Body install.
 *
 * Zero dependencies, zero network, safe to run anywhere (CI, a fresh clone, the harness itself).
 * FAIL means the repository is malformed or a secret-hygiene guarantee was lost; WARN means
 * something worth a look that does not block a push. Exit code 1 if anything FAILed.
 *
 * Usage: node scripts/verify-repo.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ok = []
const warn = []
const fail = []
const OK = (m) => ok.push(m)
const WARN = (m) => warn.push(m)
const FAIL = (m) => fail.push(m)

const p = (...parts) => path.join(repoRoot, ...parts)
const exists = (rel) => fs.existsSync(p(rel))
const read = (rel) => fs.readFileSync(p(rel), 'utf8')

/** Directories never worth walking for a structure check. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', 'vendor', 'dist', '__pycache__',
  'logs', 'backup', 'browser-profile', '.playwright-cli', '.superpowers',
  'kernels', 'sec-lab', 'verification', 'profiles', 'IDA PRO', 'app',
])

function walk(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1, out)
    else out.push(full)
  }
  return out
}

// ── 1. Required repository files ──────────────────────────────────────────────
const REQUIRED = [
  'README.md',
  'README.zh-CN.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CITATION.cff',
  'package.json',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.nvmrc',
  '.env.example',
  '.github/CODEOWNERS',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/workflows/repo-check.yml',
  '.github/workflows/organ-regressions.yml',
  'scripts/verify-repo.mjs',
  'scripts/run-organ-regressions.mjs',
  'workspace/plugins/dsh-organism/package.json',
  'workspace/plugins/dsh-cortex/package.json',
  'workspace/plugins/dsh-zero-residence/package.json',
  'workspace/plugins/dsh-war-bridge/package.json',
  'workspace/plugins/dsh-web-crawl/package.json',
]

const missing = REQUIRED.filter((f) => !exists(f))
if (missing.length === 0) OK(`required repository files present (${REQUIRED.length})`)
else FAIL(`missing required files: ${missing.join(', ')}`)

// ── 2. Every package.json parses ──────────────────────────────────────────────
const packageFiles = [
  'package.json',
  ...fs
    .readdirSync(p('workspace/plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `workspace/plugins/${e.name}/package.json`)
    .filter((rel) => exists(rel)),
]

const badJson = []
const organs = []
for (const rel of packageFiles) {
  try {
    const pkg = JSON.parse(read(rel))
    if (rel.startsWith('workspace/plugins/')) organs.push({ rel, pkg })
  } catch (error) {
    badJson.push(`${rel} (${error.message})`)
  }
}
if (badJson.length === 0) OK(`${packageFiles.length} package.json file(s) parse`)
else FAIL(`unparsable package.json: ${badJson.join('; ')}`)

// ── 3. Organ structure and regression presence ────────────────────────────────
const organDir = p('workspace/plugins')
const organDirs = fs
  .readdirSync(organDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && exists(`workspace/plugins/${e.name}/package.json`))
  .map((e) => e.name)

const noSource = []
const noRegression = []
for (const name of organDirs) {
  // An organ may ship built output only (a linked third-party package), or source only.
  // Only the total absence of both is worth a warning.
  const hasSource = exists(`workspace/plugins/${name}/src/index.ts`)
  const hasBuilt = exists(`workspace/plugins/${name}/lib/index.js`)
  if (!hasSource && !hasBuilt) noSource.push(name)
  const scripts = exists(`workspace/plugins/${name}/scripts`)
    ? fs.readdirSync(p('workspace/plugins', name, 'scripts'))
    : []
  const hasRegression = scripts.some((f) => /^(smoke-test|selftest)/.test(f))
  if (!hasRegression) noRegression.push(name)
}
if (noSource.length === 0) OK(`${organDirs.length} organ(s) ship source or built output`)
else WARN(`organ(s) with neither src/index.ts nor lib/index.js: ${noSource.join(', ')}`)
const withRegression = organDirs.filter((n) => !noRegression.includes(n))
if (noRegression.length === 0) OK(`${organDirs.length} organ(s) carry an offline regression`)
else WARN(`offline regression present for ${withRegression.length}/${organDirs.length} organ(s); missing: ${noRegression.join(', ')}`)

// ── 4. Secret hygiene: the ignore rules must still protect live state ─────────
const ignore = exists('.gitignore') ? read('.gitignore') : ''
const missingGuards = []
if (!/^\s*data\/\s*$/m.test(ignore)) missingGuards.push('data/')
if (!/^\s*\.credentials\.yaml\s*$/m.test(ignore)) missingGuards.push('.credentials.yaml')
if (missingGuards.length === 0) OK('.gitignore still guards data/ and .credentials.yaml')
else FAIL(`.gitignore no longer ignores: ${missingGuards.join(', ')}`)

// ── 5. Cross-document links resolve ───────────────────────────────────────────
const docs = [
  'README.md',
  'README.zh-CN.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
].filter(exists)

const LINK_RE = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const brokenLinks = []
const brokenAnchors = []

const slugify = (title) =>
  title
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')

for (const doc of docs) {
  const body = read(doc)
  const localSlugs = new Set()
  for (const line of body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const slug = slugify(heading[2])
      localSlugs.add(slug)
      localSlugs.add(slug.replace(/^-/, ''))
    }
  }

  for (const match of body.matchAll(LINK_RE)) {
    const target = match[1]
    if (/^(https?:|mailto:|#?$)/.test(target)) {
      if (target.startsWith('#')) checkAnchor(doc, target.slice(1), localSlugs)
      continue
    }
    const [filePart, anchorPart] = target.split('#')
    if (filePart) {
      const resolved = path.resolve(p(doc, '..'), decodeURIComponent(filePart))
      if (!fs.existsSync(resolved)) brokenLinks.push(`${doc} -> ${filePart}`)
      else if (anchorPart) {
        const targetSlugs = new Set(
          fs
            .readFileSync(resolved, 'utf8')
            .split('\n')
            .map((l) => /^(#{1,6})\s+(.*)$/.exec(l))
            .filter(Boolean)
            .flatMap((m) => {
              const s = slugify(m[2])
              return [s, s.replace(/^-/, '')]
            }),
        )
        if (!targetSlugs.has(anchorPart.replace(/^-/, ''))) {
          brokenAnchors.push(`${doc} -> ${filePart}#${anchorPart}`)
        }
      }
    }
  }
}

function checkAnchor(doc, anchor, slugs) {
  if (!slugs.has(anchor) && !slugs.has(anchor.replace(/^-/, ''))) {
    brokenAnchors.push(`${doc} -> #${anchor}`)
  }
}

if (brokenLinks.length === 0) OK(`relative links in ${docs.length} document(s) resolve`)
else FAIL(`broken relative links: ${brokenLinks.slice(0, 12).join(', ')}`)

if (brokenAnchors.length === 0) OK('in-document anchors resolve')
else WARN(`anchors that may not resolve on GitHub: ${brokenAnchors.slice(0, 12).join(', ')}`)

// ── 6. Text files end with exactly one trailing newline ───────────────────────
const TEXT_TARGETS = [
  ...fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(md|json|ya?ml)$/.test(e.name))
    .map((e) => e.name),
  ...walk(p('.github')).filter((f) => /\.(md|ya?ml)$/.test(f)).map((f) => path.relative(repoRoot, f)),
]
const badEnding = []
for (const rel of new Set(TEXT_TARGETS)) {
  const body = read(rel)
  if (!body.endsWith('\n') || body.endsWith('\n\n')) badEnding.push(rel)
}
if (badEnding.length === 0) OK(`${new Set(TEXT_TARGETS).size} text file(s) end with one newline`)
else WARN(`trailing-newline issues: ${badEnding.slice(0, 10).join(', ')}`)

// ── 7. Workflows only reference scripts that exist ────────────────────────────
const workflowScriptRefs = []
for (const wf of ['repo-check.yml', 'organ-regressions.yml']) {
  const rel = `.github/workflows/${wf}`
  if (!exists(rel)) continue
  for (const match of read(rel).matchAll(/node\s+(scripts\/[\w.-]+)/g)) workflowScriptRefs.push(match[1])
  for (const match of read(rel).matchAll(/'?(workspace\/plugins\/[^\s'"]+)'?/g)) {
    const ref = match[1].replace(/\\/g, '/')
    if (!ref.includes('*') && !exists(ref)) workflowScriptRefs.push(ref)
  }
}
const missingRefs = [...new Set(workflowScriptRefs)].filter((rel) => !exists(rel))
if (missingRefs.length === 0) OK('workflow script references resolve')
else FAIL(`workflows reference missing paths: ${missingRefs.join(', ')}`)

// ── 8. Package scripts point at real files ────────────────────────────────────
const rootPkg = JSON.parse(read('package.json'))
const badScripts = []
for (const [name, cmd] of Object.entries(rootPkg.scripts ?? {})) {
  const fileRefs = [...cmd.matchAll(/(?:^|\s)((?:scripts|workspace)\/[\w./-]+)/g)].map((m) => m[1])
  for (const ref of fileRefs) {
    if (!fs.existsSync(p(ref))) badScripts.push(`${name} -> ${ref}`)
  }
}
if (badScripts.length === 0) OK(`npm scripts reference real files (${Object.keys(rootPkg.scripts ?? {}).length} script(s))`)
else FAIL(`npm scripts reference missing files: ${badScripts.join(', ')}`)

// ── 9. Licence and changelog sanity ───────────────────────────────────────────
if (exists('LICENSE') && /MIT License/.test(read('LICENSE'))) OK('LICENSE is MIT')
else FAIL('LICENSE missing or not MIT')

if (exists('CHANGELOG.md') && /^## \[Unreleased\]/m.test(read('CHANGELOG.md'))) OK('CHANGELOG keeps an Unreleased section')
else WARN('CHANGELOG.md has no [Unreleased] section')

// ── Report ────────────────────────────────────────────────────────────────────
const line = '-'.repeat(72)
console.log(`\nAgent-Body repository health check\n${line}`)
for (const m of ok) console.log(`  OK   ${m}`)
for (const m of warn) console.log(`  WARN ${m}`)
for (const m of fail) console.log(`  FAIL ${m}`)
console.log(line)
console.log(`  ${ok.length} ok · ${warn.length} warning(s) · ${fail.length} failure(s)\n`)

process.exit(fail.length > 0 ? 1 : 0)
