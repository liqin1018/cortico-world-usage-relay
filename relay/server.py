#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
relayhub/server.py -- 中转站延迟/成本对照台

本地起一个网页，按品牌管理多个中转站，一键跑基准，直接告诉你该用哪个。
复用同级目录的 bench.py 做实际请求，标准库实现，无第三方依赖。

    python relayhub/server.py            # http://127.0.0.1:8770

数据落在 relayhub/data.db（sqlite）。API key 只存本地，接口返回时会打码。
"""

import json
import os
import re
import sqlite3
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
import bench  # noqa: E402
import audit  # noqa: E402
import billing  # noqa: E402
from models import VENDORS, VENDOR_MAP, lookup_ref, vendor_name, guess as guess_model  # noqa: E402

DATA_DIR = os.environ.get("RELAYHUB_DATA_DIR") or HERE
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = HERE
DB_PATH = os.path.join(DATA_DIR, "data.db")
STATIC = os.path.join(HERE, "static")

# 官方人民币价（谷时，每百万 token）。峰时翻倍。
CNY_PRICES = {"input_miss": 1.0, "input_hit": 0.02, "output": 4.0}

# 没有实测数据时，按这个工作量折算单次成本（1k 入 / 0.5k 出）
FALLBACK_WORKLOAD = (1000.0, 500.0)

# 跨站比价用的典型场景（输入 token, 输出 token）。不计缓存命中，按最坏情况算。
SCENARIOS = [
    ("chat", "短对话 1k 入 / 0.5k 出", 1000.0, 500.0),
    ("agent", "Agent 多轮 8k 入 / 1.5k 出", 8000.0, 1500.0),
    ("doc", "读长文档 30k 入 / 0.8k 出", 30000.0, 800.0),
]

DEFAULT_PROMPT = (
    "Explain how a B-tree index speeds up range queries in a relational database, "
    "and why it slows down writes. Use concrete examples where useful. "
    "Keep it under 400 words."
)

_db_lock = threading.Lock()
_jobs = {}
_jobs_lock = threading.Lock()


# ------------------------------------------------------------------ storage

def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS targets(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            model TEXT NOT NULL,
            api_key TEXT NOT NULL DEFAULT '',
            price_in REAL NOT NULL DEFAULT 1.0,
            price_out REAL NOT NULL DEFAULT 4.0,
            price_cache REAL NOT NULL DEFAULT 0.02,
            note TEXT DEFAULT '',
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS benches(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_id INTEGER NOT NULL,
            started_at TEXT,
            params TEXT,
            summary TEXT
        );
        CREATE TABLE IF NOT EXISTS runs(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER NOT NULL,
            seq INTEGER,
            ttft_ms REAL,
            first_answer_ms REAL,
            total_ms REAL,
            tps REAL,
            input_tokens INTEGER,
            cache_hit INTEGER,
            output_tokens INTEGER,
            reasoning_tokens INTEGER,
            ok INTEGER,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS bill_sources(
            target_id INTEGER PRIMARY KEY,
            kind TEXT DEFAULT 'oneapi',
            api_base TEXT DEFAULT '',
            token TEXT DEFAULT '',
            cookie TEXT DEFAULT '',
            user_id TEXT DEFAULT '',
            quota_per_unit REAL DEFAULT 0,
            usd_cny REAL DEFAULT 0,
            last_sync TEXT,
            last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS bills(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_id INTEGER NOT NULL,
            taken_at TEXT,
            source TEXT,
            cost REAL,
            requests INTEGER,
            tin INTEGER,
            tout INTEGER,
            tcache INTEGER,
            data TEXT
        );
        """)
        # 老库升级：补品牌 / 官方参考价 / 基线标记
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(targets)")}
        add = [
            ("vendor", "TEXT DEFAULT 'deepseek'"),
            ("ref_in", "REAL DEFAULT 1.0"),
            ("ref_out", "REAL DEFAULT 4.0"),
            ("ref_cache", "REAL DEFAULT 0.02"),
            ("is_base", "INTEGER DEFAULT 0"),
            # 最近一次「再试也没用」的失败（日额度用完 / key 失效 / 模型下线），
            # 存下来是为了刷新页面后还能看到原因，而不是只剩一句“还没测过”
            ("last_stop", "TEXT DEFAULT ''"),
        ]
        for name, ddl in add:
            if name not in cols:
                conn.execute("ALTER TABLE targets ADD COLUMN %s %s" % (name, ddl))
        # 老数据回填：默认 DeepSeek，名字带"官方"的当基线
        conn.execute("UPDATE targets SET vendor='deepseek' WHERE vendor IS NULL OR vendor=''")
        conn.execute("UPDATE targets SET ref_in=1.0, ref_out=4.0, ref_cache=0.02"
                     " WHERE ref_in IS NULL")
        conn.execute("UPDATE targets SET is_base=0 WHERE is_base IS NULL")
        row = conn.execute("SELECT COUNT(*) c FROM targets WHERE is_base=1").fetchone()
        if row["c"] == 0:
            conn.execute("UPDATE targets SET is_base=1 WHERE name LIKE '%官方%'")
        conn.commit()


def mask(key):
    if not key:
        return ""
    if len(key) <= 12:
        return key[:4] + "***"
    return key[:6] + "***" + key[-4:]


def _last_line():
    """异常只回最后一行（异常类型+信息），不要整段 traceback 糊到界面上。"""
    tb = traceback.format_exc().strip().splitlines()
    return (tb[-1] if tb else "未知错误")[:300]


# ------------------------------------------------------------------ bench run

class Args(object):
    """最小化的参数容器，喂给 bench.run_once。"""

    def __init__(self, max_tokens, thinking, effort, timeout=180.0):
        self.max_tokens = max_tokens
        self.thinking = thinking
        self.effort = effort
        self.temperature = None
        self.timeout = timeout
        self.insecure = False


# 站点明确表示「现在/今天别来了」的错误：再试下去只是白烧次数
_FATAL_KINDS = ("daily_limit", "auth", "no_balance", "bad_model", "waf")
_RESUME_AT = re.compile(r"resume at (\d{4}-\d{2}-\d{2} \d{2}:\d{2})")


def _bench_failure(msg):
    """把站点返回的一大坨 JSON 翻成一句人话，顺便判断该不该继续跑。"""
    low = msg.lower()
    if "group_daily_usage_limit" in low or "daily usage limit" in low:
        hit = _RESUME_AT.search(msg)
        when = hit.group(1) if hit else ""
        return ("daily_limit",
                "站点这个分组的每日额度用完了" + ("，%s 恢复" % when if when else "")
                + "。免费站常见，每天重置；急着测就把次数调小、或换个站点")
    if "insufficient" in low and ("quota" in low or "balance" in low):
        return ("no_balance", "站点余额不足，充完再测")
    if ("timeout" in low or "timed out" in low or "connection failed" in low
            or "remote end closed" in low or "tls failed" in low):
        return ("timeout",
                "连上了但站点没按时把响应发完（超时 / 断连 / TLS 握手失败）。"
                "这是站点或链路不稳，不是 key 的问题：把次数调小、过一会儿再跑")
    if "waf_html" in low:
        return ("waf",
                "请求被站点前面的防火墙拦了：它回的是一张 403 网页，不是接口错误，跟 key 无关。"
                "多半是认出了脚本特征，换用客户端 UA 已重试；还不行就在浏览器打开这个站，"
                "看是不是要过人机验证或 IP 被风控")
    if "http 401" in low or "invalid api key" in low:
        return ("auth", "站点不认这把 key（401），确认没抄错、没过期、没被吊销")
    if "http 403" in low:
        return ("auth",
                "站点拒绝访问（403）：先看 base_url 有没有漏 /v1（对比其它能用的目标），"
                "再看这把 key 有没有这个模型的权限")
    if ("model_not_found" in low or "model not found" in low
            or "model_unavailable" in low or "does not exist" in low
            or "已下线" in msg or "不存在" in msg):
        return ("bad_model", "站点上没有这个模型（上游已下线或名字不对），检查左侧「模型」那一栏")
    if "http 429" in low:
        return ("rate_limit", "站点在限流（429），歇几秒继续")
    return (None, msg[:300])


