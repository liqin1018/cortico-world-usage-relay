# -*- coding: utf-8 -*-
"""
relayhub/models.py -- 模型品牌 / 主流模型 / 官方参考价

每条 (模型名, 参考输入价, 参考输出价, 参考缓存价, 备注)，价格单位：人民币 / 百万 token。

注意：DeepSeek 是实测确认过的谷时官方价；其它品牌是按公开美元报价 × 7.1 折算的
参考值（标 est=True），会随官方调价失效。跑之前建议对着官方价目页核对一遍，
界面上这些价格都是可改的。
"""

import re

VENDORS = [
    {
        "key": "deepseek", "name": "DeepSeek", "est": False,
        "note": "谷时官方价，峰时翻倍",
        "models": [
            ("deepseek-v4.1-flash", 1.0, 4.0, 0.02, "主力，1M 上下文"),
            ("deepseek-v4.1-pro", 2.0, 8.0, 0.04, "正有序下线"),
            ("deepseek-chat", 1.0, 4.0, 0.02, ""),
            ("deepseek-reasoner", 2.0, 8.0, 0.04, ""),
        ],
    },
    {
        "key": "openai", "name": "ChatGPT", "est": True,
        "note": "按 $1.25/$10 折算",
        "models": [
            ("gpt-5.1", 8.9, 71.0, 0.89, "$1.25 / $10"),
            ("gpt-5.1-mini", 1.8, 14.2, 0.18, "$0.25 / $2"),
            ("gpt-5.1-codex", 8.9, 71.0, 0.89, "代码向"),
        ],
    },
    {
        "key": "claude", "name": "Claude", "est": True,
        "note": "按 Anthropic 公开价折算",
        "models": [
            ("claude-sonnet-4-5", 21.3, 106.5, 2.13, "$3 / $15"),
            ("claude-opus-4-5", 35.5, 177.5, 3.55, "$5 / $25"),
            ("claude-haiku-4-5", 7.1, 35.5, 0.71, "$1 / $5"),
        ],
    },
    {
        "key": "gemini", "name": "Gemini", "est": True,
        "note": "按 Google 公开价折算",
        "models": [
            ("gemini-3-pro", 14.2, 85.2, 1.42, "$2 / $12"),
            ("gemini-3-flash", 3.55, 21.3, 0.36, "$0.5 / $3"),
        ],
    },
    {
        "key": "qwen", "name": "通义千问", "est": True,
        "note": "阿里云百炼价",
        "models": [
            ("qwen3-max", 6.0, 24.0, 0.6, ""),
            ("qwen3-coder-plus", 4.0, 16.0, 0.4, "代码向"),
            ("qwen3-235b-a22b", 2.0, 8.0, 0.2, "开源版"),
        ],
    },
    {
        "key": "doubao", "name": "豆包", "est": True,
        "note": "火山引擎价",
        "models": [
            ("doubao-seed-1.6", 0.8, 8.0, 0.16, ""),
            ("doubao-1.5-pro-32k", 0.8, 2.0, 0.16, "长文场景"),
        ],
    },
    {
        "key": "hunyuan", "name": "腾讯混元", "est": True,
        "note": "腾讯云价",
        "models": [
            ("hunyuan-t1", 1.0, 4.0, 0.1, ""),
            ("hunyuan-turbos", 0.8, 2.0, 0.08, "轻量"),
        ],
    },
    {
        "key": "glm", "name": "智谱 GLM", "est": True,
        "note": "智谱开放平台价",
        "models": [
            ("glm-4.6", 4.0, 16.0, 0.8, ""),
            ("glm-4.5-air", 0.8, 2.0, 0.16, "轻量"),
        ],
    },
    {
        "key": "kimi", "name": "Kimi", "est": True,
        "note": "月之暗面价",
        "models": [
            ("kimi-k2", 4.0, 16.0, 0.8, ""),
            ("kimi-k2-turbo", 8.0, 32.0, 1.6, "高速版"),
        ],
    },
    {
        "key": "stepfun", "name": "阶跃星辰", "est": True,
        "note": "阶跃开放平台价",
        "models": [
            ("step-3", 5.0, 20.0, 0.5, ""),
            ("step-2-mini", 1.0, 4.0, 0.1, "轻量"),
        ],
    },
    {
        "key": "minimax", "name": "MiniMax", "est": True,
        "note": "MiniMax 开放平台价",
        "models": [
            ("minimax-m2", 2.1, 8.4, 0.21, ""),
            ("minimax-text-01", 1.0, 8.0, 0.1, ""),
        ],
    },
    {
        "key": "grok", "name": "Grok", "est": True,
        "note": "按 xAI 公开价折算",
        "models": [
            ("grok-5", 21.3, 106.5, 2.13, "$3 / $15"),
            ("grok-5-mini", 2.1, 10.7, 0.21, "轻量"),
        ],
    },
    {
        "key": "mimo", "name": "小米 MiMo", "est": True,
        "note": "价格按公开资料估，请核对",
        "models": [
            ("mimo-vl", 3.0, 9.0, 0.3, "多模态"),
        ],
    },
    {
        "key": "ernie", "name": "文心 ERNIE", "est": True,
        "note": "百度智能云价",
        "models": [
            ("ernie-5.0", 4.0, 16.0, 0.4, ""),
        ],
    },
    {
        "key": "baichuan", "name": "百川智能", "est": True,
        "note": "价格按公开资料估，请核对",
        "models": [
            ("baichuan4", 5.0, 20.0, 0.5, ""),
        ],
    },
    {
        "key": "360", "name": "360 智脑", "est": True,
        "note": "价格按公开资料估，请核对",
        "models": [
            ("360gpt2-pro", 2.0, 8.0, 0.2, ""),
        ],
    },
    {
        "key": "other", "name": "其他 / 自定义", "est": True,
        "note": "模型名手填，参考价手填",
        "models": [],
    },
]

