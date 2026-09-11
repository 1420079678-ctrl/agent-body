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
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-web-crawl";
export declare const inject: string[];
export interface Config {
    /** Python interpreter to run the worker with. Defaults to `python`. */
    pythonPath: string;
    /** Per-request tool timeout in seconds. Default 90. */
    timeoutSeconds: number;
    /** Idle shutdown delay in ms (worker exits after this long without a request). */
    idleShutdownMs: number;
    /** Extra directory to put on the worker's sys.path (vendored wheels). */
    vendorDir: string;
    /** Chrome channel for the stealth engine (chrome / msedge / chromium). */
    browserChannel: string;
    /** Proxy URL for all engines (http://user:pass@host:port). Empty = direct. */
    proxy: string;
    /** Enable the Jina Reader (r.jina.ai) hosted fallback when local engines fail. */
    readerFallback: boolean;
    /** Register a WebFetchProvider so `web_fetch` can route through this plugin. */
    registerAsFetchProvider: boolean;
}
export declare const Config: z<Schemastery.ObjectS<{
    pythonPath: z<string, string>;
    timeoutSeconds: z<number, number>;
    idleShutdownMs: z<number, number>;
    vendorDir: z<string, string>;
    browserChannel: z<string, string>;
    proxy: z<string, string>;
    readerFallback: z<boolean, boolean>;
    registerAsFetchProvider: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    pythonPath: z<string, string>;
    timeoutSeconds: z<number, number>;
    idleShutdownMs: z<number, number>;
    vendorDir: z<string, string>;
    browserChannel: z<string, string>;
    proxy: z<string, string>;
    readerFallback: z<boolean, boolean>;
    registerAsFetchProvider: z<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
