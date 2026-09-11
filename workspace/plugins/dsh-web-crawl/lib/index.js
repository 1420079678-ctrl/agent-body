/**
 * @dsh-external/dsh-web-crawl — 2026 多引擎网页抓取工具包。
 *
 * 取代 dsh-crawl4ai（crawl4ai 0.9.x，2024 年的引擎）。技术换代点：
 *
 *   - 抽取层：trafilatura 2.2（boilerplate 去除标杆，评测优于 readability/justext）
 *     为主，justext 做 rescue，bs4 兜底 → 不再依赖 crawl4ai 自带启发式。
 *   - 渲染层：Patchright（打过补丁的 Playwright，消除 Playwright/CDP 自动化指纹）
 *     驱动本机 Chrome；不可用时自动退回原版 Playwright。
 *   - 级联：L0 静态抓取 → 判定「空壳/挑战页」才升 L1 浏览器 → 可选 L2 Jina Reader
 *     托管兜底。不是「一律渲染」也不是「一律静态」。
 *   - 文档层：markitdown 统一 PDF/DOCX/PPTX/XLSX/EPUB/HTML → Markdown。
 *   - 结构化层：CSS schema 本地提取，零模型调用。
 *
 * 进程模型沿用经过验证的那套：常驻 Python worker（行协议 JSON-RPC over stdio），
 * 浏览器实例跨请求复用，exec.signal 一停就 taskkill 掉整棵进程树，空闲自动回收。
 *
 * @module @dsh-external/dsh-web-crawl
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from 'schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = '@dsh-external/dsh-web-crawl';
export const inject = ['tools'];
export const Config = z.object({
    pythonPath: z.string().default('python'),
    timeoutSeconds: z.number().min(5).default(90),
    idleShutdownMs: z.number().min(10_000).default(300_000),
    vendorDir: z.string().default(''),
    browserChannel: z.string().default('chrome'),
    proxy: z.string().default(''),
    readerFallback: z.boolean().default(false),
    registerAsFetchProvider: z.boolean().default(false),
});
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(PLUGIN_DIR, 'webcrawl_worker.py');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
let requestSeq = 0;
/**
 * 管理 Python worker 子进程：状态机 idle/spawning/ready/dead，
 * 按请求 id 匹配响应，超时兜底，崩溃后自动重建，空闲超时回收。
 */
