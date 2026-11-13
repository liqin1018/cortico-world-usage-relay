#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bench.py -- latency / throughput / cost benchmark for ANY OpenAI-compatible
chat endpoint (DeepSeek official, a 中转站, OpenRouter, vLLM, Ollama, ...).

Standard library only. Python 3.8+. No pip install needed.

Why raw HTTP instead of the openai SDK:
  relays often drop unknown params, swallow error bodies, or fake usage stats.
  Raw HTTP shows you the real status code and the real response body.

What it measures, per run:
  ttft_ms          request sent  ->  first delta of ANY kind (reasoning or text)
  first_answer_ms  request sent  ->  first delta of the visible answer
                   (with thinking on, this is the real "why is it stuck" number)
  total_ms         request sent  ->  stream closed
  tps              output tokens per second, measured over the decode window
                   (last delta - first delta), not including ttft
  tokens           input / cache-hit input / output / reasoning

Costs use USD per 1M tokens; DeepSeek peak = 2x off-peak.

Examples
--------
# single target, official DeepSeek
python bench.py --base-url https://api.deepseek.com --model deepseek-flash \
    --key sk-xxx --runs 20

# compare official vs a relay, same prompt, same params
python bench.py --config targets.json --runs 20

# thinking off (cheap + fast), 50 runs, write outputs
python bench.py --config targets.json --runs 50 --thinking disabled \
    --csv out.csv --json out.json