VENDOR_MAP = {v["key"]: v for v in VENDORS}


def vendor_name(key):
    v = VENDOR_MAP.get(key)
    return v["name"] if v else (key or "其他")


def lookup_ref(vendor, model):
    """按品牌+模型名找官方参考价，找不到返回 None。"""
    v = VENDOR_MAP.get(vendor)
    if not v:
        return None
    for m in v["models"]:
        if m[0] == model:
            return {"in": m[1], "out": m[2], "cache": m[3]}
    return None


def first_model(vendor):
    v = VENDOR_MAP.get(vendor)
    if v and v["models"]:
        return v["models"][0][0]
    return ""


# ---------------------------------------------------------------- 认名

def _norm(s):
    """把模型名压成只含小写字母数字：DeepSeek-V4.1_Flash => deepseekv41flash"""
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def guess(model_id):
    """
    中转站的模型名千奇百怪（DeepSeek-V4.1-Flash-1017、deepseek/deepseek-chat、GLM-5.3(1)…），
    这里尽量认回价目表里的标准名，用来自动填官方参考价。认不出返回 None，不硬猜。

    优先级：整串相等 > 去掉 vendor/ 前缀后相等 > 目录名被包在站名里（取最长匹配）
    """
    raw = str(model_id or "").strip()
    nid = _norm(raw)
    if len(nid) < 3:
        return None
    tail = _norm(raw.split("/")[-1])
    best = None
    for v in VENDORS:
        for m in v["models"]:
            nm = _norm(m[0])
            if not nm:
                continue
            if nid == nm or tail == nm:
                score = 1000 + len(nm)
            elif nm in nid:
                score = 500 + len(nm)
            else:
                continue
            if not best or score > best[0]:
                best = (score, {"vendor": v["key"], "model": m[0],
                                "ref": {"in": m[1], "out": m[2], "cache": m[3]}})
    return best[1] if best else None
