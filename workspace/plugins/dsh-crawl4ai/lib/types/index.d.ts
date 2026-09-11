/**
 * @dsh-external/dsh-crawl4ai — DSH 世界级网页爬取工具包（v0.2）。
 *
 * 在 crawl4ai 0.9.x（67K+ star 的开源 LLM 友好爬虫）之上封装一个常驻 Python
 * worker（行协议 JSON-RPC over stdio），复用浏览器实例规避每次冷启动开销，
 * 并提供五个模型工具 + 可选 WebFetchProvider：
 *
 *   - `crawl4ai`        单页智能抓取（静态 HTTP 自适应 → 可升浏览器渲染 + 正文净化）
 *   - `crawl4ai_crawl`  整站深爬（BFS，同域，max_depth/max_pages 上限）
 *   - `crawl4ai_map`    站点地图（发现站内链接，不下载正文）
 *   - `crawl4ai_extract`CSS 选择器结构化提取（schema → JSON，本地免费）
 *   - `crawl4ai_links`  单页链接清单
 *
 * 设计取舍（吸收业界先进爬取技术优点、规避其缺点）：
 *   - 常驻 worker 复用浏览器（规避 crawl4ai 冷启动慢）；静态页 HTTP 优先、
 *     失败升浏览器（吸收 AdaptiveCrawler 与 Firecrawl 分级）；Pruning 内容过滤
 *     净化正文（吸收 Trafilatura/readability）；深爬/地图带保守上限（防失控）；
 *     结构化提取用本地 CSS 而非 LLM（规避 API key 与成本）；代理/UA 可配
 *     （吸收 Firecrawl 反爬）；WebFetchProvider 显式 opt-in（不破坏现有 http
 *     provider 的单 provider 选择语义）。
 *
 * @module @dsh-external/dsh-crawl4ai
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-crawl4ai";
export declare const inject: string[];
export interface Config {
    /** Path to the Python interpreter with crawl4ai installed. Defaults to `python`. */
    pythonPath: string;
    /** Per-request tool timeout in seconds. Default 60. */
    timeoutSeconds: number;
    /** Idle shutdown delay in ms (worker exits after this long without a request). Default 5 min. */
    idleShutdownMs: number;
    /** Default max_pages bound for deep-crawl and site-map tools. */
    defaultMaxPages: number;
    /** Proxy URL for the browser (e.g. http://user:pass@host:port). Empty = system default. */
    proxy: string;
    /** Register a `crawl4ai` WebFetchProvider so `web_fetch` can route through it. */
    registerAsFetchProvider: boolean;
}
export declare const Config: z<Schemastery.ObjectS<{
    pythonPath: z<string, string>;
    timeoutSeconds: z<number, number>;
    idleShutdownMs: z<number, number>;
    defaultMaxPages: z<number, number>;
    proxy: z<string, string>;
    registerAsFetchProvider: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    pythonPath: z<string, string>;
    timeoutSeconds: z<number, number>;
    idleShutdownMs: z<number, number>;
    defaultMaxPages: z<number, number>;
    proxy: z<string, string>;
    registerAsFetchProvider: z<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
