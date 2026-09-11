import fs from 'node:fs'
const corpus = JSON.parse(fs.readFileSync('benchmarks/corpus/tools.json', 'utf8')).tools
const names = new Set(corpus.map((t) => t.name))
const expect = [
  'web_search', 'web_fetch', 'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'read_image',
  'subagent', 'todo_write', 'create_goal', 'skill', 'checkpoint', 'job_output', 'market_search',
  'sec_webscan', 'sec_webtest', 'quant_sma', 'quant_risk', 'mirofish_status',
  '_dsh_external_dsh_browser_ultimate_snap', '_dsh_external_dsh_office_docs_convert',
  '_dsh_external_dsh_office_docs_xlsx', 'social_card_render', 'ida', 'rev_route', 'ars_pipeline',
]
console.log('corpus size', names.size)
for (const e of expect) console.log((names.has(e) ? '  IN  ' : '  OUT ') + e)
const pref = {}
for (const t of corpus) {
  const p = t.name.split('_')[0]
  pref[p] = (pref[p] || 0) + 1
}
console.log('--- top prefixes ---')
console.log(Object.entries(pref).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}:${v}`).join(' '))