"""

import argparse
import csv
import json
import os
import socket
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- defaults

# USD per 1M tokens. DeepSeek deepseek-flash, off-peak.
DEFAULT_PRICES = {
    "input_miss": 0.15,   # cache miss input
    "input_hit": 0.003,   # cache hit input
    "output": 0.60,       # output (reasoning tokens are billed as output)
    "usd_cny": 7.1,
}

DEFAULT_PROMPT = (
    "Explain how a B-tree index speeds up range queries in a relational database, "
    "and why it slows down writes. Use concrete examples where useful. "
    "Keep it under 400 words."
)

DEFAULT_SYSTEM = "You are a precise technical assistant. Answer directly."

# 请求头里带一个正常客户端的 UA。留空的 urllib 默认 UA 会被 Cloudflare 拦成 403。
DEFAULT_UA = "openai-python/1.40.0"

# DeepSeek peak windows: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri.
PEAK_WINDOWS_UTC = ((1, 4), (6, 10))


# ---------------------------------------------------------------- helpers

def est_tokens(text):
    """Rough token estimate used only when the endpoint returns no usage."""
    if not text:
        return 0
    cjk = sum(1 for ch in text if "\u3400" <= ch <= "\u9fff")
    other = len(text) - cjk
    return max(1, int(cjk + other / 3.8))


def pct(values, q):
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    idx = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return float(s[idx])


def stat_line(label, values, unit=""):
    if not values:
        return "  %-16s %s" % (label, "n/a")
    return "  %-16s mean %8.1f%s  median %8.1f%s  p95 %8.1f%s  min %8.1f  max %8.1f" % (
        label,
        statistics.mean(values), unit,
        statistics.median(values), unit,
        pct(values, 0.95), unit,
        min(values), max(values),
    )


def endpoint_url(base_url):
    """Accept .../v1, .../v1/, .../chat/completions, or a bare host."""
    u = base_url.rstrip("/")
    if u.endswith("/chat/completions"):
        return u
    return u + "/chat/completions"


def current_tier(now_utc=None):
    t = now_utc or time.gmtime()
    if t.tm_wday >= 5:              # Sat / Sun: always off-peak
        return "off-peak"
    for lo, hi in PEAK_WINDOWS_UTC:
        if lo <= t.tm_hour < hi:
            return "peak"
    return "off-peak"


def load_targets(args):
    targets = []
    prices = dict(DEFAULT_PRICES)

    if args.config:
        with open(args.config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        prices.update({k: v for k, v in (cfg.get("prices") or {}).items() if v is not None})
        for t in cfg.get("targets", []):
            key = t.get("api_key") or ""
            if not key and t.get("api_key_env"):
                key = os.environ.get(t["api_key_env"], "")
            targets.append({
                "name": t.get("name") or t.get("base_url", "target"),
                "base_url": t["base_url"],
                "model": t.get("model", "deepseek-flash"),
                "api_key": key,
                "headers": t.get("headers") or {},
            })

    if args.base_url:
        key = args.key or os.environ.get("BENCH_API_KEY", "") or os.environ.get("DEEPSEEK_API_KEY", "")
        targets.append({
            "name": args.name or args.model,
            "base_url": args.base_url,
            "model": args.model,
            "api_key": key,
            "headers": {},
        })

    if not targets:
        sys.exit("error: pass --base-url ... or --config targets.json")

    for t in targets:
        if not t["api_key"]:
            sys.exit("error: target '%s' has no api_key" % t["name"])
        t.setdefault("_strip", set())      # params this endpoint rejected
        t.setdefault("_notes", [])
    return targets, prices


# ---------------------------------------------------------------- one request

def build_body(target, prompt, system, args):
    body = {
        "model": target["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": True,
        "max_tokens": args.max_tokens,
    }
    if "stream_options" not in target["_strip"]:
        body["stream_options"] = {"include_usage": True}
    if args.temperature is not None:
        body["temperature"] = args.temperature

    mode = args.thinking
    if mode == "disabled" and "thinking" not in target["_strip"]:
        body["thinking"] = {"type": "disabled"}
    elif mode == "enabled" and "thinking" not in target["_strip"]:
        body["thinking"] = {"type": "enabled"}
    if args.effort and "reasoning_effort" not in target["_strip"]:
        if not (mode == "disabled" and args.effort != "none"):
            body["reasoning_effort"] = args.effort
    return body


def run_once(target, prompt, system, args, prices, tier):
    """外壳：把底层的连接/读取异常翻成一句人话，别让 traceback 糊到界面上。"""
    try:
        return _run_once(target, prompt, system, args, prices, tier)
    except RuntimeError:
        raise
    except (TimeoutError, socket.timeout):
        raise RuntimeError("timeout: 站点在 %s 秒内没把响应发完（连接或读取超时），"
                           "多半是站点太慢或链路不稳" % args.timeout)
    except ssl.SSLError as e:
        raise RuntimeError("tls failed: %s（TLS 握手失败，站点前置代理有问题或网络不稳）" % e)
    except Exception as e:
        raise RuntimeError("%s: %s" % (type(e).__name__, e))


def _run_once(target, prompt, system, args, prices, tier):
    """Returns (metrics dict) or raises RuntimeError with a readable message."""
    url = endpoint_url(target["base_url"])
    body = build_body(target, prompt, system, args)
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + target["api_key"],
        "Accept": "text/event-stream",
        # 有的站前面挂着 Cloudflare，会把默认的 Python-urllib UA 当脚本拦掉，
        # 回一张 403 的网页而不是 JSON，看起来特别像 key 错了。用客户端 UA 走正常通道。
        "User-Agent": DEFAULT_UA,
    }
    headers.update(target["headers"])

    ctx = None
    if args.insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")

    t_send = time.perf_counter()
    try:
        resp = urllib.request.urlopen(req, timeout=args.timeout, context=ctx)
    except urllib.error.HTTPError as e:
        ctype = (e.headers.get("content-type") or "").lower()
        raw = b""
        if "text/html" not in ctype:
            # 挑战页/网关页不读 body：它们的长度头经常不准，读了会卡到超时
            try:
                raw = e.read(600)
            except Exception:
                pass
        text = raw.decode("utf-8", "replace")[:600]
        head = text.lstrip()[:20].lower()
        if "text/html" in ctype or head.startswith("<!doctype") or head.startswith("<html"):
            # 返回的是网页而不是接口报文，说明被前置防火墙拦了，跟 key 无关
            raise RuntimeError("HTTP %s %s | WAF_HTML | %s"
                               % (e.code, e.reason, text[:200] or "返回的是网页，不是接口报文"))
        # A 400 usually means this endpoint does not know our extra params.
        # Strip them one at a time so the next run succeeds, and say so loudly.
        if e.code == 400 and target["_strip"] is not None:
            for cand in ("stream_options", "reasoning_effort", "thinking"):
                if cand in body and cand not in target["_strip"]:
                    target["_strip"].add(cand)
                    target["_notes"].append("dropped '%s' after HTTP 400" % cand)
                    raise RuntimeError("400 retryable: %s | %s" % (cand, text))
        raise RuntimeError("HTTP %s %s | %s" % (e.code, e.reason, text))
    except urllib.error.URLError as e:
        raise RuntimeError("connection failed: %s" % e.reason)

    ttft = None
    first_answer = None
    last_delta = None
    n_reason = 0
    n_content = 0
    reason_chars = 0
    content_chars = 0
    usage = None
    finished = False
    truncated = False       # finish_reason=length：被 max_tokens 截断
    bare = ""

    with resp:
        for raw_line in resp:
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", "replace").strip()
            if not line:
                continue
            if not line.startswith("data:"):
                # Some relays emit plain JSON or keep-alives; keep the tail.
                bare = line
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                finished = True
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                bare = data
                continue

            if obj.get("error"):
                raise RuntimeError("stream error: %s" % json.dumps(obj["error"], ensure_ascii=False)[:400])
            if obj.get("usage"):
                usage = obj["usage"]

            for ch in obj.get("choices") or []:
                d = ch.get("delta") or {}
                rc = d.get("reasoning_content") or d.get("reasoning")
                ct = d.get("content")
                now = time.perf_counter()
                if rc:
                    if ttft is None:
                        ttft = now - t_send
                    n_reason += 1
                    reason_chars += len(rc)
                    last_delta = now
                if ct:
                    if ttft is None:
                        ttft = now - t_send
                    if first_answer is None:
                        first_answer = now - t_send
                    n_content += 1
                    content_chars += len(ct)
                    last_delta = now
                if ch.get("finish_reason"):
                    finished = True
                    if str(ch.get("finish_reason")).lower() == "length":
                        truncated = True

    t_end = time.perf_counter()
    total = t_end - t_send

    # A non-streaming relay sends one blob of JSON: parse it as a fallback.
    if n_content == 0 and n_reason == 0 and bare:
        try:
            obj = json.loads(bare)
            msg = (obj.get("choices") or [{}])[0].get("message") or {}
            usage = obj.get("usage") or usage
            content_chars = len(msg.get("content") or "")
            reason_chars = len(msg.get("reasoning_content") or "")
            n_content = 1 if content_chars else 0
            ttft = first_answer = total
            last_delta = t_end
            finished = True     # 非流式：一次性给完，不存在“被截断”的判断依据
        except json.JSONDecodeError:
            raise RuntimeError("no usable stream data; first line was: %s" % bare[:300])

    if n_content == 0 and n_reason == 0:
        raise RuntimeError("endpoint returned no content (stream may be disabled)")

    if ttft is None:
        ttft = total
    if first_answer is None:
        first_answer = total

    # ---- token accounting
    estimated = False
    if usage:
        in_tok = int(usage.get("prompt_tokens") or 0)
        out_tok = int(usage.get("completion_tokens") or 0)
        hit = int(usage.get("prompt_cache_hit_tokens") or
                  (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
        reason_tok = int((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
    else:
        estimated = True
        in_tok = est_tokens(system) + est_tokens(prompt)
        out_tok = max(1, int(content_chars / 3.8)) + int(reason_chars / 3.8)
        hit = 0
        reason_tok = int(reason_chars / 3.8)
    hit = max(0, min(hit, in_tok))
    miss = in_tok - hit

    decode_window = (last_delta - (ttft + t_send)) if last_delta else 0.0
    tps = (out_tok - 1) / decode_window if decode_window > 1e-6 and out_tok > 1 else 0.0

    unit = {"input_miss": prices["input_miss"], "input_hit": prices["input_hit"], "output": prices["output"]}
    if tier == "peak":
        unit = {k: v * 2 for k, v in unit.items()}
    cost = (miss * unit["input_miss"] + hit * unit["input_hit"] + out_tok * unit["output"]) / 1e6

    return {
        "ttft_ms": ttft * 1000,
        "first_answer_ms": first_answer * 1000,
        "total_ms": total * 1000,
        "tps": tps,
        "input_tokens": in_tok,
        "cache_hit_tokens": hit,
        "output_tokens": out_tok,
        "reasoning_tokens": reason_tok,
        "content_chars": content_chars,
        "reasoning_chars": reason_chars,
        "cost_usd": cost,
        "estimated_usage": estimated,
        "finished": finished,
        "truncated": truncated,
    }


# ---------------------------------------------------------------- driver

def bench_target(target, args, prices, tier):
    prompt = args.prompt
    if args.prompt_file:
        with open(args.prompt_file, "r", encoding="utf-8") as f:
            prompt = f.read()
    system = args.system

    rows, errors = [], []
    total_runs = args.runs + args.warmup
    for i in range(total_runs):
        warm = i < args.warmup
        label = "warmup" if warm else "run %d/%d" % (i - args.warmup + 1, args.runs)
        attempt = 0
        while True:
            attempt += 1
            try:
                m = run_once(target, prompt, system, args, prices, tier)
                break
            except RuntimeError as e:
                msg = str(e)
                if "400 retryable" in msg and attempt < 4:
                    continue                      # param stripped, try again
                if attempt <= args.retries and not msg.startswith("HTTP 4"):
                    time.sleep(min(8.0, 0.8 * 2 ** (attempt - 1)))
                    continue
                errors.append(msg)
                print("  %-12s FAILED: %s" % (label, msg[:200]))
                m = None
                break

        if m is None:
            continue
        if warm:
            print("  %-12s ttft %6.0fms  total %6.0fms  (discarded)" % (label, m["ttft_ms"], m["total_ms"]))
        else:
            rows.append(m)
            extra = "  [estimated tokens]" if m["estimated_usage"] else ""
            print("  %-12s ttft %6.0fms  answer %6.0fms  total %6.0fms  %5.1f tok/s  in %5d  out %5d%s"
                  % (label, m["ttft_ms"], m["first_answer_ms"], m["total_ms"], m["tps"],
                     m["input_tokens"], m["output_tokens"], extra))
        if args.interval and i < total_runs - 1:
            time.sleep(args.interval)
    return rows, errors


def summarize(target, rows, errors, prices, tier):
    print("\n== %s  (%s) ==" % (target["name"], target["model"]))
    print("  runs ok/failed : %d/%d" % (len(rows), len(errors)))
    if target["_notes"]:
        for n in target["_notes"]:
            print("  note: %s" % n)
    if not rows:
        print("  no successful runs -- see errors above")
        return {}

    ttft = [r["ttft_ms"] for r in rows]
    fa = [r["first_answer_ms"] for r in rows]
    tot = [r["total_ms"] for r in rows]
    tps = [r["tps"] for r in rows if r["tps"] > 0]

    print(stat_line("ttft", ttft, "ms"))
    if any(abs(a - b) > 1 for a, b in zip(fa, ttft)):
        print(stat_line("first answer", fa, "ms"))
    print(stat_line("total", tot, "ms"))
    if tps:
        print(stat_line("decode speed", tps, " tok/s"))

    in_tok = statistics.mean(r["input_tokens"] for r in rows)
    hit = statistics.mean(r["cache_hit_tokens"] for r in rows)
    out_tok = statistics.mean(r["output_tokens"] for r in rows)
    rsn = statistics.mean(r["reasoning_tokens"] for r in rows)
    cost = sum(r["cost_usd"] for r in rows)
    print("  tokens/run     : in %.0f (cache hit %.0f) / out %.0f (reasoning %.0f)" % (in_tok, hit, out_tok, rsn))
    print("  cost, %d runs  : $%.5f  (CNY %.4f)   tier=%s" % (len(rows), cost, cost * prices["usd_cny"], tier))

    summary = {
        "target": target["name"], "model": target["model"],
        "runs_ok": len(rows), "runs_failed": len(errors),
        "ttft_ms_mean": statistics.mean(ttft),
        "ttft_ms_p95": pct(ttft, 0.95),
        "total_ms_mean": statistics.mean(tot),
        "tps_mean": statistics.mean(tps) if tps else 0.0,
        "input_tokens": in_tok, "cache_hit_tokens": hit,
        "output_tokens": out_tok, "reasoning_tokens": rsn,
        "cost_usd": cost, "cost_cny": cost * prices["usd_cny"],
        "tier": tier, "notes": target["_notes"], "errors": errors[:5],
    }
    return summary


def main():
    ap = argparse.ArgumentParser(description="Benchmark any OpenAI-compatible chat endpoint.")
    ap.add_argument("--config", help="JSON with targets[] and optional prices{}")
    ap.add_argument("--base-url", help="e.g. https://api.deepseek.com or https://relay/v1")
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--key", help="API key (else BENCH_API_KEY / DEEPSEEK_API_KEY)")
    ap.add_argument("--name", help="label for this target")
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--warmup", type=int, default=2, help="discarded runs (cache + tcp warmup)")
    ap.add_argument("--interval", type=float, default=0.0, help="seconds between runs")
    ap.add_argument("--max-tokens", type=int, default=512)
    ap.add_argument("--temperature", type=float, default=None)
    ap.add_argument("--thinking", choices=["default", "enabled", "disabled"], default="default")
    ap.add_argument("--effort", choices=["none", "low", "high", "max"], default=None)
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--prompt-file")
    ap.add_argument("--system", default=DEFAULT_SYSTEM)
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--tier", choices=["auto", "off-peak", "peak"], default="auto",
                    help="cost tier; 'auto' reads the clock (DeepSeek windows)")
    ap.add_argument("--insecure", action="store_true", help="skip TLS verification (sketchy relays)")
    ap.add_argument("--csv")
    ap.add_argument("--json")
    args = ap.parse_args()

    targets, prices = load_targets(args)
    tier = current_tier() if args.tier == "auto" else args.tier

    print("prompt: %d chars | max_tokens %d | thinking %s | runs %d (+%d warmup) | cost tier %s"
          % (len(args.prompt if not args.prompt_file else open(args.prompt_file, encoding="utf-8").read()),
             args.max_tokens, args.thinking, args.runs, args.warmup, tier))

    summaries, all_rows = [], []
    for t in targets:
        print("\n-> %s  %s  model=%s" % (t["name"], t["base_url"], t["model"]))
        rows, errors = bench_target(t, args, prices, tier)
        for r in rows:
            r["_target"] = t["name"]
            all_rows.append(r)
        s = summarize(t, rows, errors, prices, tier)
        if s:
            summaries.append(s)

    if not summaries:
        sys.exit("\nall targets failed")

    if len(summaries) > 1:
        print("\n== comparison ==")
        base = summaries[0]
        print("  %-18s %10s %10s %10s %10s %10s" % ("target", "ttft ms", "total ms", "tok/s", "cost/run$", "vs first"))
        for s in summaries:
            ratio = (base["ttft_ms_mean"] / s["ttft_ms_mean"]) if s["ttft_ms_mean"] else 0
            print("  %-18s %10.0f %10.0f %10.1f %10.6f %9.2fx"
                  % (s["target"], s["ttft_ms_mean"], s["total_ms_mean"], s["tps_mean"],
                     s["cost_usd"] / max(1, s["runs_ok"]), ratio))
        print("  'vs first' > 1 means faster than the first target; < 1 means slower.")

    if args.csv and all_rows:
        keys = ["_target", "ttft_ms", "first_answer_ms", "total_ms", "tps", "input_tokens",
                "cache_hit_tokens", "output_tokens", "reasoning_tokens", "cost_usd", "estimated_usage"]
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            for r in all_rows:
                w.writerow(r)
        print("\nwrote %s (%d rows)" % (args.csv, len(all_rows)))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"tier": tier, "prices": prices, "prompt": args.prompt,
                       "runs": args.runs, "thinking": args.thinking,
                       "summaries": summaries, "rows": all_rows}, f, ensure_ascii=False, indent=2)
        print("wrote %s" % args.json)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted")
        sys.exit(130)