def run_bench_job(job_id, target_row, params):
    job = _jobs[job_id]
    target = {
        "name": target_row["name"],
        "base_url": target_row["base_url"],
        "model": target_row["model"],
        "api_key": target_row["api_key"],
        "headers": {},
        "_strip": set(),
        "_notes": [],
    }
    args = Args(params["max_tokens"], params["thinking"], params["effort"])
    prices = (target_row["price_in"], target_row["price_out"], target_row["price_cache"])
    ref = (target_row["ref_in"], target_row["ref_out"], target_row["ref_cache"])
    prompt = params.get("prompt") or DEFAULT_PROMPT
    system = params.get("system") or "You are a precise technical assistant. Answer directly."
    usd_prices = dict(bench.DEFAULT_PRICES)
    tier = bench.current_tier()

    runs = int(params["runs"])
    warmup = int(params.get("warmup", 2))
    total = runs + warmup
    rows = []
    fails = 0

    conn = db()
    with _db_lock:
        cur = conn.execute(
            "INSERT INTO benches(target_id, started_at, params, summary) VALUES (?,?,?,?)",
            (target_row["id"], time.strftime("%Y-%m-%d %H:%M:%S"), json.dumps(params), ""),
        )
        bench_id = cur.lastrowid
        conn.commit()

    consec_timeout = 0
    try:
        for i in range(total):
            if job.get("cancel"):
                job["status"] = "cancelled"
                break
            warm = i < warmup
            job["phase"] = "warmup %d/%d" % (i + 1, warmup) if warm else "%d/%d" % (i - warmup + 1, runs)
            attempt = 0
            fatal = False
            last_kind = None
            while True:
                attempt += 1
                try:
                    m = bench.run_once(target, prompt, system, args, usd_prices, tier)
                    break
                except RuntimeError as e:
                    msg = str(e)
                    if "400 retryable" in msg and attempt < 4:
                        continue
                    if attempt <= 1 and not msg.startswith("HTTP 4"):
                        time.sleep(0.8)
                        continue
                    m = None
                    fails += 1
                    kind, human = _bench_failure(msg)
                    last_kind = kind
                    with _db_lock:
                        conn.execute(
                            "INSERT INTO runs(bench_id, seq, ok, error) VALUES (?,?,?,?)",
                            (bench_id, i - warmup + 1, 0, msg[:400]),
                        )
                        conn.commit()
                    if human not in job["errors"]:
                        job["errors"].append(human)
                    if kind in _FATAL_KINDS:
                        # 站点已经明说「今天别来了」，剩下的次数没有意义，别再烧
                        job["stopped"] = {"kind": kind, "text": human,
                                          "at_run": max(0, i - warmup + 1),
                                          "done": len(rows), "planned": runs}
                        fatal = True
                    elif kind == "rate_limit":
                        time.sleep(3)
                    break
            if fatal:
                break
            if m is None:
                # 连续三次都超时/断连，说明这个站这会儿基本连不上，别把次数耗光
                if last_kind == "timeout":
                    consec_timeout += 1
                    if consec_timeout >= 3:
                        job["stopped"] = {"kind": "timeout",
                                          "text": "连着 3 次都超时，这个站这会儿基本连不上，先停下",
                                          "at_run": max(0, i - warmup + 1),
                                          "done": len(rows), "planned": runs}
                        break
                else:
                    consec_timeout = 0
                continue
            consec_timeout = 0
            if warm:
                continue

            miss = m["input_tokens"] - m["cache_hit_tokens"]
            official = (miss * CNY_PRICES["input_miss"]
                        + m["cache_hit_tokens"] * CNY_PRICES["input_hit"]
                        + m["output_tokens"] * CNY_PRICES["output"]) / 1e6
            relay = (miss * prices[0]
                     + m["cache_hit_tokens"] * prices[2]
                     + m["output_tokens"] * prices[1]) / 1e6
            m["official_cny"] = official
            m["relay_cny"] = relay
            rows.append(m)

            with _db_lock:
                conn.execute(
                    "INSERT INTO runs(bench_id, seq, ttft_ms, first_answer_ms, total_ms, tps,"
                    " input_tokens, cache_hit, output_tokens, reasoning_tokens, ok)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,1)",
                    (bench_id, i - warmup + 1, m["ttft_ms"], m["first_answer_ms"], m["total_ms"],
                     m["tps"], m["input_tokens"], m["cache_hit_tokens"], m["output_tokens"],
                     m["reasoning_tokens"]),
                )
                conn.commit()
            job["rows"].append({k: m[k] for k in (
                "ttft_ms", "first_answer_ms", "total_ms", "tps", "input_tokens",
                "cache_hit_tokens", "output_tokens", "reasoning_tokens")})
            job["done"] = len(rows)

        summary = summarize(rows, prices, ref)
        summary["notes"] = target["_notes"]
        summary["tier"] = tier
        summary["fails"] = fails
        summary["planned_runs"] = runs
        # 记下这次的口径：思考开没开、额度多大。不同口径的结果不能混着比。
        summary["thinking"] = params.get("thinking")
        summary["max_tokens"] = params.get("max_tokens")
        if job.get("stopped") or job["done"] < runs:
            summary["partial"] = True
        if job.get("stopped"):
            summary["stopped"] = job["stopped"]
        if rows:
            with _db_lock:
                conn.execute("UPDATE benches SET summary=? WHERE id=?",
                             (json.dumps(summary), bench_id))
                conn.commit()
            job["summary"] = summary
        job["bench_id"] = bench_id
        # 把「为什么没测成」记到目标上：刷新页面也还看得到，不用再白点一次
        with _db_lock:
            if job.get("stopped"):
                conn.execute("UPDATE targets SET last_stop=? WHERE id=?",
                             (json.dumps(job["stopped"]), target_row["id"]))
            elif rows:
                conn.execute("UPDATE targets SET last_stop='' WHERE id=?", (target_row["id"],))
            conn.commit()
        if job["status"] == "cancelled":
            pass
        elif job.get("stopped") and not rows:
            job["status"] = "blocked"
        else:
            job["status"] = "done"
    except Exception:
        job["status"] = "error"
        job["error"] = traceback.format_exc()[-800:]
    finally:
        conn.close()


