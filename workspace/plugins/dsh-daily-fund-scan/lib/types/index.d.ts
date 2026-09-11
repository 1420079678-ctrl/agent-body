/**
 * @dsh-external/dsh-daily-fund-scan — 每日基金扫描守护循环（小白友好版）。
 *
 * 每天 15:30（收盘后）自动触发一轮：
 *   1. invest_regime 判大盘制度（附白话翻译）
 *   2. 对基金池（23 只宽基/跨境/商品/债券/红利/行业主题）逐只执行 invest_report
 *      + 有仓位的补 invest_position 拿止损/目标（走确定性引擎，零 LLM token）
 *   3. 按仓位%×本金(100000) 折算建议金额，输出「小白也能看懂」的日报：
 *      买多少钱 / 跌多少卖 / 涨多少卖 / 为什么
 *   4. 报告写到 DSH 插件数据目录：DSH_HOME/plugins/dsh-daily-fund-scan/reports/
 *
 * 所有数据来自 invest 插件注册的 invest_* 工具（eastmoney 真实行情），
 * 本插件不调用 LLM，不消耗推理 token。
 */
import type { Context } from 'cordis';
import { CallId } from '@deepseek-ai/dsh-llm/brand';
import z from 'schemastery';
type AppContext = Context & {
    setInterval(fn: () => void, ms: number): any;
    tools: {
        execute(input: {
            callId: ReturnType<typeof CallId>;
            name: string;
            arguments: unknown;
            signal: AbortSignal;
        }): Promise<{
            content: Array<{
                type: string;
                text?: string;
            }>;
            isError?: boolean;
        }>;
    };
};
export declare const name = "@dsh-external/dsh-daily-fund-scan";
export declare const inject: string[];
export interface Config {
    /** 每天触发时间 HH:mm（本地时区） */
    runAt: string;
    /** 扫描轮询间隔 ms（用于检测是否到点） */
    pollMs: number;
    /** 基金池：代码|名称 列表，逐行一个 */
    fundPool: string;
    /** 假设本金（元），建议金额 = 仓位% × capital */
    capital: number;
    /** 报告输出目录（空 = DSH 插件数据目录 reports 子目录） */
    outDir: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    runAt: z<string, string>;
    pollMs: z<number, number>;
    fundPool: z<string, string>;
    capital: z<number, number>;
    outDir: z<string, string>;
}>, Schemastery.ObjectT<{
    runAt: z<string, string>;
    pollMs: z<number, number>;
    fundPool: z<string, string>;
    capital: z<number, number>;
    outDir: z<string, string>;
}>>;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