class CrawlWorker {
    child = null;
    rl = null;
    pending = new Map();
    state = 'idle';
    pythonPath;
    timeoutMs;
    idleShutdownMs;
    env;
    idleTimer = null;
    disposed = false;
    /** 冷启动标志：spawn 后首个请求（含浏览器预热）超时放宽 3 倍，避免误杀。 */
    coldStart = true;
    /** 最近一次 spawn 的 stderr 尾巴（诊断用）。 */
    spawnErrTail = '';
    /** spawn 代数：代际守卫，防旧 worker 晚到的事件污染新 worker。 */
    gen = 0;
    constructor(pythonPath, timeoutMs, idleShutdownMs, env) {
        this.pythonPath = pythonPath;
        this.timeoutMs = timeoutMs;
        this.idleShutdownMs = idleShutdownMs;
        this.env = env;
    }
    /**
     * 发起一次请求；worker 未就绪时先拉起。超时后强制回收 worker。
     * @param signal - 调用方取消信号：中止即强杀 worker 进程树（python + chrome 连带）。
     */
    async call(cmd, args, signal) {
        if (this.disposed)
            throw new Error('webcrawl worker is disposed');
        if (signal?.aborted)
            throw new Error(`webcrawl ${cmd} aborted before start`);
        await this.ensureReady(signal);
        if (signal?.aborted) {
            this.killWorker();
            throw new Error(`webcrawl ${cmd} aborted during startup`);
        }
        this.armIdleTimer();
        const id = String(++requestSeq);
        const effectiveTimeout = this.coldStart ? this.timeoutMs * 3 : this.timeoutMs;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                this.pending.delete(id);
                this.killWorker();
                cleanup();
                reject(new Error(`webcrawl ${cmd} aborted by caller (worker tree terminated)`));
            };
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const note = this.coldStart ? ' (cold start: browser warm-up may exceed the base timeout)' : '';
                this.killWorker();
                cleanup();
                reject(new Error(`webcrawl ${cmd} timed out after ${effectiveTimeout}ms${note}`));
            }, effectiveTimeout);
            this.pending.set(id, {
                resolve: (data) => { cleanup(); resolve(data); },
                reject: (error) => { cleanup(); reject(error); },
                timer,
            });
            signal?.addEventListener('abort', onAbort, { once: true });
            this.child?.stdin?.write(JSON.stringify({ id, cmd, args }) + '\n');
        });
    }
    /** 强制回收 worker 进程树（Windows 下连带子进程，避免 chrome 残留）。 */
    killWorker() {
        const child = this.child;
        this.child = null;
        this.rl = null;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        for (const [, call] of this.pending) {
            clearTimeout(call.timer);
            call.reject(new Error('webcrawl worker recycled'));
        }
        this.pending.clear();
        if (child && !child.killed) {
            if (process.platform === 'win32' && child.pid) {
                try {
                    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    killer.unref();
                }
                catch {
                    child.kill();
                }
            }
            else {
                child.kill('SIGKILL');
            }
        }
        this.state = 'idle';
        this.coldStart = true;
    }
    async ensureReady(signal) {
        if (signal?.aborted)
            throw new Error('webcrawl worker startup aborted before spawn');
        if (this.state === 'ready')
            return;
        if (this.state === 'dead')
            this.state = 'idle';
        if (this.state === 'spawning') {
            await this.waitForReady(signal);
            return;
        }
        this.state = 'spawning';
        await this.spawn(signal);
        await this.waitForReady(signal);
    }
    waitForReady(signal) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + 30_000;
            const check = () => {
                if (signal?.aborted) {
                    this.killWorker();
                    reject(new Error('webcrawl worker startup aborted'));
                    return;
                }
                if (this.state === 'ready')
                    resolve();
                else if (this.state === 'dead')
                    reject(new Error('webcrawl worker failed to start' + (this.spawnErrTail ? ': ' + this.spawnErrTail : '')));
                else if (Date.now() > deadline) {
                    this.killWorker();
                    reject(new Error('webcrawl worker startup timed out after 30s' + (this.spawnErrTail ? ': ' + this.spawnErrTail : '')));
                }
                else
                    setTimeout(check, 50);
            };
            check();
        });
    }
    spawn(signal) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.pythonPath, [WORKER_PATH], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true, // 硬性：绝不弹出终端窗口
                env: this.env,
            });
            this.child = child;
            const gen = ++this.gen;
            let settled = false;
            const done = (fail) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(handshakeTimer);
                signal?.removeEventListener('abort', onAbort);
                if (fail)
                    reject(fail);
                else
                    resolve();
            };
            const onAbort = () => {
                done(new Error('webcrawl worker startup aborted'));
                try {
                    child.kill('SIGKILL');
                }
                catch { /* already gone */ }
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.spawnErrTail = '';
            const errChunks = [];
            child.stderr?.on('data', (c) => {
                errChunks.push(c);
                if (errChunks.length > 8)
                    errChunks.shift();
                this.spawnErrTail = Buffer.concat(errChunks).toString('utf8').trim().slice(-600);
            });
            const handshakeTimer = setTimeout(() => {
                done(new Error('webcrawl worker startup handshake timed out after 30s' + (this.spawnErrTail ? ': ' + this.spawnErrTail : ' (no stderr)')));
                try {
                    child.kill('SIGKILL');
                }
                catch { /* already gone */ }
            }, 30_000);
            const rl = createInterface({ input: child.stdout });
            this.rl = rl;
            rl.on('line', (line) => {
                if (this.child !== child)
                    return; // 代际守卫
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    return; // 非协议行（第三方库日志）静默忽略
                }
                const id = msg.id === null || msg.id === undefined ? null : String(msg.id);
                if (id === null) {
                    if (msg.ok === true && msg.data && msg.data.hello === true) {
                        done(null);
                        this.state = 'ready';
                    }
                    return;
                }
                const call = this.pending.get(id);
                if (!call)
                    return;
                this.pending.delete(id);
                clearTimeout(call.timer);
                this.coldStart = false;
                if (msg.ok === true)
                    call.resolve((msg.data ?? {}));
                else
                    call.reject(new Error(String(msg.error ?? 'webcrawl worker error')));
            });
            child.on('error', (err) => {
                done(new Error(`webcrawl spawn failed: ${err.message}`));
                if (this.child === child)
                    this.die();
            });
            child.on('close', () => {
                if (this.child !== child)
                    return; // 代际守卫
                this.rl = null;
                this.die();
                done(new Error('webcrawl worker exited before ready' + (this.spawnErrTail ? ': ' + this.spawnErrTail : ' (no stderr)')));
            });
        });
    }
    die() {
        this.state = 'dead';
        this.child = null;
        this.rl = null;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        for (const [, call] of this.pending) {
            clearTimeout(call.timer);
            call.reject(new Error('webcrawl worker exited'));
        }
        this.pending.clear();
    }
    armIdleTimer() {
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => { void this.shutdown(); }, this.idleShutdownMs);
    }
    async shutdown() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const child = this.child;
        if (child && this.state === 'ready') {
            try {
                child.stdin?.write(JSON.stringify({ id: 'shutdown', cmd: 'shutdown', args: {} }) + '\n');
                await new Promise((resolve) => {
                    const t = setTimeout(() => { child.kill(); resolve(); }, 2000);
                    child.once('close', () => { clearTimeout(t); resolve(); });
                });
            }
            catch {
                child.kill();
            }
        }
        else if (child) {
            child.kill();
        }
        this.child = null;
        this.rl = null;
        this.state = 'idle';
    }
    dispose() {
        this.disposed = true;
        this.killWorker(); // 同步强杀进程树：reload/卸载时防止进程泄漏
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════════════════
function truncateUrl(url, max) {
    return url.length <= max ? url : url.slice(0, max - 3) + '...';
}
export function apply(ctx, config) {
    const env = { ...process.env };
    if (config.vendorDir)
        env.DSH_WEBCRAWL_LIBS = config.vendorDir;
    if (config.browserChannel)
        env.DSH_WEBCRAWL_CHANNEL = config.browserChannel;
    if (config.readerFallback)
        env.DSH_WEBCRAWL_READER = env.DSH_WEBCRAWL_READER || 'https://r.jina.ai/';
    const worker = new CrawlWorker(config.pythonPath, config.timeoutSeconds * 1000, config.idleShutdownMs, env);
    ctx.effect(function* () {
        yield () => worker.dispose();
    }, 'dsh-web-crawl.worker');
    const baseArgs = (extra) => ({
        user_agent: UA,
        ...(config.proxy ? { proxy: config.proxy } : {}),
        ...extra,
    });
    const toolTimeout = Math.max(config.timeoutSeconds * 1000, 120_000);
    ctx.tools.register(defineTool({
        name: 'webcrawl',
        description: 'Fetch one web page through a multi-engine cascade and return clean Markdown plus metadata. ' +
            'L0 static HTTP → auto-upgrades to L1 Patchright (stealth Playwright + real Chrome) when the ' +
            'page is a JS shell or a bot-challenge page → optional L2 Jina Reader. Body extraction uses ' +
            'trafilatura (best-in-class boilerplate removal). Returns { url, final_url, success, ' +
            'status_code, markdown, chars, word_count, title, author, date, sitename, extractor, engine, ' +
            'internal_links, external_links, notes, error }.',
        parameters: {
            url: { type: 'string', required: true, description: 'URL to fetch (http/https).' },
            mode: { type: 'string', default: 'auto', description: 'auto (default: escalate only when needed) | static (never render) | browser (always render) | reader (use Jina Reader).' },
            max_length: { type: 'integer', default: 60000, description: 'Max markdown chars returned; truncated past this.' },
            css_selector: { type: 'string', description: 'Restrict extraction to content matching this CSS selector.' },
            wait_for_ms: { type: 'integer', description: 'Extra ms to wait after load before extracting (browser mode).' },
            wait_for_selector: { type: 'string', description: 'Wait for this CSS selector before extracting (browser mode).' },
            js_code: { type: 'string', description: 'JavaScript to evaluate after load; the result is appended under a [JS] marker.' },
            include_images: { type: 'boolean', default: false, description: 'Keep <img> references in the markdown.' },
            include_links: { type: 'boolean', default: true, description: 'Keep inline links in the markdown.' },
            include_tables: { type: 'boolean', default: true, description: 'Convert <table> to markdown tables.' },
            allow_reader: { type: 'boolean', description: 'Allow the hosted Jina Reader fallback if local engines fail (default: plugin config readerFallback).' },
            full_metadata: { type: 'boolean', default: false, description: 'Also run trafilatura full metadata extraction (date parsing etc.). Correct but SLOW — several seconds per page.' },
            cache: { type: 'boolean', default: true, description: 'Reuse the in-worker page cache (5 min TTL) when the same URL+options were fetched recently.' },
            timeout: { type: 'integer', default: 45000, description: 'Per-engine timeout ms.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, final_url: { type: 'string' }, success: { type: 'boolean' },
                    status_code: { type: 'integer' }, markdown: { type: 'string' }, chars: { type: 'integer' },
                    word_count: { type: 'integer' }, title: { type: 'string' }, author: { type: 'string' },
                    date: { type: 'string' }, sitename: { type: 'string' }, description: { type: 'string' },
                    extractor: { type: 'string' }, engine: { type: 'string' },
                    internal_links: { type: 'integer' }, external_links: { type: 'integer' },
                    timings: { type: 'object', additionalProperties: true },
                    cached: { type: 'boolean' },
                    notes: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false) {
                    const notes = Array.isArray(v.notes) ? ` — ${v.notes.join('; ')}` : '';
                    return [{ type: 'text', text: `webcrawl failed for ${String(v.url)}: ${String(v.error ?? '(no error)')}${notes}` }];
                }
                const tm = (v.timings ?? {});
                const tt = tm.total_ms !== undefined ? ` in ${tm.total_ms}ms` : '';
                const cacheTag = v.cached ? ' [cache hit]' : '';
                return [{
                        type: 'text',
                        text: `Fetched ${String(v.final_url ?? v.url)}${v.title ? ` — ${String(v.title)}` : ''}: ` +
                            `${Number(v.chars ?? 0).toLocaleString()} chars, engine=${String(v.engine)}, ` +
                            `extractor=${String(v.extractor)}, ${Number(v.internal_links ?? 0)} internal links${tt}${cacheTag}`,
                    }];
            },
        },
        timeoutMs: toolTimeout,
        execute: (args, exec) => worker.call('fetch', baseArgs(args), exec.signal),
        presentCall: args => ({ card: 'generic', title: `Fetch ${truncateUrl(String(args.url), 60)}`, kind: 'other', rawInput: String(args.url) }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_site',
        description: 'Deep-crawl a website (breadth-first, same domain, content-fingerprint dedupe) and return ' +
            'Markdown for each page. Use for multi-page research: docs, blogs, site-wide content. ' +
            'Bounded by max_depth/max_pages/global deadline. Returns { url, success, pages_crawled, ' +
            'queued, pages: [{ url, ok, title, engine, extractor, chars, markdown }], elapsed_ms, error }.',
        parameters: {
            url: { type: 'string', required: true, description: 'Seed URL.' },
            max_depth: { type: 'integer', default: 2, description: 'BFS depth limit (default 2).' },
            max_pages: { type: 'integer', default: 20, description: 'Total page cap.' },
            max_length: { type: 'integer', default: 20000, description: 'Max markdown chars per page.' },
            mode: { type: 'string', default: 'auto', description: 'auto | static | browser.' },
            concurrency: { type: 'integer', default: 4, description: 'Parallel fetches within each BFS level (1-16). Higher = faster, more load on the target.' },
            deadline_s: { type: 'number', default: 240, description: 'Global wall-clock deadline in seconds.' },
            timeout: { type: 'integer', default: 30000, description: 'Per-page timeout ms.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, success: { type: 'boolean' }, pages_crawled: { type: 'integer' },
                    queued: { type: 'integer' }, pages: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    elapsed_ms: { type: 'integer' }, error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false)
                    return [{ type: 'text', text: `webcrawl_site failed: ${String(v.error)}` }];
                return [{ type: 'text', text: `Deep-crawled ${String(v.url)}: ${String(v.pages_crawled)} pages (${String(v.queued ?? 0)} still queued)` }];
            },
        },
        timeoutMs: Math.max(toolTimeout, 300_000),
        execute: (args, exec) => worker.call('crawl_site', baseArgs(args), exec.signal),
        presentCall: args => ({ card: 'generic', title: `Crawl site ${truncateUrl(String(args.url), 50)}`, kind: 'other', rawInput: String(args.url) }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_map',
        description: 'Map a website: reads robots.txt → sitemap.xml (recursing into sitemap indexes) AND walks ' +
            'internal links, without downloading full page text. Use before a deep crawl to choose ' +
            'seeds, or to inventory a site. Returns { url, success, pages_seen, pages: [{ from, ok, ' +
            'count, links }], sitemaps, sitemap_urls, sitemap_url_count, known_urls, concurrency, ' +
            'elapsed_ms, error }.',
        parameters: {
            url: { type: 'string', required: true, description: 'Seed URL.' },
            max_pages: { type: 'integer', default: 100, description: 'Page discovery cap.' },
            mode: { type: 'string', default: 'static', description: 'static (fast) | browser (JS-rendered nav).' },
            use_sitemap: { type: 'boolean', default: true, description: 'Read robots.txt / sitemap.xml first (much faster and more complete than link-walking alone).' },
            concurrency: { type: 'integer', default: 4, description: 'Parallel fetches within each BFS level (1-16).' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, success: { type: 'boolean' }, pages_seen: { type: 'integer' },
                    pages: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    sitemaps: { type: 'array', items: { type: 'string' } },
                    sitemap_urls: { type: 'array', items: { type: 'string' } },
                    sitemap_url_count: { type: 'integer' },
                    known_urls: { type: 'array', items: { type: 'string' } },
                    elapsed_ms: { type: 'integer' }, error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false)
                    return [{ type: 'text', text: `webcrawl_map failed: ${String(v.error)}` }];
                const sm = Number(v.sitemap_url_count ?? 0);
                return [{ type: 'text', text: `Mapped ${String(v.url)}: ${String(v.pages_seen)} pages walked` + (sm ? `, ${sm} URLs from sitemap` : '') }];
            },
        },
        timeoutMs: toolTimeout,
        execute: (args, exec) => worker.call('map_site', baseArgs(args), exec.signal),
        presentCall: args => ({ card: 'generic', title: `Map ${truncateUrl(String(args.url), 50)}`, kind: 'other', rawInput: String(args.url) }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_extract',
        description: 'Extract structured data from a page with CSS selectors — fully local, no LLM, no API cost. ' +
            'Schema form: { "name": "...", "baseSelector": "css", "fields": [{ "name": "...", ' +
            '"selector": "css", "type": "text|html|attr|list|nested", "attribute": "href" }] }. ' +
            'Returns { url, success, count, data: { name, items: [...] }, rows, error }.',
        parameters: {
            url: { type: 'string', required: true, description: 'URL to extract from.' },
            schema: { type: 'object', additionalProperties: true, required: true, description: 'Extraction schema (see description).' },
            mode: { type: 'string', default: 'auto', description: 'auto | static | browser.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, success: { type: 'boolean' }, count: { type: 'integer' },
                    data: { type: 'object', additionalProperties: true },
                    rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false)
                    return [{ type: 'text', text: `webcrawl_extract failed: ${String(v.error)}` }];
                return [{ type: 'text', text: `Extracted ${String(v.count ?? 0)} rows from ${String(v.url)}` }];
            },
        },
        timeoutMs: toolTimeout,
        execute: (args, exec) => worker.call('extract', baseArgs(args), exec.signal),
        presentCall: args => ({ card: 'generic', title: `Extract from ${truncateUrl(String(args.url), 50)}`, kind: 'other', rawInput: String(args.url) }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_links',
        description: 'List the outbound links of one page (internal + external with anchor text). Cheaper than a ' +
            'full crawl when you only need to discover where a page points. Returns { url, success, ' +
            'internal, external, links: [{ href, text, kind }], error }.',
        parameters: {
            url: { type: 'string', required: true, description: 'URL to inspect.' },
            mode: { type: 'string', default: 'auto', description: 'auto | static | browser.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, success: { type: 'boolean' }, internal: { type: 'integer' },
                    external: { type: 'integer' },
                    links: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false)
                    return [{ type: 'text', text: `webcrawl_links failed: ${String(v.error)}` }];
                return [{ type: 'text', text: `${String(v.url)}: ${String(v.internal ?? 0)} internal, ${String(v.external ?? 0)} external links` }];
            },
        },
        timeoutMs: toolTimeout,
        execute: (args, exec) => worker.call('links', baseArgs(args), exec.signal),
        presentCall: args => ({ card: 'generic', title: `Links of ${truncateUrl(String(args.url), 50)}`, kind: 'other', rawInput: String(args.url) }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_doc',
        description: 'Convert a document to Markdown for LLM consumption (markitdown): PDF, DOCX, PPTX, XLSX, ' +
            'HTML, EPUB, CSV and more. Pass a local path or an http(s) URL. Returns { url, path, success, ' +
            'markdown, chars, ext, error }.',
        parameters: {
            path: { type: 'string', description: 'Local file path to convert.' },
            url: { type: 'string', description: 'Remote document URL (alternative to path).' },
            max_length: { type: 'integer', default: 200000, description: 'Max markdown chars returned.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, path: { type: 'string' }, success: { type: 'boolean' },
                    markdown: { type: 'string' }, chars: { type: 'integer' }, ext: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false)
                    return [{ type: 'text', text: `webcrawl_doc failed: ${String(v.error)}` }];
                return [{ type: 'text', text: `Converted ${String(v.ext ?? '')} document (${Number(v.chars ?? 0).toLocaleString()} chars)${v.path ? ` — ${String(v.path)}` : ''}` }];
            },
        },
        timeoutMs: toolTimeout,
        execute: (args, exec) => worker.call('doc', args, exec.signal),
        presentCall: args => ({ card: 'generic', title: `Convert ${truncateUrl(String(args.url ?? args.path), 50)}`, kind: 'other', rawInput: String(args.url ?? '') }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_http',
        description: 'Raw HTTP request through the browser network stack (real Chrome TLS/fingerprint, ignores ' +
            'certificate errors). Supports GET/POST/PUT/DELETE/PATCH/HEAD with custom headers and body. ' +
            'Falls back to the urllib stack if the browser is unavailable. Returns ' +
            '{ url, success, status, headers, body, error }.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute http(s) URL.' },
            method: { type: 'string', default: 'GET', description: 'HTTP method.' },
            headers: { type: 'object', additionalProperties: true, description: 'Optional request headers.' },
            body: { type: 'string', description: 'Optional request body.' },
            timeout: { type: 'integer', default: 30000, description: 'Timeout ms.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: true,
                properties: {
                    url: { type: 'string' }, success: { type: 'boolean' }, status: { type: 'integer' },
                    headers: { type: 'object', additionalProperties: true }, body: { type: 'string' },
                    final_url: { type: 'string' }, error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.success === false)
                    return [{ type: 'text', text: `webcrawl_http failed: ${String(v.error)}` }];
                const body = String(v.body ?? '');
                return [{ type: 'text', text: `HTTP ${String(v.status)} ${String(v.url)} — ${body.length} chars body\n${body.slice(0, 1500)}` }];
            },
        },
        timeoutMs: toolTimeout,
        execute: (args, exec) => worker.call('http', args, exec.signal),
        presentCall: args => ({ card: 'generic', title: `HTTP ${String(args.method ?? 'GET')} ${truncateUrl(String(args.url), 60)}`, kind: 'other', rawInput: String(args.url) }),
    }));
    ctx.tools.register(defineTool({
        name: 'webcrawl_status',
        description: 'Report the dsh-web-crawl engine status: which browser engine is active (patchright vs ' +
            'playwright), which extractors loaded (trafilatura / justext / markitdown / bs4), missing ' +
            'optional modules, vendored library paths, cache stats and per-run counters. Use to diagnose ' +
            'a degraded crawl. Set clear_cache=true to empty the page/HTML caches.',
        parameters: {
            clear_cache: { type: 'boolean', default: false, description: 'Clear the worker page cache and HTML cache before reporting.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => {
                const v = value;
                const eng = (v.engines ?? {});
                const ex = (v.extractors ?? {});
                const missing = v.missing_modules ?? [];
                const warn = missing.length ? ` | missing: ${missing.map(m => String(m.module)).join(', ')}` : '';
                return [{ type: 'text', text: `webcrawl healthy=${String(v.healthy)} browser=${String(eng.browser ?? 'none')}, extractors=${JSON.stringify(ex)}${warn}` }];
            },
        },
        timeoutMs: 60_000,
        execute: (args, exec) => worker.call('status', args, exec.signal),
        presentCall: () => ({ card: 'generic', title: 'webcrawl engine status', kind: 'other', rawInput: '' }),
    }));
    // ═════════════════════════════════════════════════════════════════════════
    // 可选 WebFetchProvider：让内置 web_fetch 走多引擎抓取。
    // ═════════════════════════════════════════════════════════════════════════
    const registerFetch = config.registerAsFetchProvider || process.env.DSH_WEBCRAWL_FETCH_PROVIDER === '1';
    if (registerFetch) {
        const web = ctx.get('web');
        if (!web) {
            ctx.logger?.warn?.(`[${name}] registerAsFetchProvider=true but no 'web' service; skipping provider registration`);
        }
        else {
            const provider = {
                id: 'webcrawl',
                available: () => true,
                fetch: async (request, signal) => {
                    if (signal?.aborted)
                        throw new Error('web fetch aborted');
                    const data = await worker.call('fetch', {
                        url: request.url,
                        mode: 'auto',
                        user_agent: UA,
                        ...(config.proxy ? { proxy: config.proxy } : {}),
                    }, signal);
                    const body = { kind: 'text', content: String(data.markdown ?? '') };
                    return {
                        url: String(data.final_url ?? data.url ?? request.url),
                        statusCode: Number(data.status_code ?? 200),
                        body,
                        truncated: false,
                    };
                },
            };
            web.registerFetchProvider(provider);
            ctx.logger?.info?.(`[${name}] webcrawl WebFetchProvider registered (id=webcrawl); set DSH_WEB_FETCH_PROVIDER=webcrawl to route web_fetch through it`);
        }
    }
    ctx.logger?.info?.(`[${name}] 8 webcrawl tools registered (python=${config.pythonPath}, timeout=${config.timeoutSeconds}s, idle=${config.idleShutdownMs}ms)`);
}
//# sourceMappingURL=index.js.map