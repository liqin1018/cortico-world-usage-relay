#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
relayhub/audit.py -- 账单体检：核对中转站的收费有没有猫腻

输入三份数据做交叉验证：
    官网账单（bill）  —— 平台自己记的 token 和扣费
    本地实测（bench） —— 我们自己发请求、模型返回的 usage
    标价（target）    —— 站点模型卡上写的单价

输出体检项 + 评分。每项都能追溯到具体数字，不做玄学判断。

判定原则：数据不足一律 skip，宁可不说，也不编。
"""

import billing


def _chk(key, title, level, detail, hint=""):
    return {"key": key, "title": title, "level": level, "detail": detail, "hint": hint}


def _skip(key, title, why):
    return _chk(key, title, "skip", why)


def _fmt_money(v):
    if v is None:
        return "—"
    if abs(v) < 0.01:
        return "¥%.5f" % v
    if abs(v) < 1:
        return "¥%.4f" % v
    return "¥%.2f" % v


def _tok(v):
    v = float(v or 0)
    if v >= 1e8:
        return "%.2f亿" % (v / 1e8)
    if v >= 1e4:
        return "%.1f万" % (v / 1e4)
    return "%d" % v


def _price_table(target, bill):
    """按账单的 token 结构，分别算「标价应扣」和「官方应扣」。"""
    t = bill["totals"]
    tin, tout = t.get("in", 0), t.get("out", 0)
    tcache = min(t.get("cache", 0), tin) if tin else 0
    miss = max(0, tin - tcache)
    expect = (miss * target["price_in"] + tcache * target["price_cache"]
              + tout * target["price_out"]) / 1e6
    official = (miss * target["ref_in"] + tcache * target["ref_cache"]
                + tout * target["ref_out"]) / 1e6
    return {"miss": miss, "hit": tcache, "out": tout,
            "expect": expect, "official": official, "actual": t.get("cost", 0)}


# ------------------------------------------------------------------ 各项检查

def chk_consistency(target, bill):
    t = bill["totals"]
    tin, tout, tcache = t.get("in", 0), t.get("out", 0), t.get("cache", 0)
    if not (tin or tout):
        return _skip("consistency", "账单自洽", "账单里没有 token 明细")
    if not tcache:
        return _skip("consistency", "账单自洽",
                     "账单没有区分缓存命中，无法验证「总量 = 输入 + 输出」")
    total = t.get("total") or 0
    calc = tin + tout
    if not total or abs(total - calc) / max(calc, 1) <= 0.02:
        return _chk("consistency", "账单自洽", "pass",
                    "输入 %s + 输出 %s = %s，与站点显示的总量一致"
                    % (_tok(tin), _tok(tout), _tok(total or calc)))
    return _chk("consistency", "账单自洽", "warn",
                "站点显示总量 %s，但输入+输出只有 %s，差了 %s"
                % (_tok(total), _tok(calc), _tok(abs(total - calc))),
                "多出来的部分通常是被拆出去的缓存 token。确认它的统计口径，"
                "别让人用「总量」这个大字掩盖实际计费量。")


def chk_unit_price(target, bill):
    """核心：实际扣费 ÷ 按标价应扣。差得多就是猫腻。"""
    if (bill["totals"] or {}).get("partial"):
        return _skip("unit_price", "实扣 vs 标价",
                     "账单只给了总 token，没有输入/输出拆分（两者单价差 4 倍），"
                     "硬算会得出错误结论。补上拆分数再核。")
    p = _price_table(target, bill)
    if p["expect"] <= 0 or p["actual"] <= 0:
        return _skip("unit_price", "实扣 vs 标价", "缺金额或 token 数据")

    ratio = p["actual"] / p["expect"]
    zhe = p["actual"] / p["official"] if p["official"] > 0 else 0
    detail = ("按标价应扣 %s，实扣 %s → 实际是标价的 %.0f%%，"
              "相当于官方价 %.2f 折"
              % (_fmt_money(p["expect"]), _fmt_money(p["actual"]), ratio * 100, zhe * 10))

    if ratio > 1.25:
        return _chk("unit_price", "实扣 vs 标价", "fail", detail,
                    "实扣比标价贵 %.0f%%。要么标价是引流价、实际按更高倍率结算，"
                    "要么有隐藏的按次/按请求收费。" % ((ratio - 1) * 100))
    if ratio > 1.08:
        return _chk("unit_price", "实扣 vs 标价", "warn", detail,
                    "略高于标价，可能是四舍五入或分组倍率。量大了会明显。")
    if ratio < 0.85:
        return _chk("unit_price", "实扣 vs 标价", "pass",
                    detail + "，比标价还便宜（可能有充值折扣）")
    return _chk("unit_price", "实扣 vs 标价", "pass", detail)


def chk_floor(target, bill):
    """按次兜底会把「几折」变成不可比：短请求的实际单价远高于标价。"""
    ep = billing.effective_prices(target, bill)
    if not ep.get("ok"):
        return _skip("floor", "按次最低消费", ep.get("why") or "数据不足")
    f = ep.get("floor") or 0
    spread = ep.get("spread")
    if not f:
        if spread and spread > 6:
            return _chk("floor", "按次最低消费", "warn",
                        "同样大小的请求，单价最高是最低的 %.0f 倍" % spread,
                        "它按渠道或倍率分流，平均值不可复现，别拿这个均值做预算。")
        return _chk("floor", "按次最低消费", "pass",
                    "没观测到按次兜底，最小的一笔扣费和它的 token 量对得上")
    pin = target["price_in"] or 0
    threshold = (f / (pin / 1e6)) if pin else 0
    detail = ("最小单次扣费 %s，出现 %d 次——比这更小的请求都会被兜底到这一价。"
              "按标价 ¥%s/M 折算，输入少于约 %s token 的调用，实际是在按次付费。"
              % (_fmt_money(f), ep.get("floor_n") or 0, pin, _tok(threshold)))
    hint = ("短请求多的话，真实成本会比「几折」看起来高很多。"
            "要么把上下文攒长一点再发，要么换一个不按次兜底的站。")
    level = "warn" if threshold > 500 else "pass"
    if spread and spread > 6:
        hint += "　另外，同尺寸请求的单价最高差 %.0f 倍，均值不可复现。" % spread
    return _chk("floor", "按次最低消费", level, detail, hint)


def chk_fit_price(target, bill):
    """用日志回归反推真实单价——比总额对比更硬。"""
    k = (bill.get("account") or {}).get("cny_per_quota", 1.0)
    fit = billing.fit_unit_prices(bill.get("logs"), k)
    if not fit.get("ok"):
        return _skip("fit_price", "反推真实单价", fit.get("why") or "样本不足")

    fin, fout = fit["in"], fit["out"]
    pin, pout = target["price_in"], target["price_out"]

    def dev(actual, quoted):
        if quoted <= 0:
            return 0.0
        return (actual - quoted) / quoted

    din, dout = dev(fin, pin), dev(fout, pout)
    worst = max(din, dout)
    detail = ("从 %d 条消费记录回归：输入 ¥%.3f/M、输出 ¥%.3f/M；"
              "标价是 ¥%.3f/¥%.3f"
              % (fit["n"], fin, fout, pin, pout))

    if worst > 0.6:
        return _chk("fit_price", "反推真实单价", "fail",
                    detail + "（输入 %+.0f%%、输出 %+.0f%%）" % (din * 100, dout * 100),
                    "回归出来的单价比标价高一大截，这是账单层面的硬证据——"
                    "标价只是门面，实际按另一套价目在扣。")
    if worst > 0.2:
        return _chk("fit_price", "反推真实单价", "warn",
                    detail + "（输入 %+.0f%%、输出 %+.0f%%）" % (din * 100, dout * 100),
                    "比标价高两成上下，可能是分组倍率没在标价里体现。")
    if worst > -0.15:
        return _chk("fit_price", "反推真实单价", "pass", detail, "和标价基本对得上。")
    return _chk("fit_price", "反推真实单价", "pass",
                detail, "实际单价比标价低，说明有折扣在生效。")


def chk_cache_pricing(target, bill):
    """有缓存命中，但钱没少——说明缓存按原价计费。"""
    t = bill["totals"]
    tin, tcache = t.get("in", 0), t.get("cache", 0)
    if not tin or tcache <= 0:
        return _skip("cache_pricing", "缓存计价",
                     "账单里没有缓存命中记录（要么站点不支持，要么没统计）")
    rate = tcache / float(tin)
    if rate < 0.15:
        return _skip("cache_pricing", "缓存计价",
                     "缓存命中只占输入的 %.0f%%，样本太少看不出来" % (rate * 100))

    p = _price_table(target, bill)
    # 如果全部按未命中价算，会是多少
    all_miss = (tin * target["price_in"] + p["out"] * target["price_out"]) / 1e6
    if p["actual"] <= 0 or all_miss <= 0:
        return _skip("cache_pricing", "缓存计价", "缺金额")

    vs_miss = p["actual"] / all_miss
    saved = 1 - vs_miss
    detail = ("缓存命中 %s / 输入 %s（%.0f%%）；实际扣费是「全按未命中价」的 %.0f%%"
              % (_tok(tcache), _tok(tin), rate * 100, vs_miss * 100))

    if vs_miss > 0.95:
        return _chk("cache_pricing", "缓存计价", "fail", detail,
                    "命中了这么多缓存却没省钱，说明命中部分仍按未命中价计费。"
                    "缓存如果按 $0.02/M 而不是 $0.15/M，这里应该便宜三到五成。")
    if vs_miss > 0.85:
        return _chk("cache_pricing", "缓存计价", "warn", detail,
                    "省了一点，但折扣幅度不到标称的一半。核对下缓存价是不是真的生效了。")
    return _chk("cache_pricing", "缓存计价", "pass",
                detail + "，缓存确实在省钱（省了 %.0f%%）" % (saved * 100))


def chk_cache_rate(target, bill, bench):
    """账单的缓存命中率 vs 我们实测的命中率。"""
    t = bill["totals"]
    tin, tcache = t.get("in", 0), t.get("cache", 0)
    if not bench or not bench.get("runs"):
        return _skip("cache_rate", "缓存命中率", "还没有本地实测数据做对照")
    if not tin or tcache <= 0:
        return _skip("cache_rate", "缓存命中率",
                     "账单没有缓存命中字段，无法和实测的 %.0f%% 对比"
                     % (100 * (bench.get("cache_hit") or 0) / max(bench.get("input_tokens") or 1, 1)))

    bill_rate = tcache / float(tin)
    bench_rate = (bench.get("cache_hit") or 0) / max(bench.get("input_tokens") or 1, 1)
    gap = bill_rate - bench_rate
    detail = ("账单命中率 %.0f%%，我们实测 %.0f%%，差 %+.0f 个百分点"
              % (bill_rate * 100, bench_rate * 100, gap * 100))

    if abs(gap) <= 0.12:
        return _chk("cache_rate", "缓存命中率", "pass", detail, "两边对得上。")
    if gap > 0:
        return _chk("cache_rate", "缓存命中率", "warn", detail,
                    "账单的命中率明显更高。可能它把「重复请求」也算成命中，"
                    "用来撑一个好看的折扣数字。")
    return _chk("cache_rate", "缓存命中率", "warn", detail,
                "实测命中率高于账单。反过来说，账单少记了缓存，等于多收了钱。")


def chk_model_split(target, bill):
    """账单里跑的是不是你指定的那个模型。"""
    models = bill.get("models") or []
    if not models:
        return _skip("model_split", "模型分流", "账单没有模型分布")
    want = (target.get("model") or "").strip()
    total_calls = sum(m["calls"] for m in models) or 1
    mine = [m for m in models if m["model"] == want]
    mine_calls = sum(m["calls"] for m in mine)
    others = [m for m in models if m["model"] != want]
    if not want:
        return _skip("model_split", "模型分流", "目标没设模型名")

    if not others:
        return _chk("model_split", "模型分流", "pass",
                    "%d 次调用全部走 %s，没有夹带别的模型" % (total_calls, want))

    other_calls = total_calls - mine_calls
    ratio = other_calls / float(total_calls)
    names = "、".join("%s(%d 次)" % (m["model"], m["calls"]) for m in others[:4])
    detail = "你指定的是 %s，但账单里还有：%s，占 %.0f%%" % (want, names, ratio * 100)

    if ratio > 0.3:
        return _chk("model_split", "模型分流", "fail", detail,
                    "三分之一以上的请求没走你指定的模型。"
                    "这种分流通常是把你的请求降级到更便宜的快照，"
                    "你按原价付钱、拿到降级的结果。")
    if ratio > 0.05:
        return _chk("model_split", "模型分流", "warn", detail,
                    "有少量请求被分到别的模型。可能是同名模型的快照轮转，"
                    "也可能是高峰期自动降级——延迟会突然变差。")
    return _chk("model_split", "模型分流", "pass", detail, "占比很小，可忽略。")


def chk_inflation(target, bill, bench):
    """账单记录的单次 token 量 vs 实测 usage。"""
    t = bill["totals"]
    reqs = t.get("requests") or 0
    if not reqs or not bench or not bench.get("runs"):
        return _skip("inflation", "计量膨胀", "缺少账单次数或实测数据")

    bill_in = (t.get("in") or 0) / float(reqs)
    bill_out = (t.get("out") or 0) / float(reqs)
    bench_in = bench.get("input_tokens") or 0
    bench_out = bench.get("output_tokens") or 0
    if bench_in <= 0 or bench_out <= 0:
        return _skip("inflation", "计量膨胀", "实测 token 数据不完整")

    # 样本可比性：只在我的测试占账单一定比例时才判断
    share = min(1.0, bench.get("runs", 0) / float(reqs))
    if share < 0.15:
        return _skip("inflation", "计量膨胀",
                     "你的实测只占账单 %d 次里的 %d 次（%.0f%%），"
                     "两组请求长度不一样，比了也不准。"
                     "想验这项，先跑一轮和日常用量接近的测试。"
                     % (reqs, bench.get("runs", 0), share * 100))

    din = bill_in / bench_in - 1
    dout = bill_out / bench_out - 1
    detail = ("账单平均每次输入 %s / 输出 %s；我们实测 %s / %s（输入 %+.0f%%，输出 %+.0f%%）"
              % (_tok(bill_in), _tok(bill_out), _tok(bench_in), _tok(bench_out),
                 din * 100, dout * 100))

    if max(din, dout) > 0.25:
        return _chk("inflation", "计量膨胀", "fail", detail,
                    "同样的请求，账单记的 token 比模型返回的 usage 多出一截。"
                    "这是最隐蔽的一种加价——单价没变，但你被多算了几十万 token。")
    if max(din, dout) > 0.1:
        return _chk("inflation", "计量膨胀", "warn", detail,
                    "账单比 usage 多记了一点。可能是系统提示词/模板的额外开销，"
                    "也可能是统计口径差异。")
    return _chk("inflation", "计量膨胀", "pass", detail, "两边口径一致。")


def chk_drift(target, bill, history):
    """多份快照的有效单价有没有悄悄变。只比同一个模型，避免拿苹果比橘子。"""
    if not history or len(history) < 2:
        return _skip("drift", "价格漂移", "至少同步两次才能看出趋势")

    pts = []
    for h in history[-10:]:
        models = h.get("models") or []
        if models:
            mm = max(models, key=lambda m: m.get("tokens") or 0)
            tk, cst = mm.get("tokens") or 0, mm.get("cost") or 0
            if tk and cst:
                pts.append((mm.get("model") or "?", cst / tk * 1e6))
                continue
        tt = h.get("totals") or {}
        tot = (tt.get("in") or 0) + (tt.get("out") or 0)
        cst = tt.get("cost") or 0
        if tot > 0 and cst > 0:
            pts.append((target.get("model") or "?", cst / tot * 1e6))

    if len(pts) < 2:
        return _skip("drift", "价格漂移", "历史快照里没有可比的有效单价")
    if len({p[0] for p in pts}) > 1:
        return _skip("drift", "价格漂移",
                     "这段时间里的主力模型换过（%s），单价不可比"
                     % "、".join(sorted({p[0] for p in pts}))[:60])

    vals = [p[1] for p in pts]
    lo, hi = min(vals), max(vals)
    if lo <= 0:
        return _skip("drift", "价格漂移", "有效单价为 0，数据异常")
    spread = (hi - lo) / lo
    detail = ("%s 的综合单价在最近 %d 次同步里落在 ¥%.3f ~ ¥%.3f/M（波动 %.0f%%）"
              % (pts[-1][0], len(pts), lo, hi, spread * 100))
    if spread > 0.35:
        return _chk("drift", "价格漂移", "warn", detail,
                    "单价波动很大。可能是按时间段调倍率（高峰期偷偷加价），"
                    "也可能是不同长度的请求混在一起。")
    return _chk("drift", "价格漂移", "pass", detail, "价格稳定。")


def chk_output_share(target, bill):
    """输出 token 占比——输出是最贵的，比例异常高就是钱在漏。"""
    t = bill["totals"]
    if t.get("partial"):
        return _skip("output_share", "输出占比", "账单没有输入/输出拆分")
    tin, tout = t.get("in", 0), t.get("out", 0)
    if not (tin and tout):
        return _skip("output_share", "输出占比", "缺 token 明细")
    share = tout / float(tin + tout)
    cost_share = 0.0
    p = _price_table(target, bill)
    if p["actual"] > 0:
        cost_share = (p["out"] * target["price_out"] / 1e6) / p["actual"]
    detail = ("输出占 token 总量的 %.0f%%，却贡献了 %.0f%% 的费用"
              % (share * 100, cost_share * 100))
    if cost_share > 0.85:
        return _chk("output_share", "输出占比", "warn", detail,
                    "费用几乎全来自输出。输出单价通常是输入的 4 倍，"
                    "如果你的场景不产出这么多字，检查下是不是思考过程被算进了输出。")
    return _chk("output_share", "输出占比", "pass", detail)


# ------------------------------------------------------------------ 汇总

def run(target, bill, bench=None, history=None):
    """
    target: 含 price_in/out/cache、ref_in/out/cache、model
    bill:   billing 产出的 BillData
    bench:  最近一次实测 summary
    history: 历史 BillData 列表（旧的在前）
    """
    if not bill or not (bill.get("totals") or {}).get("requests"):
        return {"score": None, "level": "none", "checks": [],
                "headline": "还没有账单数据",
                "sub": "先同步一次站点账单，才能核对它有没有多收钱。"}

    checks = [
        chk_unit_price(target, bill),
        chk_floor(target, bill),
        chk_fit_price(target, bill),
        chk_cache_pricing(target, bill),
        chk_cache_rate(target, bill, bench),
        chk_model_split(target, bill),
        chk_inflation(target, bill, bench),
        chk_consistency(target, bill),
        chk_drift(target, bill, history),
        chk_output_share(target, bill),
    ]

    weight = {"fail": 26, "warn": 9, "pass": 0, "skip": 0}
    score = 100
    for c in checks:
        score -= weight.get(c["level"], 0)
    score = max(0, min(100, score))

    ran = [c for c in checks if c["level"] != "skip"]
    coverage = int(round(100.0 * len(ran) / len(checks)))
    fails = [c for c in checks if c["level"] == "fail"]
    warns = [c for c in checks if c["level"] == "warn"]
    cost = _price_table(target, bill)
    if fails:
        level = "bad"
        headline = "发现 %d 个明显问题" % len(fails)
        sub = fails[0]["detail"]
        if cost["official"] > 0 and cost["actual"] > 0:
            zhe = cost["actual"] / cost["official"]
            if zhe < 0.9:
                sub += ("　注意，「便宜」和「诚实」是两件事：它确实比官方直连省 %.0f%%"
                        "（约 %.2f 折），但远没有它标价说的那么多。"
                        % ((1 - zhe) * 100, zhe * 10))
    elif warns:
        level = "warn"
        headline = "有 %d 处对不上" % len(warns)
        sub = warns[0]["detail"]
    elif coverage < 50:
        level = "thin"
        headline = "数据太少，只能粗看"
        sub = "9 项检查里只跑通了 %d 项。补上明细账单或先跑一轮实测，结论会更硬。" % len(ran)
    else:
        level = "good"
        headline = "账单看着干净"
        sub = "价格、缓存、模型都和你看到的一致。"

    return {"score": score, "level": level, "headline": headline,
            "sub": sub, "checks": checks, "coverage": coverage,
            "ran": len(ran), "total_checks": len(checks),
            "cost": cost}