def summarize(rows, prices, ref):
    if not rows:
        return {"runs": 0}
    ttft = [r["ttft_ms"] for r in rows]
    fa = [r["first_answer_ms"] for r in rows]
    tot = [r["total_ms"] for r in rows]
    tps = [r["tps"] for r in rows if r["tps"] > 0]
    off = sum(r["official_cny"] for r in rows) / len(rows)
    rel = sum(r["relay_cny"] for r in rows) / len(rows)
    return {
        "runs": len(rows),
        "ttft_mean": sum(ttft) / len(ttft),
        "ttft_median": sorted(ttft)[len(ttft) // 2],
        "ttft_p95": bench.pct(ttft, 0.95),
        "ttft_max": max(ttft),
        "answer_mean": sum(fa) / len(fa),
        "total_mean": sum(tot) / len(tot),
        "tps_mean": sum(tps) / len(tps) if tps else 0.0,
        "input_tokens": sum(r["input_tokens"] for r in rows) / len(rows),
        "output_tokens": sum(r["output_tokens"] for r in rows) / len(rows),
        "reasoning_tokens": sum(r["reasoning_tokens"] for r in rows) / len(rows),
        "cache_hit": sum(r["cache_hit_tokens"] for r in rows) / len(rows),
        "official_cny": off,
        "relay_cny": rel,
        "truncated": sum(1 for r in rows if r.get("truncated")),
        "prices": {"in": prices[0], "out": prices[1], "cache": prices[2]},
        "ref": {"in": ref[0], "out": ref[1], "cache": ref[2]},
        "zhe": (rel / off * 10.0) if off > 0 else 10.0,
    }


# ------------------------------------------------------------------ 决策

def _call_cost(pin, pout, pcache, w_in, w_out, hit):
    """按给定工作量算单次成本（元）。hit = 命中缓存的输入 token。"""
    hit = max(0.0, min(hit, w_in))
    miss = w_in - hit
    return (miss * pin + hit * pcache + w_out * pout) / 1e6


# 各品牌官方直连的域名。用来区分「官方」和「按官方价卖的中转站」——
# 两者价格可能一样，但延迟含义完全不同。
OFFICIAL_HOSTS = {
    "deepseek": ("api.deepseek.com",),
    "openai": ("api.openai.com",),
    "claude": ("api.anthropic.com",),
    "gemini": ("generativelanguage.googleapis.com",),
    "qwen": ("dashscope.aliyuncs.com",),
    "doubao": ("ark.cn-beijing.volces.com",),
    "hunyuan": ("api.hunyuan.cloud.tencent.com",),
    "glm": ("open.bigmodel.cn",),
    "kimi": ("api.moonshot.cn",),
    "stepfun": ("api.stepfun.com",),
    "minimax": ("api.minimax.chat",),
    "grok": ("api.x.ai",),
    "mimo": ("api.xiaomimimo.com",),
}


def is_official(t):
    host = urllib.parse.urlparse(t.get("base_url") or "").netloc.lower()
    hosts = OFFICIAL_HOSTS.get(t.get("vendor") or "")
    if hosts:
        return any(h in host for h in hosts)
    # 品牌没收录时退回价格判断
    return (abs(t["price_in"] - t["ref_in"]) < 1e-9
            and abs(t["price_out"] - t["ref_out"]) < 1e-9)


def _verdict(mode, ratio, dttft, per_min, fails, runs, is_base, has_base=True,
             official=False):
    if is_base:
        return {"k": "base", "label": "基线", "why": "作为同品牌延迟参照"}
    if official:
        return {"k": "the", "label": "官方直连", "why": "官方原价，这是价格基准"}
    if not runs:
        return {"k": "none", "label": "未测", "why": "还没有实测数据"}
    if fails and runs and fails / float(runs + fails) > 0.1:
        return {"k": "bad", "label": "避开", "why": "失败率 %d%%，跑不稳" % round(100 * fails / (runs + fails))}
    if ratio >= 0.95:
        return {"k": "bad", "label": "不划算",
                "why": "价格是官方的 %.0f%%，基本没便宜" % (ratio * 100)}
    if not has_base:
        if ratio <= 0.6:
            return {"k": "rec", "label": "推荐",
                    "why": "官方价的 %.0f%%；该品牌还没设基线，延迟未做对照" % (ratio * 100)}
        if ratio <= 0.85:
            return {"k": "ok", "label": "可用",
                    "why": "官方价的 %.0f%%；还没设基线，建议把官方直连加进来做对照" % (ratio * 100)}
        return {"k": "the", "label": "看情况", "why": "只便宜 %.0f%%" % ((1 - ratio) * 100)}
    dttft = dttft or 0
    if mode == "batch":
        if ratio <= 0.35:
            return {"k": "rec", "label": "推荐",
                    "why": "官方价的 %.0f%%，批处理不看延迟，直接省下 %.0f%%" % (ratio * 100, (1 - ratio) * 100)}
        if ratio <= 0.6:
            return {"k": "ok", "label": "可用", "why": "官方价的 %.0f%%" % (ratio * 100)}
        return {"k": "bad", "label": "不划算", "why": "只便宜 %.0f%%，不够折腾" % ((1 - ratio) * 100)}
    # 在线交互：延迟要算钱
    if dttft <= 250 and ratio <= 0.8:
        if dttft < -30:
            why = "官方价的 %.0f%%，首字还比基线快 %dms" % (ratio * 100, round(-dttft))
        else:
            why = ("官方价的 %.0f%%，首字只慢 %dms（200ms 内基本无感）"
                   % (ratio * 100, round(max(0, dttft))))
        return {"k": "rec", "label": "推荐", "why": why}
    if per_min is not None and per_min >= 2.0:
        return {"k": "rec", "label": "推荐",
                "why": "多等 1 分钟能换回 ¥%.2f，划算" % per_min}
    if per_min is not None and per_min >= 0.6:
        return {"k": "ok", "label": "可用",
                "why": "多等 1 分钟换回 ¥%.2f，勉强" % per_min}
    if dttft > 500:
        return {"k": "bad", "label": "不划算",
                "why": "每次多等 %dms，交互场景吃不消" % round(dttft)}
    return {"k": "the", "label": "看情况", "why": "省得有限，延迟也在边缘"}


def build_compare(mode="interactive"):
    with db() as conn:
        targets = [dict(r) for r in conn.execute("SELECT * FROM targets ORDER BY id")]
        latest = {}
        bills = {}
        for t in targets:
            r = conn.execute(
                "SELECT summary FROM benches WHERE target_id=? AND summary!=''"
                " ORDER BY id DESC LIMIT 1", (t["id"],)).fetchone()
            if r and r["summary"]:
                latest[t["id"]] = json.loads(r["summary"])
            b = conn.execute("SELECT data FROM bills WHERE target_id=?"
                             " ORDER BY id DESC LIMIT 1", (t["id"],)).fetchone()
            if b:
                try:
                    bills[t["id"]] = json.loads(b["data"])
                except Exception:
                    pass

    groups = []
    by_vendor = {}
    for t in targets:
        by_vendor.setdefault(t["vendor"] or "deepseek", []).append(t)

    order = [v["key"] for v in VENDORS]
    keys = sorted(by_vendor, key=lambda k: (order.index(k) if k in order else 999, k))

    for vk in keys:
        ts = by_vendor[vk]
        # 同品牌基线：显式标记的 > 按官方价原价卖的 > 数据最全的
        base_t = next((t for t in ts if t["is_base"]), None)
        if base_t is None:
            base_t = next((t for t in ts if abs(t["price_in"] - t["ref_in"]) < 1e-9
                           and abs(t["price_out"] - t["ref_out"]) < 1e-9), None)
        base_s = latest.get(base_t["id"]) if base_t else None
        base_ttft = base_s["ttft_mean"] if base_s and base_s.get("runs") else None

        # 折算工作量：优先用基线的实测 token，没有就按默认
        if base_s and base_s.get("runs"):
            w_in = float(base_s["input_tokens"])
            w_out = float(base_s["output_tokens"])
        else:
            w_in, w_out = FALLBACK_WORKLOAD

        rows = []
        for t in ts:
            s = latest.get(t["id"])
            is_base = bool(t["is_base"]) or t is base_t
            ref_cost = _call_cost(t["ref_in"], t["ref_out"], t["ref_cache"], w_in, w_out, 0)
            hit = s["cache_hit"] if (s and s.get("runs")) else 0

            # 有账单就用「实扣单价」算，没有才退回标价。
            # 这一步是必须的：标价和实扣能差好几倍（站点给账号的折扣不在牌价里）。
            ep = None
            if bills.get(t["id"]):
                try:
                    ep = billing.effective_prices(t, bills[t["id"]])
                except Exception:
                    ep = None
            if ep and ep.get("ok"):
                pin, pout, pcache = ep["in"], ep["out"], ep["cache"]
                basis = "billed"
            else:
                pin, pout, pcache = t["price_in"], t["price_out"], t["price_cache"]
                basis = "listed"
            rel_cost = _call_cost(pin, pout, pcache, w_in, w_out, hit)
            floor = (ep or {}).get("floor") or 0.0
            if floor:
                rel_cost = max(rel_cost, floor)   # 按次兜底
            ratio = (rel_cost / ref_cost) if ref_cost > 0 else 1.0
            listed_cost = _call_cost(t["price_in"], t["price_out"], t["price_cache"],
                                     w_in, w_out, hit)
            ratio_listed = (listed_cost / ref_cost) if ref_cost > 0 else 1.0
            ttft = s["ttft_mean"] if (s and s.get("runs")) else None
            dttft = (ttft - base_ttft) if (ttft is not None and base_ttft is not None) else None
            save10k = (ref_cost - rel_cost) * 10000
            wait_min = max(0.0, dttft) * 10000 / 60000.0 if dttft is not None else 0.0
            per_min = (save10k / wait_min) if wait_min > 0.01 else None
            runs = (s or {}).get("runs", 0)
            fails = (s or {}).get("fails", 0)
            is_off = is_official(t)
            v = _verdict(mode, ratio, dttft, per_min, fails, runs, is_base,
                         base_ttft is not None, is_off)
            if basis == "billed" and v["k"] not in ("base", "the"):
                v = dict(v)
                v["why"] += "（按实扣价算，不是标价）"
            if floor and rel_cost >= floor - 1e-12 and v["k"] not in ("base", "the"):
                v = dict(v)
                v["why"] += "；单次最低扣 ¥%.4f，这么小的请求被兜底吃掉了折扣" % floor
            rows.append({
                "id": t["id"], "name": t["name"], "model": t["model"],
                "vendor": vk, "is_base": is_base,
                "prices": {"in": t["price_in"], "out": t["price_out"], "cache": t["price_cache"]},
                "eff": {"in": pin, "out": pout, "cache": pcache, "floor": floor},
                "price_basis": basis, "ratio_listed": ratio_listed,
                "billed": ({"ratio": ep.get("ratio"), "floor": ep.get("floor"),
                            "spread": ep.get("spread"), "stable": ep.get("stable"),
                            "notes": ep.get("notes") or []} if (ep and ep.get("ok")) else None),
                "ref": {"in": t["ref_in"], "out": t["ref_out"], "cache": t["ref_cache"]},
                "summary": s, "runs": runs,
                "ratio": ratio, "ttft": ttft, "dttft": dttft,
                "save_per_10k": save10k, "wait_per_10k_min": wait_min,
                "per_min": per_min, "verdict": v,
                "score": (save10k if mode == "batch" else (per_min or 0.0)),
            })

        rank = {"base": 0, "rec": 1, "ok": 2, "the": 3, "bad": 4, "none": 5}
        cand = [r for r in rows if not r["is_base"] and r["runs"]]
        pick = None
        if cand:
            pick = sorted(cand, key=lambda r: (rank[r["verdict"]["k"]],
                                               -(r["score"] if mode == "batch" else r["score"])))[0]
            if pick["verdict"]["k"] in ("bad", "none"):
                pick = None
        rows.sort(key=lambda r: (rank[r["verdict"]["k"]], -(r["score"] if mode == "batch" else r["score"])))
        base_official = is_official(base_t) if base_t else False
        groups.append({
            "vendor": vk, "name": vendor_name(vk),
            "est": bool(VENDOR_MAP.get(vk, {}).get("est")),
            "baseline_id": base_t["id"] if base_t else None,
            "baseline_ttft": base_ttft,
            "base_official": base_official,
            "base_name": base_t["name"] if base_t else "",
            "workload": {"in": w_in, "out": w_out},
            "targets": rows,
            "pick": pick,
        })

    # 全局首选：所有品牌里最划算的那一个
    all_picks = [g["pick"] for g in groups if g["pick"]]
    best = None
    if all_picks:
        best = sorted(all_picks, key=lambda r: -r["score"])[0]

    # 同一工作量比价：三个典型场景，各自算单次成本。
    # 这一步解决的是「A 站 0.77 折、B 站 1.85 折，谁便宜」——
    # 两个「折」是在各自不同的 token 结构上算出来的，不能直接比。
    scenarios = []
    for key, label, wi, wo in SCENARIOS:
        items = []
        for g in groups:
            for r in g["targets"]:
                off = _call_cost(r["ref"]["in"], r["ref"]["out"], r["ref"]["cache"], wi, wo, 0)
                cost = _call_cost(r["eff"]["in"], r["eff"]["out"], r["eff"]["cache"], wi, wo, 0)
                if r["eff"].get("floor"):
                    cost = max(cost, r["eff"]["floor"])
                items.append({"id": r["id"], "name": r["name"], "vendor": g["name"],
                              "is_base": r["is_base"], "basis": r["price_basis"],
                              "stable": (r["billed"] or {}).get("stable"),
                              "cost": cost, "official": off,
                              "ratio": (cost / off) if off > 0 else None})
        items.sort(key=lambda x: x["cost"])
        scenarios.append({"key": key, "label": label, "in": wi, "out": wo,
                          "rows": items,
                          "cheapest": items[0]["id"] if items else None})
    return {"mode": mode, "groups": groups, "best": best, "scenarios": scenarios}


# ------------------------------------------------------------------ http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "relayhub/2.0"

    def log_message(self, fmt, *args):
        if "/api/bench/" in (self.path or ""):
            return
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # -- helpers ---------------------------------------------------
    def _send(self, code, body, ctype="application/json; charset=utf-8", cors=False):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cors:
            self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        """给浏览器脚本的两个推送口（auth / bill ingest）用。"""
        origin = self.headers.get("Origin") or ""
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome 的 Private Network Access：公网页面访问 localhost 必须带这个
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def do_OPTIONS(self):
        if urllib.parse.urlparse(self.path).path in ("/api/auth/ingest", "/api/bill/ingest"):
            self.send_response(204)
            self._cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(404, {"error": "not found"})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return {}

    # -- routes ----------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path in ("/", "/index.html"):
                return self._file("index.html")
            if path.startswith("/static/"):
                return self._file(path[len("/static/"):])
            if path == "/api/vendors":
                return self._send(200, VENDORS)
            if path == "/api/targets":
                return self._send(200, self.list_targets())
            if path == "/api/benches":
                return self._send(200, self.list_benches())
            if path == "/api/compare":
                mode = (qs.get("mode") or ["interactive"])[0]
                return self._send(200, build_compare(mode if mode in ("interactive", "batch") else "interactive"))
            m = re.match(r"^/api/bench/([a-f0-9]+)$", path)
            if m:
                job = _jobs.get(m.group(1))
                if not job:
                    return self._send(404, {"error": "job not found"})
                out = {k: v for k, v in job.items() if k != "rows"}
                out["rows"] = job["rows"][-40:]
                return self._send(200, out)
            m = re.match(r"^/api/bill/(\d+)$", path)
            if m:
                return self._send(200, self.get_bill(int(m.group(1))))
            return self._send(404, {"error": "not found"})
        except (RuntimeError, ValueError) as e:
            return self._send(400, {"error": str(e)})
        except Exception:
            return self._send(500, {"error": _last_line()})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            data = self._body()
            if path == "/api/auth/ingest":
                return self._send(200, self.ingest_auth(data), cors=True)
            if path == "/api/bill/ingest":
                return self._send(200, self.ingest_bill(data), cors=True)
            if path == "/api/targets":
                return self._send(200, self.upsert_target(data))
            if path == "/api/targets/delete":
                return self._send(200, self.delete_target(data))
            if path == "/api/bench":
                return self._send(200, self.start_bench(data))
            if path == "/api/bench/cancel":
                job = _jobs.get(data.get("job_id"))
                if job:
                    job["cancel"] = True
                return self._send(200, {"ok": True})
            if path == "/api/targets/price-preview":
                return self._send(200, self.price_preview(data))
            if path == "/api/models/fetch":
                return self._send(200, self.models_fetch(data))
            if path == "/api/bill/probe":
                return self._send(200, self.bill_probe(data))
            if path == "/api/bill/sync":
                return self._send(200, self.bill_sync(data))
            if path == "/api/bill/paste":
                return self._send(200, self.bill_paste(data))
            if path == "/api/bill/recalc":
                return self._send(200, self.bill_recalc(data))
            if path == "/api/bill/manual":
                return self._send(200, self.bill_manual(data))
            if path == "/api/bill/delete":
                return self._send(200, self.bill_delete(data))
            return self._send(404, {"error": "not found"})
        except (RuntimeError, ValueError) as e:
            return self._send(400, {"error": str(e)})
        except Exception:
            return self._send(500, {"error": _last_line()})

    def _file(self, name):
        p = os.path.join(STATIC, name.replace("..", ""))
        if not os.path.exists(p):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ctype = "text/html; charset=utf-8"
        if p.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif p.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        with open(p, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- handlers --------------------------------------------------
    def list_targets(self):
        conn = db()
        try:
            rows = [dict(r) for r in conn.execute("SELECT * FROM targets ORDER BY id")]
        finally:
            conn.close()
        for r in rows:
            r["api_key_masked"] = mask(r["api_key"])
            r.pop("api_key", None)
            r["vendor_name"] = vendor_name(r.get("vendor"))
        return rows

    def upsert_target(self, d):
        name = (d.get("name") or "").strip()
        base = (d.get("base_url") or "").strip()
        model = (d.get("model") or "deepseek-flash").strip()
        vendor = (d.get("vendor") or "deepseek").strip()
        if not name or not base:
            raise ValueError("name 和 base_url 必填")

        def price(key, fallback):
            v = d.get(key)
            try:
                return max(0.0, float(v))
            except (TypeError, ValueError):
                return fallback

        p_in = price("price_in", CNY_PRICES["input_miss"])
        p_out = price("price_out", CNY_PRICES["output"])
        p_cache = price("price_cache", CNY_PRICES["input_hit"])
        ref = lookup_ref(vendor, model) or {}
        r_in = price("ref_in", ref.get("in", CNY_PRICES["input_miss"]))
        r_out = price("ref_out", ref.get("out", CNY_PRICES["output"]))
        r_cache = price("ref_cache", ref.get("cache", CNY_PRICES["input_hit"]))
        is_base = 1 if d.get("is_base") else 0
        key = d.get("api_key") or ""

        conn = db()
        try:
            if d.get("id"):
                row = conn.execute("SELECT api_key FROM targets WHERE id=?", (d["id"],)).fetchone()
                if not row:
                    raise ValueError("目标不存在")
                if not key:
                    key = row["api_key"]
                conn.execute(
                    "UPDATE targets SET name=?, base_url=?, model=?, api_key=?, vendor=?,"
                    " price_in=?, price_out=?, price_cache=?, ref_in=?, ref_out=?, ref_cache=?,"
                    " is_base=?, note=? WHERE id=?",
                    (name, base, model, key, vendor, p_in, p_out, p_cache,
                     r_in, r_out, r_cache, is_base, d.get("note", ""), d["id"]))
                tid = d["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO targets(name, base_url, model, api_key, vendor, price_in,"
                    " price_out, price_cache, ref_in, ref_out, ref_cache, is_base, note, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (name, base, model, key, vendor, p_in, p_out, p_cache,
                     r_in, r_out, r_cache, is_base, d.get("note", ""),
                     time.strftime("%Y-%m-%d %H:%M:%S")))
                tid = cur.lastrowid
            if is_base:
                conn.execute("UPDATE targets SET is_base=0 WHERE vendor=? AND id<>?", (vendor, tid))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "id": tid}

    def delete_target(self, d):
        tid = d.get("id")
        conn = db()
        try:
            conn.execute("DELETE FROM runs WHERE bench_id IN"
                         " (SELECT id FROM benches WHERE target_id=?)", (tid,))
            conn.execute("DELETE FROM benches WHERE target_id=?", (tid,))
            conn.execute("DELETE FROM bills WHERE target_id=?", (tid,))
            conn.execute("DELETE FROM bill_sources WHERE target_id=?", (tid,))
            conn.execute("DELETE FROM targets WHERE id=?", (tid,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    def start_bench(self, d):
        tid = int(d.get("target_id"))
        conn = db()
        try:
            row = conn.execute("SELECT * FROM targets WHERE id=?", (tid,)).fetchone()
        finally:
            conn.close()
        if not row:
            raise ValueError("target 不存在")
        params = {
            "runs": max(1, min(200, int(d.get("runs") or 10))),
            "warmup": max(0, min(10, int(d.get("warmup", 2)))),
            "max_tokens": max(16, min(8000, int(d.get("max_tokens") or 1024))),
            # 默认跟随模型（平时都开着思考，就别用关闭状态去代表日常）
            "thinking": d.get("thinking") or "default",
            "effort": d.get("effort") or None,
            "prompt": d.get("prompt") or DEFAULT_PROMPT,
            "system": d.get("system") or "",
        }
        # 思考会吃掉 max_tokens：额度太小会正文截断，测出来的速度/价格都是错的
        if params["thinking"] != "disabled" and params["max_tokens"] < 512:
            params["max_tokens"] = 1024
        job_id = os.urandom(6).hex()
        _jobs[job_id] = {
            "id": job_id, "status": "running", "done": 0,
            "total": params["runs"], "rows": [], "errors": [],
            "phase": "connect", "target": row["name"], "summary": None,
        }
        t = threading.Thread(target=run_bench_job, args=(job_id, row, params), daemon=True)
        t.start()
        return {"job_id": job_id}

    def list_benches(self):
        conn = db()
        try:
            rows = conn.execute(
                "SELECT b.id, b.started_at, b.summary, t.name, t.model, t.vendor"
                " FROM benches b JOIN targets t ON t.id=b.target_id"
                " WHERE b.summary IS NOT NULL AND b.summary!=''"
                " ORDER BY b.id DESC LIMIT 60").fetchall()
        finally:
            conn.close()
        out = []
        for r in rows:
            d = dict(r)
            d["summary"] = json.loads(d["summary"]) if d["summary"] else None
            d["vendor_name"] = vendor_name(d.get("vendor"))
            out.append(d)
        return out

    # -- 账单 ------------------------------------------------------
    def _target(self, tid):
        conn = db()
        try:
            row = conn.execute("SELECT * FROM targets WHERE id=?", (tid,)).fetchone()
        finally:
            conn.close()
        if not row:
            raise ValueError("目标不存在")
        return dict(row)

    def _source(self, tid):
        conn = db()
        try:
            row = conn.execute("SELECT * FROM bill_sources WHERE target_id=?", (tid,)).fetchone()
        finally:
            conn.close()
        return dict(row) if row else None

    def ingest_auth(self, d):
        """在站点控制台里跑的脚本把凭据送回本机，省掉手动复制 Cookie。"""
        host = (d.get("host") or "").strip().lower().split(":")[0]
        token = (d.get("token") or "").strip()
        cookie = (d.get("cookie") or "").strip()
        uid = str(d.get("user_id") or "").strip()
        if not (token or cookie):
            return {"ok": False, "error": "没收到 token / cookie"}
        hit = None
        for t in self.list_targets():
            if host and host in (t.get("base_url") or "").lower():
                hit = t
                break
        if not hit:
            return {"ok": False, "error": "本地没有 base_url 含 %s 的中转站，先在界面上加一个"
                                          % (host or "?")}
        src = self._source(hit["id"]) or {}
        kw = {
            "kind": src.get("kind") or "oneapi",
            "api_base": src.get("api_base") or hit["base_url"],
            "token": token or (src.get("token") or ""),
            "cookie": cookie or (src.get("cookie") or ""),
            "user_id": uid or (src.get("user_id") or ""),
        }
        self._save_source(hit["id"], **kw)
        return {"ok": True, "target_id": hit["id"], "target": hit.get("name"),
                "has_token": bool(kw["token"]), "user_id": kw["user_id"]}

    def ingest_bill(self, d):
        """浏览器里跑的脚本把账单原始明细推过来。

        为什么需要这条通道：RelayHub 是跑在本机 python 里的，它走的出口网络不一定
        到得了站点（代理 502、直连超时都遇到过），而用户的浏览器是通的。
        让浏览器去拉 /api/log/self，把明细推回来，服务器只负责解析和核对。
        """
        host = (d.get("host") or "").strip().lower().split(":")[0]
        hit = None
        if d.get("target_id"):
            try:
                hit = self._target(int(d["target_id"]))
            except Exception:
                hit = None
        if not hit and host:
            for t in self.list_targets():
                if host in (t.get("base_url") or "").lower():
                    hit = t
                    break
        if not hit:
            return {"ok": False, "error": "本地没有 base_url 含 %s 的中转站，先在界面上加一个"
                                          % (host or "?")}

        recs = [r for r in (d.get("logs") or []) if isinstance(r, dict)]
        if not recs:
            for pg in (d.get("pages") or []):
                obj = pg.get("body") if isinstance(pg, dict) else pg
                if isinstance(obj, str):
                    try:
                        obj = json.loads(obj)
                    except Exception:
                        continue
                found = billing._find_records(obj)
                if found:
                    recs.extend(found[0])
        if not recs:
            return {"ok": False, "error": "推过来的数据里没有明细数组，"
                                          "刷新页面重新复制一次脚本再跑"}
        recs.sort(key=lambda r: billing._parse_ts(billing._pick(r, "ts")))

        cost_unit = (d.get("cost_unit") or "").strip()
        if not cost_unit:
            # 脚本能拿到站点自己的 quota_per_unit，说明金额列是内部额度而不是元
            cost_unit = "quota" if d.get("quota_per_unit") else "auto"
        bill = billing.parse_paste(
            {"data": {"items": recs}},
            quota_per_unit=d.get("quota_per_unit") or None,
            # 站点的 $ 默认按符号处理（充 1 元 = $1）；真按美元收费才用 fx
            usd_cny=billing.rate_for(d.get("usd_cny"),
                                     (d.get("rate_mode") or "one").strip()),
            source="script",
            cost_unit=cost_unit)

        u = d.get("user") if isinstance(d.get("user"), dict) else {}
        acct = bill.get("account") or {}
        if u.get("quota") is not None:
            acct["balance_quota"] = billing._num(u.get("quota"))
            k = acct.get("cny_per_quota") or 0
            if k:
                acct["balance"] = round(acct["balance_quota"] * k, 6)
        if u.get("used_quota") is not None:
            acct["used_quota"] = billing._num(u.get("used_quota"))
        if u.get("id"):
            acct["user_id"] = str(u.get("id"))
        bill["account"] = acct

        head = "浏览器脚本推送：%d 条明细" % len(bill["logs"])
        bill["notes"] = [head] + [n for n in (bill.get("notes") or []) if n != head]
        self._save_bill(hit["id"], bill)
        self._save_source(hit["id"], kind="oneapi",
                          user_id=str(u.get("id") or "") or (self._source(hit["id"]) or {}).get("user_id") or "",
                          last_sync=time.strftime("%Y-%m-%d %H:%M:%S"), last_error="")
        out = self.get_bill(hit["id"])
        out["ingested"] = {"logs": len(bill["logs"]), "target": hit.get("name")}
        return out

    def _save_source(self, tid, **kw):
        conn = db()
        try:
            exists = conn.execute("SELECT target_id FROM bill_sources WHERE target_id=?",
                                  (tid,)).fetchone()
            if exists:
                sets = ",".join("%s=?" % k for k in kw)
                conn.execute("UPDATE bill_sources SET %s WHERE target_id=?" % sets,
                             list(kw.values()) + [tid])
            else:
                cols = ["target_id"] + list(kw.keys())
                ph = ",".join(["?"] * len(cols))
                conn.execute("INSERT INTO bill_sources(%s) VALUES (%s)"
                             % (",".join(cols), ph), [tid] + list(kw.values()))
            conn.commit()
        finally:
            conn.close()

    def _save_bill(self, tid, bill):
        t = bill["totals"]
        conn = db()
        try:
            conn.execute(
                "INSERT INTO bills(target_id,taken_at,source,cost,requests,tin,tout,tcache,data)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (tid, bill.get("taken_at"), bill.get("source"), t.get("cost", 0),
                 t.get("requests", 0), t.get("in", 0), t.get("out", 0), t.get("cache", 0),
                 json.dumps(bill, ensure_ascii=False)))
            conn.commit()
        finally:
            conn.close()

    def get_bill(self, tid):
        target = self._target(tid)
        src = self._source(tid)
        conn = db()
        try:
            rows = conn.execute("SELECT * FROM bills WHERE target_id=? ORDER BY id",
                                (tid,)).fetchall()
            brow = conn.execute(
                "SELECT summary FROM benches WHERE target_id=? AND summary!=''"
                " ORDER BY id DESC LIMIT 1", (tid,)).fetchone()
        finally:
            conn.close()

        hist, slim = [], []
        for r in rows:
            try:
                d = json.loads(r["data"])
            except Exception:
                continue
            hist.append(d)
            slim.append({"id": r["id"], "taken_at": r["taken_at"],
                         "source": r["source"], "totals": d.get("totals") or {}})
        latest = hist[-1] if hist else None
        bench_summary = None
        if brow and brow["summary"]:
            try:
                bench_summary = json.loads(brow["summary"])
            except Exception:
                pass
        report = audit.run(target, latest, bench_summary, hist[-10:])

        out_src = None
        if src:
            out_src = {k: v for k, v in src.items() if k not in ("token", "cookie")}
            out_src["token_masked"] = mask(src.get("token"))
            out_src["has_token"] = bool(src.get("token"))
            out_src["has_cookie"] = bool(src.get("cookie"))
            out_src["cookie_len"] = len(src.get("cookie") or "")

        if latest:
            latest = dict(latest)
            logs = latest.get("logs") or []
            latest["log_count"] = len(logs)
            latest["logs"] = logs[-80:]
        return {
            "target": {"id": target["id"], "name": target["name"],
                       "model": target["model"], "vendor": target.get("vendor"),
                       "price": {"in": target["price_in"], "out": target["price_out"],
                                 "cache": target["price_cache"]},
                       "ref": {"in": target["ref_in"], "out": target["ref_out"],
                               "cache": target["ref_cache"]}},
            "source": out_src, "latest": latest,
            "history": slim[-40:], "audit": report,
        }

    def bill_probe(self, d):
        base = (d.get("api_base") or "").strip()
        if not base and d.get("target_id"):
            base = self._target(int(d["target_id"]))["base_url"]
        if not base:
            raise ValueError("先填一个站点地址")
        return billing.probe(base, insecure=bool(d.get("insecure")))

    def price_preview(self, d):
        """读站点牌价 + 最近一次账单的实测单价，给「实际标价」自动填表用。

        没保存过的新目标也能用：传 base_url + model + api_key 即可。
        """
        tid = d.get("id")
        if tid:
            t = self._target(int(tid))
            src = self._source(t["id"]) or {}
        else:
            t = {"id": 0, "base_url": "", "model": "", "api_key": "",
                 "ref_in": 0, "ref_out": 0, "ref_cache": 0}
            src = {}
        base = (d.get("base_url") or t["base_url"] or "").strip()
        model = (d.get("model") or t["model"] or "").strip()
        listed = billing.fetch_listed_prices(
            base, model, token=str(src.get("token") or ""),
            cookie=str(src.get("cookie") or ""), user_id=str(src.get("user_id") or ""),
            insecure=bool(d.get("insecure")))

        measured = {}
        row = None
        if tid:
            conn = db()
            try:
                row = conn.execute("SELECT data FROM bills WHERE target_id=?"
                                   " ORDER BY id DESC LIMIT 1", (t["id"],)).fetchone()
            finally:
                conn.close()
        if row:
            try:
                b = json.loads(row["data"])
                logs = b.get("logs") or []
                # 一律换成人民币：one-api 的 quota 是内部额度，不能直接当元用
                k = (b.get("account") or {}).get("cny_per_quota") or 1.0
                fit = billing.fit_unit_prices(logs, k)
                if fit.get("ok"):
                    measured = {"in": fit["in"], "out": fit["out"], "n": fit["n"]}
                tin = sum(l.get("in", 0) for l in logs)
                tout = sum(l.get("out", 0) for l in logs)
                cost = sum(l.get("cost") or 0 for l in logs)
                if tin + tout:
                    measured["blended"] = cost / (tin + tout) * 1e6
                    measured["n"] = len(logs)
                    measured["cost"] = cost
            except Exception:
                pass
        return {"listed": listed, "measured": measured,
                "ref": {"in": t["ref_in"], "out": t["ref_out"], "cache": t["ref_cache"]}}

    def models_fetch(self, d):
        """读「这个 key 能调的」模型名单，给「模型」下拉框自动填充用。

        catalog=1 才读全站公开价目表（不按 key 过滤），默认只按 key 读。
        """
        tid = d.get("target_id")
        t = self._target(int(tid)) if tid else None
        src = (self._source(int(tid)) or {}) if tid else {}
        base = (d.get("api_base") or (t["base_url"] if t else "") or "").strip()
        key = (d.get("api_key") or "").strip()
        key_source = "input" if key else ""
        if not key and t:
            key = (t.get("api_key") or "").strip()
            key_source = "saved" if key else ""
        out = billing.fetch_site_models(
            base, api_key=key, token=str(src.get("token") or ""),
            cookie=str(src.get("cookie") or ""), user_id=str(src.get("user_id") or ""),
            insecure=bool(d.get("insecure")), catalog=bool(d.get("catalog")))
        out["key_source"] = key_source
        for m in out["models"]:
            m["guess"] = guess_model(m["id"])
        return out

    def bill_sync(self, d):
        tid = int(d["target_id"])
        target = self._target(tid)
        src = self._source(tid) or {}
        kind = (d.get("kind") or "auto").strip()
        base = (d.get("api_base") or src.get("api_base") or target["base_url"]).strip()

        def pick(key):
            v = d.get(key)
            if v not in (None, ""):
                return v
            return src.get(key) or ""

        token, cookie, uid = pick("token"), pick("cookie"), pick("user_id")
        qpu = d.get("quota_per_unit") or src.get("quota_per_unit") or None
        rate = d.get("usd_cny") or src.get("usd_cny") or None
        # 「站点的 $ 当 ¥ 用」是默认；真按美元收费才传 fx
        rate_mode = (d.get("rate_mode") or "one").strip()
        days = max(1, min(90, int(d.get("days") or 7)))
        try:
            # 每次都探一次：站点属于哪一系不能靠界面上的标签猜，
            # 老版本把 kind 存成 oneapi 的站点会一直被当 one-api 处理（404 就卡死在这）。
            pr = billing.probe(base, insecure=bool(d.get("insecure")))
            detected = pr.get("kind")
            first_note = (pr.get("notes") or ["探测失败"])[0]
            if first_note.startswith("连不上站点"):
                raise RuntimeError(
                    "%s。这是本机出口的网到不了那个站（代理 502 或直连超时），不是你填错了。"
                    "改用在站点控制台跑脚本——浏览器能访问，让它把账单推回来。"
                    % first_note)
            bill = None
            if detected in ("oneapi", "openslate"):
                kind = detected
            elif kind == "auto":
                # 有些 new-api 站把 /api/status 关了：探不出来，不代表 /api/log/self 读不了。
                # 手里有令牌就按 one-api 强读一次，读到了算数，读不到再把话说清楚。
                if not (token or cookie):
                    raise RuntimeError(
                        "这个站的账单接口没认出来（%s）。填上后台令牌/ Cookie 再同步，"
                        "或改用「粘贴导入」。"
                        % (pr.get("notes") or ["探测失败"])[0])
                try:
                    bill = billing.fetch_oneapi(
                        base, token=token, cookie=cookie, user_id=str(uid),
                        days=days,
                        quota_per_unit=float(qpu) if qpu else None,
                        usd_cny=float(rate) if rate else billing.DEFAULT_USD_CNY,
                        rate_mode=rate_mode, insecure=bool(d.get("insecure")))
                    kind = "oneapi"
                except Exception as e2:
                    raise RuntimeError(
                        "这个站的账单接口没认出来（%s）；按 one-api 强读也失败：%s"
                        % ((pr.get("notes") or ["探测失败"])[0], e2))

            if bill is None:
                if kind == "openslate":
                    bill = billing.fetch_openslate(
                        base, token=token, days=days,
                        insecure=bool(d.get("insecure")))
                elif kind == "oneapi":
                    bill = billing.fetch_oneapi(
                        base, token=token, cookie=cookie, user_id=str(uid),
                        days=days,
                        quota_per_unit=float(qpu) if qpu else None,
                        usd_cny=float(rate) if rate else billing.DEFAULT_USD_CNY,
                        rate_mode=rate_mode, insecure=bool(d.get("insecure")))
                else:
                    raise RuntimeError("直连同步只支持 one-api 系和 OpenSlate 系站点")
            self._save_bill(tid, bill)
            self._save_source(tid, kind=kind, api_base=base, token=token or "",
                              cookie=cookie or "", user_id=str(uid or ""),
                              quota_per_unit=float(qpu or 0), usd_cny=float(rate or 0),
                              last_sync=time.strftime("%Y-%m-%d %H:%M:%S"), last_error="")

            # 标价一次都没填过的，顺手按站点牌价补上（只填空的，不覆盖你手填的）
            if not (target["price_in"] or target["price_out"]):
                try:
                    lp = billing.fetch_listed_prices(
                        base, target["model"], token=token, cookie=cookie,
                        user_id=str(uid or ""), insecure=bool(d.get("insecure")))
                    if lp.get("ok"):
                        conn = db()
                        try:
                            conn.execute(
                                "UPDATE targets SET price_in=?, price_out=?, price_cache=?"
                                " WHERE id=?",
                                (round(lp["in"], 6), round(lp["out"], 6),
                                 round(lp["cache"], 6), tid))
                            conn.commit()
                        finally:
                            conn.close()
                except Exception:
                    pass
        except Exception as e:
            self._save_source(tid, kind=kind, api_base=base, token=token or "",
                              cookie=cookie or "", user_id=str(uid or ""),
                              quota_per_unit=float(qpu or 0), usd_cny=float(rate or 0),
                              last_error=str(e)[:300])
            raise
        return self.get_bill(tid)

    def bill_paste(self, d):
        tid = int(d["target_id"])
        raw = (d.get("json") or "").strip()
        if not raw:
            raise ValueError("把后台接口的 JSON 贴进来")
        try:
            obj = json.loads(raw)
        except Exception as e:
            raise ValueError("这不是合法 JSON：%s" % e)
        # 控制台脚本复制的数据里自带换算参数（_hub），不然 quota 会被当成人民币
        hub = obj.get("_hub") if isinstance(obj, dict) else None
        hub = hub if isinstance(hub, dict) else {}
        qpu = d.get("quota_per_unit") or hub.get("quota_per_unit") or None
        mode = (d.get("rate_mode") or "one").strip()
        rate = billing.rate_for(
            (float(d["usd_cny"]) if d.get("usd_cny") else None) or hub.get("usd_cny"),
            mode)
        unit = (d.get("cost_unit") or "").strip()
        if unit in ("", "auto"):
            unit = "quota" if qpu else "auto"
        bill = billing.parse_paste(
            obj, quota_per_unit=qpu, usd_cny=rate,
            source="paste", cost_unit=unit)
        self._save_bill(tid, bill)
        return self.get_bill(tid)

    def bill_recalc(self, d):
        """改「那个 $ 是不是真美元」：拿账单里留着的原始 quota 重算，不用重新导入。"""
        tid = int(d["target_id"])
        mode = (d.get("rate_mode") or "one").strip()
        conn = db()
        try:
            row = conn.execute(
                "SELECT id, data FROM bills WHERE target_id=? ORDER BY id DESC LIMIT 1",
                (tid,)).fetchone()
        finally:
            conn.close()
        if not row:
            raise ValueError("这个站还没有账单，先同步或导入一份")
        try:
            obj = json.loads(row["data"])
        except Exception:
            raise ValueError("账单数据损坏了，重新导一次吧")
        acc = obj.get("account") or {}
        rate = billing.rate_for(
            (float(d["usd_cny"]) if d.get("usd_cny") else None) or acc.get("site_rate"),
            mode)
        bill = billing.recalc(
            obj, usd_cny=rate,
            quota_per_unit=d.get("quota_per_unit") or acc.get("quota_per_unit"),
            mode=mode)
        t = bill["totals"]
        conn = db()
        try:
            conn.execute(
                "UPDATE bills SET cost=?, requests=?, tin=?, tout=?, tcache=?, data=?"
                " WHERE id=?",
                (t.get("cost", 0), t.get("requests", 0), t.get("in", 0),
                 t.get("out", 0), t.get("cache", 0),
                 json.dumps(bill, ensure_ascii=False), row["id"]))
            conn.commit()
        finally:
            conn.close()
        return self.get_bill(tid)

    def bill_manual(self, d):
        tid = int(d["target_id"])
        bill = billing.manual_bill(
            d.get("requests"), d.get("cost"), d.get("tin"), d.get("tout"),
            d.get("tcache"), source_note=d.get("note") or "手工填写的汇总数字")
        if not (bill["totals"]["requests"] or bill["totals"]["cost"]):
            raise ValueError("请求数和消费金额至少填一个")
        self._save_bill(tid, bill)
        return self.get_bill(tid)

    def bill_delete(self, d):
        conn = db()
        try:
            if d.get("all"):
                conn.execute("DELETE FROM bills WHERE target_id=?", (int(d["target_id"]),))
            else:
                conn.execute("DELETE FROM bills WHERE id=?", (int(d["id"]),))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}


def main():
    port = 8770
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    init_db()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("relayhub 已启动: http://127.0.0.1:%d" % port)
    print("数据文件: %s" % DB_PATH)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
