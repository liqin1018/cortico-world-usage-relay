#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
relayhub/billing.py -- 中转站账单取数 / 解析 / 真实单价反推

三种取数方式，输出统一 BillData（dict）：

    {
      "source": "oneapi" | "paste" | "manual",
      "taken_at": "2026-11-01 14:20:00",
      "root": "https://xxx.com",
      "window_days": 7,
      "totals": {"requests": 360, "cost": 0.33721, "currency": "CNY",
                 "in": 3800000, "out": 500000, "cache": 3000000, "total": 4300000},
      "models": [{"model": "...", "calls": 120, "tokens": 2100000, "cost": 0.16}],
      "days":   [{"day": "2026-11-01", "calls": 29, "in": 0, "out": 0, "cache": 0, "cost": 0}],
      "logs":   [{"ts":..., "model":..., "in":..., "out":..., "cache":..., "cost":..., "quota":...}],
      "account": {"balance": 0.0, "used": 0.0, "quota_per_unit": 500000},
      "notes":  ["..."]
    }

金额一律换算成人民币，换算率可配置（站点可能自定义 quota 单位）。
"""

import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

DEFAULT_QUOTA_PER_UNIT = 500000.0   # one-api / new-api 默认 500000 quota = $1
DEFAULT_USD_CNY = 7.1
# 中转站的「$」多半只是个符号：充 1 元 = $1 额度，所以 quota 折人民币默认 1:1。
# 真按美元收费的站（官方 OpenAI 转售那类）才需要乘汇率。
SITE_RATE_ONE = 1.0

_CTX = ssl.create_default_context()
_CTX_NOCHECK = ssl._create_unverified_context()

# 采集脚本会把控制台能看到的接口全捞回来，里面混着令牌列表、账户信息、站点配置、
# 价目表这些「有数组、有数字、但不是账单」的响应。靠 URL 语义先给它们定性。
_NOT_BILL_URL = re.compile(
    r"/(user|self|profile|tokens?|keys?|api[_-]?keys?|credentials?|secret|"
    r"notice|announce|messages?|config|status|pricing|models?|dashboard|"
    r"points|balance|checkin|aff|invite|redeem|topup|charge|subscribe)\b", re.I)
_BILL_URL = re.compile(r"(log|usage|bill|record|consume|history|detail|stat|spend)",
                       re.I)


# ------------------------------------------------------------------ 基础工具

def root_of(base_url):
    """从 API 地址剥出站点根：https://x.com/v1 -> https://x.com"""
    u = (base_url or "").strip().rstrip("/")
    for suf in ("/v1/chat/completions", "/chat/completions", "/v1/responses",
                "/v1/messages", "/v1", "/api"):
        if u.endswith(suf):
            return u[: -len(suf)].rstrip("/")
    return u


def _get(url, headers=None, timeout=20, insecure=False, _retried=False):
    """发一个 GET，返回 (status, raw)。status=0 表示没拿到 HTTP 响应。

    证书链验证失败时重建一次 SSL context 再试。原因：长驻进程的 trust store 是
    进程启动那一刻读进内存的快照，Windows 根证书库后来更新了（自动根证书更新、
    或某个站点把中间证书写进了系统库），老进程就一直报
    "unable to get local issuer certificate"——站点证书本身其实是完整的。
    重建 context 等于重新读一遍系统库，不用重启服务。
    """
    global _CTX
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=_CTX_NOCHECK if insecure else _CTX) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        except Exception:
            return e.code, b""
    except Exception as e:
        msg = str(e)
        if not insecure and not _retried and "CERTIFICATE_VERIFY_FAILED" in msg:
            try:
                _CTX = ssl.create_default_context()
                return _get(url, headers, timeout, insecure, True)
            except Exception:
                pass
        return 0, msg.encode("utf-8", "replace")


def _short_err(raw, limit=110):
    """把 _get 带回来的异常文本压成一行，塞进提示里用。"""
    txt = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    txt = re.sub(r"^<urlopen error ", "", txt.strip())
    txt = re.sub(r"\s+", " ", txt).rstrip(">").strip()
    return txt[:limit]


def _json(raw):
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        try:
            return json.loads(raw.decode("gbk", "replace"))
        except Exception:
            return None


def _num(v, d=0.0):
    try:
        if isinstance(v, bool):
            return d
        return float(v)
    except (TypeError, ValueError):
        return d


def _blank(source, root=""):
    return {
        "source": source,
        "taken_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "root": root,
        "window_days": 0,
        "totals": {"requests": 0, "cost": 0.0, "currency": "CNY",
                   "in": 0, "out": 0, "cache": 0, "total": 0},
        "models": [], "days": [], "logs": [],
        "account": {}, "notes": [],
    }


def _hint(raw):
    s = raw.decode("utf-8", "replace")
    return s[:160].replace("\n", " ")


def rate_for(usd_cny=None, mode="one"):
    """站点的 $ 怎么折成人民币。

    mode="one"（默认）：$ 只是个符号，1 美元额度 = 1 元。中转站几乎都是这个。
    mode="fx"：真美元计价，乘汇率（缺省 7.1，可用站点自报的 usd_exchange_rate）。
    """
    m = (mode or "one").strip().lower()
    if m in ("fx", "usd", "rate", "rate_fx"):
        return _num(usd_cny, 0) or DEFAULT_USD_CNY
    return SITE_RATE_ONE


# ------------------------------------------------------------------ 探测

def probe(base_url, insecure=False):
    """不认证探测站点类型。返回 {ok, kind, root, endpoints, quota_per_unit, ...}"""
    root = root_of(base_url)
    out = {"ok": False, "kind": "unknown", "root": root, "endpoints": [],
           "version": "", "quota_per_unit": None, "usd_cny": None, "notes": []}
    if not root:
        out["notes"].append("地址为空")
        return out

    st, raw = _get(root + "/api/status", timeout=8, insecure=insecure)
    if st == 200:
        obj = _json(raw) or {}
        d = obj.get("data") if isinstance(obj, dict) else None
        if isinstance(d, dict):
            out["ok"] = True
            out["kind"] = "oneapi"
            out["version"] = str(d.get("version") or "")
            out["endpoints"].append("/api/status")
            if d.get("quota_per_unit"):
                out["quota_per_unit"] = _num(d["quota_per_unit"], DEFAULT_QUOTA_PER_UNIT)
            for k in ("usd_exchange_rate", "exchange_rate"):
                if d.get(k):
                    out["usd_cny"] = _num(d[k])
                    break
            out["notes"].append("识别为 one-api / new-api 系站点，可用后台 token 直连")

    if st == 0:
        # 第一个请求就连不上（代理 502 / 超时），第二个也别再等 8 秒
        st2, raw2 = 0, raw
    else:
        st2, raw2 = _get(root + "/api/user/self", timeout=8, insecure=insecure)
    if st2 == 200:
        body = _json(raw2) or {}
        if isinstance(body, dict) and body.get("success") is False:
            out["notes"].append("账户接口需登录：" + str(body.get("message") or "")[:60])
        else:
            out["endpoints"].append("/api/user/self")
            out["notes"].append("账户接口免认证可读（少见，说明站点没做权限）")
    elif st2 in (401, 403):
        if out["kind"] == "oneapi":
            out["notes"].append("账户接口需要登录态（HTTP %s），填后台令牌或 Cookie 即可" % st2)
        else:
            out["notes"].append("账户接口存在但需要登录（HTTP %s），且没有 one-api 的特征接口。"
                                "这类站直连大概率不通，建议用「粘贴导入」或「手填汇总」" % st2)
    elif st2 == 404:
        out["notes"].append("没有 /api/user/self，不是 one-api 系")

    # 自研控制台（OpenSlate 这类）：/api/public/site-config 是公开的，能认出来
    if st == 0 and st2 == 0:
        out["notes"] = ["连不上站点：%s" % _hint(raw),
                        "这个站从本机出口到不了（代理 502、直连超时都会这样），"
                        "不是你填错了。改用在站点控制台跑脚本，让浏览器替你拉账单。"]
        return out
    if out["kind"] != "oneapi":
        st3, raw3 = _get(root + "/api/public/site-config", timeout=10, insecure=insecure)
        if st3 == 200:
            o = _json(raw3) or {}
            d = o.get("data") if isinstance(o, dict) else None
            if isinstance(d, dict) and (d.get("site_name") or d.get("site_logo")):
                out["ok"] = True
                out["kind"] = "openslate"
                out["site_name"] = str(d.get("site_name") or "")
                out["endpoints"].append("/api/public/site-config")
                out["notes"] = [
                    "识别为 %s 自研控制台：有 /api/user/dashboard、/api/usage/my，"
                    "填后台登录令牌即可直连" % (out["site_name"] or "OpenSlate 系")]
    return out


# ------------------------------------------------------------------ one-api 家族

def parse_fetch(text):
    """认 F12 里「以 fetch 格式复制」的那段。"""
    s = (text or "").strip()
    if not re.match(r"(?is)^fetch\s*\(", s):
        return None
    m = re.search(r"['\"](https?://[^'\"]+)['\"]", s)
    if not m:
        return None
    url = m.group(1)
    headers = {}
    hm = re.search(r"headers['\"]?\s*:\s*\{(.*?)\}", s, re.S)
    if hm:
        for k, v in re.findall(r"['\"]([^'\"]+)['\"]\s*:\s*['\"]([^'\"]*)['\"]",
                               hm.group(1)):
            headers[k] = v
    u = urllib.parse.urlsplit(url)
    origin = "%s://%s" % (u.scheme, u.netloc) if u.scheme and u.netloc else ""
    return {"url": url, "root": origin, "headers": headers}


def parse_request_paste(text):
    """令牌/ Cookie 框里可能是 cURL，也可能是 fetch，都认。"""
    return parse_curl(text) or parse_fetch(text)


def _hget(headers, name):
    for k, v in (headers or {}).items():
        if k.lower() == name.lower():
            return v
    return ""


def parse_curl(text):
    """认「Copy as cURL」整段：浏览器里右键复制请求，比在 Application 里翻
    cookie 省事，而且它连 X-Auth-Session 这类怪头一起带过来了。"""
    s = (text or "").strip()
    if not re.match(r"(?is)^\s*curl(\.exe)?\s", s):
        return None
    t = s.replace("\\\r\n", " ").replace("\\\n", " ")      # bash
    t = t.replace("^\r\n", " ").replace("^\n", " ")        # cmd 续行
    t = re.sub(r"[`\r\n]", " ", t)                         # powershell 续行
    t = t.replace('^"', '"')                               # cmd 把引号转义成 ^"
    headers = {}
    for m in re.finditer(r"-H\s+(['\"])(.*?)\1|--header\s+(['\"])(.*?)\3", t, re.S):
        line = m.group(2) if m.group(2) is not None else m.group(4)
        if line and ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().strip('"')] = v.strip().strip('"').rstrip("^")
    # Chrome 的「Copy as cURL」把 cookie 放在 -b/--cookie，不是 -H
    for m in re.finditer(r"(?:^|\s)(?:-b|--cookie)\s+(['\"])(.*?)\1", t, re.S):
        if not _hget(headers, "Cookie"):
            headers["Cookie"] = m.group(2).strip()
    m = (re.search(r"--url\s+(['\"]?)(https?://[^\s'\"]+)\1", t, re.I)
         or re.search(r"curl(?:\.exe)?\s+(['\"]?)(https?://[^\s'\"]+)\1", t, re.I))
    url = m.group(2) if m else ""
    if not url and not headers:
        return None
    origin = ""
    if url:
        u = urllib.parse.urlsplit(url)
        if u.scheme and u.netloc:
            origin = "%s://%s" % (u.scheme, u.netloc)   # 只留站点根，路径全是接口
    return {"url": url, "root": origin, "headers": headers}


def _looks_cookie(v):
    """用户常把 session=xxx 粘进令牌框，这里替他把两种情况分开。"""
    s = (v or "").strip()
    if not s or s.lower().startswith("bearer "):
        return False
    return "session=" in s or (s.count("=") >= 1 and ";" in s)


def _post(url, headers=None, data=b"", timeout=20, insecure=False):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data or b"", headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=_CTX_NOCHECK if insecure else _CTX) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        except Exception:
            return e.code, b""
    except Exception as e:
        return 0, str(e).encode("utf-8", "replace")


_SESSION_NAMES = ("session", "sessionid", "session_id", "_session", "sid",
                  "connect.sid", "auth_session")


def _has_session_cookie(cookie):
    """真会话 cookie 在不在？注意 new_api_has_session=1 只是前端自己写的小旗子。"""
    for part in (cookie or "").split(";"):
        if "=" not in part:
            continue
        name = part.split("=", 1)[0].strip().lower()
        if name in _SESSION_NAMES:
            return True
        # nsr_session / session_id 这类变体也算；但 new_api_has_session 是前端小旗子，不算
        if "session" in name and "has_session" not in name:
            return True
    return False


def _refresh_token(root, cookie, user_id="", insecure=False):
    """改版 new-api（返回 AUTH_UNAUTHORIZED 那类）用 HttpOnly 的 session
    cookie 换一枚短期 access_token。返回 (token, 失败原因)。"""
    h = {"Content-Type": "application/json", "Cookie": (cookie or "").strip()}
    if user_id:
        h["New-Api-User"] = str(user_id).strip()
    st, raw = _post(root + "/api/user/auth/refresh", h, data=b"{}",
                    timeout=20, insecure=insecure)
    if st == 0:
        return "", "连不上"
    if st != 200:
        return "", "HTTP %s" % st
    obj = _json(raw) or {}
    d = obj.get("data") if isinstance(obj, dict) else None
    if isinstance(d, dict):
        for k in ("access_token", "token", "accessToken"):
            v = d.get(k)
            if isinstance(v, str) and v:
                return v, ""
    return "", "站点没返回 access_token"


def _auth_headers(token="", cookie="", user_id="", extra=None):
    h = {}
    for k, v in (extra or {}).items():
        if k.strip() and v:
            h[k.strip()] = v

    def _set(name, val):
        for k in list(h):
            if k.lower() == name.lower():
                h[k] = val
                return
        h[name] = val

    if cookie:
        _set("Cookie", cookie.strip())
    if token:
        t = token.strip()
        if not t.lower().startswith("bearer "):
            t = "Bearer " + t
        _set("Authorization", t)
    if user_id:
        # new-api 用 Cookie 登录态时必须带这个头，只有令牌时也可带（少了某些站会 401）
        _set("New-Api-User", str(user_id).strip())
    return h


def _extract_list(obj):
    """兼容 one-api 的 data:[...] 和 new-api 的 data:{items,total}"""
    if not isinstance(obj, dict):
        return [], None
    d = obj.get("data")
    if isinstance(d, list):
        return d, None
    if isinstance(d, dict):
        for key in ("items", "records", "list", "logs", "data"):
            if isinstance(d.get(key), list):
                return d[key], d.get("total")
    return [], None


def fetch_oneapi(base_url, token="", cookie="", user_id="", days=7,
                 quota_per_unit=None, usd_cny=DEFAULT_USD_CNY,
                 page_size=100, max_pages=20, insecure=False, rate_mode="one"):
    """直连 one-api / new-api 后台，拉最近 N 天消费日志。"""
    root = root_of(base_url)
    if not cookie and _looks_cookie(token):
        cookie, token = token.strip(), ""
    if not (token or cookie):
        raise RuntimeError("需要后台访问令牌或 Cookie（不是 sk- 开头的调用密钥）")

    notes = []
    # 允许把 F12 里「Copy as cURL」的整段粘进令牌/Cookie 框：
    # 里面的 Cookie、Authorization、X-Auth-Session 全都照搬，兼容各种改版。
    extra_h = {}
    curl = parse_request_paste(token) or parse_request_paste(cookie)
    if curl:
        if curl["root"]:
            root = curl["root"]
        extra_h = dict(curl["headers"])
        ck = _hget(extra_h, "Cookie")
        if ck:
            cookie = ck
        if not token:
            au = _hget(extra_h, "Authorization")
            if au:
                token = re.sub(r"(?i)^bearer\s+", "", au).strip()
        for k in ("Accept-Language", "Accept-Encoding", "Content-Length",
                  "Host", "Connection"):
            extra_h.pop(k, None)
        notes.append("已按你粘贴的 cURL 请求头认证")
        if not user_id:
            user_id = _hget(extra_h, "New-Api-User")
    if not (token or cookie):
        raise RuntimeError("这段 cURL 里没有 Cookie 也没有 Authorization，换一条复制")
    qpu = _num(quota_per_unit, 0) or 0.0
    rate = _num(usd_cny, DEFAULT_USD_CNY) or DEFAULT_USD_CNY

    # 站点自己声明的换算率（/api/status 是公开的）—— 只当参考值
    site_rate = None
    st, raw = _get(root + "/api/status", timeout=12, insecure=insecure)
    if st == 200:
        d = (_json(raw) or {}).get("data") or {}
        if isinstance(d, dict):
            if not qpu and d.get("quota_per_unit"):
                qpu = _num(d["quota_per_unit"])
            for k in ("usd_exchange_rate", "exchange_rate"):
                if d.get(k):
                    site_rate = _num(d[k], rate)
                    break
    if not qpu:
        qpu = DEFAULT_QUOTA_PER_UNIT
    # 默认把那个 $ 当符号（1:1）；站点自报的汇率只在「按汇率」模式下生效
    if (rate_mode or "one") == "one":
        rate = SITE_RATE_ONE
    else:
        rate = _num(usd_cny, 0) or site_rate or DEFAULT_USD_CNY
    cny_per_quota = rate / qpu
    if (rate_mode or "one") == "one":
        notes.append("金额按 1:1 折成人民币（%g 额度 = $1 = 1 元）"
                     % qpu
                     + ("；站点自报汇率 %g 只在真按美元收费时才算" % site_rate
                        if site_rate else ""))

    headers = _auth_headers(token, cookie, user_id, extra=extra_h)
    bill = _blank("oneapi", root)
    bill["window_days"] = days
    bill["account"] = {"quota_per_unit": qpu, "usd_cny": rate,
                       "cny_per_quota": cny_per_quota, "unit": "quota",
                       "site_rate": site_rate}

    # -- 账户余额 --
    # 新版改过的 new-api（错误码 AUTH_UNAUTHORIZED、message_key 那一套）不再认
    # 裸 Cookie，账号接口要短期 access_token：用 Cookie 换一次再请求。
    swapped = ""
    if cookie and not token:
        tk, why = _refresh_token(root, cookie, user_id, insecure=insecure)
        if tk:
            token, swapped = tk, "ok"
            headers = _auth_headers(token, cookie, user_id, extra=extra_h)
            notes.append("用 Cookie 换到一枚短期 access_token，本次同步用它认证")
        elif why != "HTTP 404":
            swapped = why

    st, raw = _get(root + "/api/user/self", headers, insecure=insecure)
    if st in (401, 403) and cookie and swapped != "ok":
        tk, why = _refresh_token(root, cookie, user_id, insecure=insecure)
        if tk:
            token = tk
            headers = _auth_headers(token, cookie, user_id, extra=extra_h)
            notes.append("原令牌被拒，已用 Cookie 换新的 access_token 重试")
            st, raw = _get(root + "/api/user/self", headers, insecure=insecure)

    if st != 200:
        if st == 0:
            raise RuntimeError("连不上站点：%s（网络/代理问题，或站点暂时封了这个出口 IP，"
                               "过几分钟再试）" % _hint(raw))
        if st in (401, 403):
            if not cookie:
                raise RuntimeError(
                    "站方不认这个令牌（HTTP %s）。这个站要的是 access_token 或 session "
                    "Cookie，不是 sk- 调用密钥。" % st)
            if not _has_session_cookie(cookie):
                raise RuntimeError(
                    "Cookie 里没有 session=…，只有 nsr_did / sidebar_state 这类界面 cookie，"
                    "站方不认。去 F12 网络里找 /api/user/auth/refresh 那条请求，复制它整段 Cookie。")
            raise RuntimeError(
                "Cookie 被拒（HTTP %s）——多半是已经退出登录了，重新登录一次再复制 Cookie。" % st)
        raise RuntimeError("读取账户失败 HTTP %s：%s" % (st, _hint(raw)))
    obj = _json(raw) or {}
    if obj.get("success") is False:
        raise RuntimeError("站点拒绝：%s（令牌可能过期，或需要 New-Api-User）"
                           % (obj.get("message") or "未登录"))
    u = obj.get("data") or {}
    if isinstance(u, dict):
        bill["account"]["balance"] = _num(u.get("quota")) * cny_per_quota
        bill["account"]["used"] = _num(u.get("used_quota")) * cny_per_quota
        bill["account"]["username"] = u.get("username") or u.get("display_name") or ""
        bill["account"]["request_count"] = int(_num(u.get("request_count")))

    # -- 消费日志 --
    end_ts = int(time.time())
    start_ts = end_ts - max(1, int(days)) * 86400
    logs = []
    seen = set()
    got_total = None
    for p in range(max_pages):
        q = urllib.parse.urlencode({
            "p": p, "page_size": page_size, "type": 2,
            "start_timestamp": start_ts, "end_timestamp": end_ts,
        })
        st, raw = _get(root + "/api/log/self?" + q, headers, timeout=25, insecure=insecure)
        if st != 200:
            notes.append("日志接口 HTTP %s：%s" % (st, _hint(raw)))
            break
        obj = _json(raw) or {}
        if obj.get("success") is False:
            notes.append("日志接口拒绝：%s" % (obj.get("message") or ""))
            break
        items, tot = _extract_list(obj)
        if tot is not None:
            got_total = tot
        if not items:
            break
        new = 0
        for it in items:
            if not isinstance(it, dict):
                continue
            key = it.get("id") or (str(it.get("created_at")) + str(it.get("quota"))
                                   + str(it.get("prompt_tokens")))
            if key in seen:
                continue
            seen.add(key)
            new += 1
            logs.append(_norm_log(it, cny_per_quota))
        if new == 0 or len(items) < page_size:
            break

    if got_total is not None and got_total > len(logs):
        notes.append("站点共 %d 条消费记录，本次取回最近 %d 条（约 %.1f 天窗口）"
                     % (got_total, len(logs), days))

    bill["logs"] = logs
    _derive(bill, notes)
    bill["notes"] = notes
    return bill


def _norm_log(it, cny_per_quota):
    quota = _num(it.get("quota"))
    pin = _num(it.get("prompt_tokens"))
    pout = _num(it.get("completion_tokens"))
    cache = 0.0
    det = it.get("prompt_tokens_details")
    if isinstance(det, dict):
        cache = _num(det.get("cached_tokens"))
    for k in ("cache_tokens", "cached_tokens", "cache_hit_tokens", "cache_read_tokens"):
        if not cache and it.get(k):
            cache = _num(it[k])
    ts = _num(it.get("created_at")) or _num(it.get("timestamp")) or 0
    return {
        "ts": int(ts),
        "model": str(it.get("model_name") or it.get("model") or ""),
        "in": int(pin), "out": int(pout), "cache": int(cache),
        "quota": quota,
        "cost": quota * cny_per_quota,
    }


def _derive(bill, notes=None):
    """从 logs 汇总 totals / models / days。没有 logs 时保留原 totals。"""
    logs = bill.get("logs") or []
    if not logs:
        t = bill["totals"]
        t["total"] = t.get("total") or (t.get("in", 0) + t.get("out", 0) + t.get("cache", 0))
        return bill

    tin = sum(l["in"] for l in logs)
    tout = sum(l["out"] for l in logs)
    tcache = sum(l["cache"] for l in logs)
    cost = sum(l["cost"] for l in logs)

    bill["totals"] = {
        "requests": len(logs), "cost": cost, "currency": "CNY",
        "in": tin, "out": tout, "cache": tcache,
        # 站点普遍把输入拆成「未命中 + 命中」，两者相加才是输入总量
        "total": tin + tout,
    }

    by_model = {}
    for l in logs:
        m = l["model"] or "(未知)"
        g = by_model.setdefault(m, {"model": m, "calls": 0, "tokens": 0, "cost": 0.0})
        g["calls"] += 1
        g["tokens"] += l["in"] + l["out"]
        g["cost"] += l["cost"]
    bill["models"] = sorted(by_model.values(), key=lambda x: -x["cost"])

    by_day = {}
    for l in logs:
        if not l["ts"]:
            continue
        day = time.strftime("%Y-%m-%d", time.localtime(l["ts"]))
        g = by_day.setdefault(day, {"day": day, "calls": 0, "in": 0, "out": 0,
                                    "cache": 0, "cost": 0.0})
        g["calls"] += 1
        g["in"] += l["in"]
        g["out"] += l["out"]
        g["cache"] += l["cache"]
        g["cost"] += l["cost"]
    bill["days"] = sorted(by_day.values(), key=lambda x: x["day"])
    if notes is not None and len(logs) and tin and not tcache:
        notes.append("日志里没有缓存命中字段，账单无法区分缓存价，只能用未命中价做上界")
    return bill


# ------------------------------------------------------------------ 自研控制台（OpenSlate 系）

def fetch_openslate(base_url, token="", days=7, page_size=100, max_pages=20,
                    insecure=False):
    """直连 OpenSlate 这类自研控制台。

    没有 one-api 的 /api/user/self，走它自己的接口：
      GET /api/usage/my?current=1&size=100  -> data.records[{model_name, input_tokens,
                                                output_tokens, cache_tokens, cost, created_at}]
      GET /api/points/my                    -> data.balance（元）
      GET /api/user/dashboard               -> stats（全时段汇总，兜底用）
    认证就是 Authorization: Bearer <localStorage 里的 zz_token>。
    """
    root = root_of(base_url)
    tk = (token or "").strip()
    if not tk:
        raise RuntimeError("需要后台登录令牌：F12 → Application → Local Storage → zz_token")
    if tk.lower().startswith("bearer "):
        tk = tk[7:].strip()
    h = {"Authorization": "Bearer " + tk}

    bill = _blank("openslate", root)
    bill["window_days"] = max(1, int(days))
    notes = []

    st, raw = _get(root + "/api/points/my", h, timeout=15, insecure=insecure)
    if st in (401, 403):
        raise RuntimeError("令牌无效或已过期（HTTP %s），把 zz_token 重新复制一次" % st)
    obj = _json(raw) or {}
    if isinstance(obj, dict) and obj.get("code") == 200:
        d = obj.get("data") or {}
        bill["account"] = {"balance": _num(d.get("balance")),
                           "points": _num(d.get("points"))}

    now = int(time.time())
    start = now - bill["window_days"] * 86400
    logs, got_total = [], None
    for p in range(1, max_pages + 1):
        st, raw = _get(root + "/api/usage/my?current=%d&size=%d" % (p, page_size),
                       h, timeout=25, insecure=insecure)
        if st == 401:
            raise RuntimeError("令牌失效（HTTP 401），把 zz_token 重新复制一次")
        obj = _json(raw) or {}
        if obj.get("code") != 200:
            notes.append("用量接口返回 code=%s：%s"
                         % (obj.get("code"), (obj.get("msg") or "")[:60]))
            break
        d = obj.get("data") or {}
        recs = d.get("records") or []
        if d.get("total") is not None:
            got_total = int(_num(d.get("total")))
        if not recs:
            break
        older = False
        for r in recs:
            ts = _parse_ts(r.get("created_at"))
            if ts and ts < start:
                older = True
                continue
            cost = _num(r.get("cost"))
            logs.append({
                "ts": ts,
                "model": str(r.get("model_name") or ""),
                "in": int(_num(r.get("input_tokens"))),
                "out": int(_num(r.get("output_tokens"))),
                "cache": int(_num(r.get("cache_tokens"))),
                "quota": cost,          # 这个站的明细本来就是元，不用换额度
                "cost": cost,
            })
        if older or len(recs) < page_size:
            break

    bill["logs"] = logs
    bill["account"]["request_count"] = len(logs)
    if got_total and got_total > len(logs):
        notes.append("账号累计 %d 条调用，本次取最近 %d 条（%d 天窗口）"
                     % (got_total, len(logs), bill["window_days"]))
    _derive(bill, notes)

    if not logs:      # 窗口内没有调用，退回看板（全时段累计）
        st, raw = _get(root + "/api/user/dashboard", h, timeout=15, insecure=insecure)
        obj = _json(raw) or {}
        if obj.get("code") == 200:
            s = (obj.get("data") or {}).get("stats") or {}
            tot = int(_num(s.get("total_tokens")))
            bill["totals"] = {"requests": int(_num(s.get("total_requests"))),
                              "cost": _num(s.get("total_cost")), "currency": "CNY",
                              "in": tot, "out": 0, "cache": 0, "total": tot,
                              "partial": True}
            notes.append("最近 %d 天没有调用明细，数字来自看板的全时段累计" % bill["window_days"])
    bill["notes"] = notes
    return bill


# ------------------------------------------------------------------ 粘贴导入

_KEYS = {
    "in": ("prompt_tokens", "input_tokens", "promptTokens", "inputTokens",
           "input_token", "tokens_in", "input"),
    "out": ("completion_tokens", "output_tokens", "completionTokens", "outputTokens",
            "output_token", "tokens_out", "output"),
    "cache": ("cache_hit_tokens", "cached_tokens", "cache_tokens", "cache_hit",
              "cachedTokens", "cache_read_input_tokens", "cacheReadInputTokens",
              "cache_read"),
    "cost": ("quota", "cost", "amount", "charge", "fee", "money", "price", "spend",
             "credits", "tcredits", "TCredits", "consumed", "total_cost"),
    "model": ("model", "model_name", "modelName", "model_id", "modelId"),
    "ts": ("created_at", "createdAt", "time", "timestamp", "ts", "date", "day", "hour"),
    "calls": ("count", "calls", "requests", "request_count", "total_requests", "次数"),
}

_FIELD_LABEL = {"in": "输入 token", "out": "输出 token", "cache": "缓存命中",
                "cost": "金额", "model": "模型", "ts": "时间", "calls": "调用次数"}


def _pick(rec, kind):
    for k in _KEYS[kind]:
        if k in rec and rec[k] not in (None, ""):
            return rec[k]
    # 大小写/下划线不敏感兜底
    low = {str(k).lower().replace("_", "").replace("-", ""): v
           for k, v in rec.items() if isinstance(k, str)}
    for k in _KEYS[kind]:
        kk = k.lower().replace("_", "").replace("-", "")
        if kk in low and low[kk] not in (None, ""):
            return low[kk]
    return None


def _guess_cost_unit(vals):
    """金额量级启发：全是整数且远超 token 量级的，多半是内部 quota 而非货币。"""
    if not vals:
        return "cny"
    mx = max(vals)
    if mx > 5000:
        return "quota"
    return "cny"


def _rec_key(rec):
    """明细去重用的指纹。

    有 id 就用 id（同一站点的日志 id 唯一）；没有就把时间+模型+token+金额拼起来。
    分页重叠、脚本重复抓取都靠这个挡掉，否则 290 条能算成 390 条。
    """
    for k in ("id", "log_id", "logId", "request_id", "requestId", "trace_id"):
        v = rec.get(k)
        if v not in (None, ""):
            return "id:%s" % v
    parts = [str(rec.get(k) if rec.get(k) is not None else "") for k in
             ("created_at", "createdAt", "time", "timestamp",
              "model_name", "model", "prompt_tokens", "completion_tokens",
              "quota", "cost")]
    s = "|".join(parts)
    return s if s.strip("|") else None


def parse_paste(obj, quota_per_unit=None, usd_cny=DEFAULT_USD_CNY, source="paste",
                cost_unit="auto"):
    """把任意后台 JSON 尽量解析成 BillData。识别不了就抛错，不瞎猜。"""
    # 采集脚本的输出：{"_capture":[{url,status,body}, ...]} → 挑最像账单的那份
    if isinstance(obj, dict) and isinstance(obj.get("_capture"), list):
        return _parse_capture(obj["_capture"], quota_per_unit, usd_cny, source, cost_unit)

    bill = _blank(source)
    notes = []
    qpu = _num(quota_per_unit, 0) or DEFAULT_QUOTA_PER_UNIT
    rate = _num(usd_cny, DEFAULT_USD_CNY) or DEFAULT_USD_CNY

    candidates = _find_records(obj)
    if not candidates:
        summ = _parse_summary(obj)
        if summ:
            bill["totals"].update(summ["totals"])
            bill["account"] = {"quota_per_unit": qpu, "usd_cny": rate,
                               "cny_per_quota": 1.0, "unit": "cny"}
            notes.append("这是汇总数据，没有逐条明细，所以没法反推真实单价")
            if not (summ["totals"].get("in") or summ["totals"].get("out")):
                notes.append("缺少输入/输出拆分，单价核对会跳过，只能核对总额")
            bill["notes"] = notes
            return bill
        raise RuntimeError("这段 JSON 里找不到明细数组，也没有可识别的汇总字段。"
                           "请在后台 F12 → Network 里复制接口响应，或直接用「手填汇总」。")

    recs, where = candidates
    notes.append("识别到明细：%s，共 %d 条" % (where, len(recs)))

    got = {"in": False, "out": False, "cost": False}
    logs, seen, dup = [], set(), 0
    for rec in recs[:20000]:
        if not isinstance(rec, dict):
            continue
        key = _rec_key(rec)
        if key is not None:
            if key in seen:
                dup += 1
                continue
            seen.add(key)
        vin = _pick(rec, "in")
        vout = _pick(rec, "out")
        vcost = _pick(rec, "cost")
        vmodel = _pick(rec, "model")
        vts = _pick(rec, "ts")
        if vin is not None:
            got["in"] = True
        if vout is not None:
            got["out"] = True
        if vcost is not None:
            got["cost"] = True
        logs.append({
            "ts": _parse_ts(vts),
            "model": str(vmodel or ""),
            "in": int(_num(vin)), "out": int(_num(vout)),
            "cache": int(_num(_pick(rec, "cache"))),
            "quota": _num(vcost),
        })

    neg = [_num(l.get("quota")) for l in logs if _num(l.get("quota")) < 0]
    if logs and len(neg) == len(logs):
        raise RuntimeError(
            "这 %d 条记录的金额全是负数（%g）。中转站后台里 -1 一般表示"
            "「无限额度 / 未消费」，说明这份数据是令牌列表或账户信息，不是消费明细。"
            "请先打开「使用日志 / 用量」页面，再在控制台跑一次采集脚本。"
            % (len(neg), neg[0]))

    if not (got["in"] or got["out"] or got["cost"]):
        raise RuntimeError("明细字段认不出来（没有 token 数或金额）。"
                           "请改用手填汇总，或把接口 JSON 原样贴给我调整解析。")

    if dup:
        notes.append("传进来 %d 条，其中 %d 条重复（分页重叠或重复抓取），已去掉，按 %d 条算"
                     % (len(recs), dup, len(logs)))

    cost_vals = [l["quota"] for l in logs if l["quota"] > 0]
    unit = cost_unit if cost_unit in ("cny", "quota") else _guess_cost_unit(cost_vals)
    if unit == "quota":
        k = rate / qpu
        if abs(rate - SITE_RATE_ONE) < 1e-9:
            notes.append("金额列按内部额度换算（%g 额度 = 站点的 $1，按 1:1 当成 1 元，"
                         "即那个 $ 只是符号）；这站真按美元收费就把换算改成「按汇率」"
                         % qpu)
        else:
            notes.append("金额列按内部额度换算（%g 额度 = $1，$1 = %g 元）；"
                         "如果它是「充 1 元给 $1」那种站，改成 1:1 就会小 7 倍"
                         % (qpu, rate))
    else:
        k = 1.0
        notes.append("金额列本来就是人民币，不用换算")
    for l in logs:
        l["cost"] = l["quota"] * k

    bill["logs"] = [l for l in logs if l["in"] or l["out"] or l["cost"]]
    bill["window_days"] = 0
    bill["account"] = {"quota_per_unit": qpu, "usd_cny": rate, "cny_per_quota": k,
                       "unit": unit}
    _derive(bill, notes)
    if not bill["totals"]["in"] and got["in"] is False:
        notes.append("没有输入 token 字段，单价核对会跳过")
    bill["notes"] = notes
    return bill


def recalc(bill, usd_cny=None, quota_per_unit=None, mode="one"):
    """按新的换算参数重算一份已有账单。

    明细里留着站点的原始 quota，所以不用重新导入 —— 改「那个 $ 是不是真美元」
    只要把 quota 乘上新的倍率即可。
    """
    if not isinstance(bill, dict):
        raise ValueError("账单数据坏了")
    acc = dict(bill.get("account") or {})
    qpu = (_num(quota_per_unit, 0) or _num(acc.get("quota_per_unit"), 0)
           or DEFAULT_QUOTA_PER_UNIT)
    rate = rate_for(usd_cny, mode)
    old_k = _num(acc.get("cny_per_quota"), 0) or 1.0
    unit = acc.get("unit") or ("cny" if abs(old_k - 1.0) < 1e-12 else "quota")
    # 上次那条换算说明要换掉，其它提示保留
    notes = [n for n in (bill.get("notes") or [])
             if ("额度换算" not in n and "汇率" not in n and "不用换算" not in n
                 and "重算" not in n)]
    logs = bill.get("logs") or []
    if unit == "cny":
        k = 1.0
        notes.append("金额列本来就是人民币，不用换算")
    elif abs(rate - SITE_RATE_ONE) < 1e-9:
        k = 1.0 / qpu
        notes.append("已按 1:1 重算：%g 额度 = 站点的 $1 = 1 元（充 1 元给 $1 的那种站）"
                     % qpu)
    else:
        k = rate / qpu
        notes.append("已按汇率重算：%g 额度 = $1，$1 = %g 元" % (qpu, rate))

    if logs:
        for l in logs:
            q = l.get("quota")
            if q is None:
                q = (_num(l.get("cost"), 0) or 0) / old_k if old_k else 0.0
                l["quota"] = q
            l["cost"] = (_num(q, 0) or 0) * k
        _derive(bill, None)
    else:
        t = bill.get("totals") or {}
        c = _num(t.get("cost"), 0) or 0
        if old_k and abs(old_k - k) > 1e-12:
            t["cost"] = c / old_k * k
        bill["totals"] = t

    bill["account"] = {"quota_per_unit": qpu, "usd_cny": rate, "cny_per_quota": k,
                       "unit": unit}
    # 去重：_derive 可能又加一条同样的提示
    seen, uniq = set(), []
    for n in notes:
        if n in seen:
            continue
        seen.add(n)
        uniq.append(n)
    bill["notes"] = uniq
    return bill


def _parse_capture(items, qpu=None, usd_cny=DEFAULT_USD_CNY, source="paste",
                   cost_unit="auto"):
    """采集脚本一次抓回多份接口响应，挑信息量最大的那份当账单。

    打分：有明细 >> 有金额 >> 有 token，最后按明细条数微调。
    自研后台的接口路径千奇百怪，但「哪份响应里装着账单」是能算出来的。
    """
    best, best_url, best_score = None, "", -10 ** 9
    tried, errs = 0, []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        body = it.get("body")
        if body is None:
            continue
        tried += 1
        url = str(it.get("url") or "")
        try:
            b = parse_paste(body, quota_per_unit=qpu, usd_cny=usd_cny,
                            source=source, cost_unit=cost_unit)
        except Exception as e:
            errs.append("%s：%s" % (url.rsplit("/", 1)[-1] or "其中一份",
                                    str(e)[:80]))
            continue
        t = b["totals"]
        logs = b["logs"] or []
        if _num(t.get("cost"), 0) < 0:
            errs.append("%s：金额是负数，不是消费明细" % (url or "其中一份"))
            continue
        has_model = any((l.get("model") or "").strip() for l in logs)
        has_tok = bool(t.get("in") or t.get("out"))
        score = (1000 if logs else 0) + (100 if t.get("cost") else 0) \
            + (10 if has_tok else 0) + min(len(logs), 500)
        if has_model:
            score += 60
        if logs and not has_tok and not has_model:
            # 有条目、有金额，但既没有模型也没有 token：令牌列表/账户信息这类
            score -= 900
        if _NOT_BILL_URL.search(url):
            score -= 700
        if _BILL_URL.search(url):
            score += 200
        if score > best_score:
            best, best_url, best_score = b, url, score

    if not best or best_score < 0:
        hint = ("；".join(errs[:3]) if errs else "抓到的响应里没有可识别的账单字段")
        raise RuntimeError("采集到 %d 份响应，但没有一份像账单（%s）。"
                           "先把站点后台的「使用日志 / 用量」页面打开（列表出来）再跑一次脚本；"
                           "或者改用手填汇总，把后台那几个总数抄进来。" % (tried, hint))

    head = "从 %d 份响应里选中 %s" % (tried, best_url or "其中一份")
    best["notes"] = [head] + [n for n in (best.get("notes") or []) if n != head]
    return best


def _parse_ts(v):
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        v = float(v)
        if v > 1e12:      # 毫秒
            v /= 1000.0
        return int(v)
    s = str(v).strip().replace("/", "-")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y%m%d%H"):
        try:
            return int(time.mktime(time.strptime(s[:19], fmt)))
        except Exception:
            pass
    return 0


def _find_records(obj):
    """在任意 JSON 里找最像明细的那个数组。"""
    best = None
    if isinstance(obj, list):
        best = (obj, "$")
    elif isinstance(obj, dict):
        # 常见包装：data / items / logs / records
        for k in ("data", "logs", "items", "records", "list", "usage", "details"):
            v = obj.get(k)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                best = (v, k)
                break
            if isinstance(v, dict):
                for k2 in ("items", "records", "list", "logs", "data"):
                    v2 = v.get(k2)
                    if isinstance(v2, list) and v2 and isinstance(v2[0], dict):
                        best = (v2, "%s.%s" % (k, k2))
                        break
                if best:
                    break
    if not best:
        return None
    recs = [r for r in best[0] if isinstance(r, dict)]
    if not recs:
        return None
    score = sum(1 for r in recs[:10]
                if any(k in r for k in _KEYS["in"] + _KEYS["out"] + _KEYS["cost"]))
    if score == 0:
        return None
    return recs, best[1]


def _clean_num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v or "").strip()
    for ch in ("¥", "￥", "$", ",", " ", "元", "次", "个"):
        s = s.replace(ch, "")
    mult = 1.0
    if s.endswith("万"):
        s, mult = s[:-1], 1e4
    elif s.endswith("亿"):
        s, mult = s[:-1], 1e8
    elif s.endswith("M") or s.endswith("m"):
        s, mult = s[:-1], 1e6
    elif s.endswith("K") or s.endswith("k"):
        s, mult = s[:-1], 1e3
    try:
        return float(s) * mult
    except ValueError:
        return None


_SUM_FIELDS = {
    "requests": ("total_requests", "requests", "request_count", "totalRequest",
                 "count", "calls", "总请求", "总请求数", "调用数量", "调用次数"),
    "cost": ("total_cost", "cost", "cost_total", "totalCost", "amount", "charge",
             "spend", "已消费", "总消费", "消费", "消费金额"),
    "in": ("total_input_tokens", "input_tokens", "prompt_tokens", "tokens_in",
           "totalInputTokens", "输入token", "输入"),
    "out": ("total_output_tokens", "output_tokens", "completion_tokens", "tokens_out",
            "totalOutputTokens", "输出token", "输出"),
    "cache": ("cache_hit_tokens", "cached_tokens", "cache_tokens", "total_cache_tokens",
              "缓存命中"),
    "total": ("total_tokens", "tokens", "totalTokens", "总token", "总 Token 数",
              "总Token数", "词元"),
}


def _parse_summary(obj):
    """没有明细数组，但给了汇总数字（后台顶部那几个大数字）。"""
    node = obj
    if isinstance(obj, dict):
        for k in ("data", "summary", "overview", "stats", "total", "usage"):
            v = obj.get(k)
            if isinstance(v, dict):
                node = v
                break
    if not isinstance(node, dict):
        return None

    low = {}
    for k, v in node.items():
        if isinstance(k, str):
            low[k.strip()] = v
            low[k.strip().lower().replace("_", "")] = v

    def grab(kind):
        for key in _SUM_FIELDS[kind]:
            for cand in (key, key.lower().replace("_", "")):
                if cand in low:
                    val = _clean_num(low[cand])
                    if val is not None:
                        return val
        return None

    got = {k: grab(k) for k in _SUM_FIELDS}
    if not any(got[k] for k in ("requests", "cost")):
        return None

    tin, tout = got["in"] or 0, got["out"] or 0
    if not (tin or tout) and got["total"]:
        tin = got["total"]          # 只有总量时记到输入侧，输出留空
        note_partial = True
    else:
        note_partial = False

    totals = {
        "requests": int(got["requests"] or 0),
        "cost": got["cost"] or 0.0,
        "currency": "CNY",
        "in": int(tin), "out": int(tout), "cache": int(got["cache"] or 0),
        "total": int(got["total"] or (tin + tout)),
        "partial": note_partial,
    }
    return {"totals": totals}


def manual_bill(requests, cost, tin, tout, tcache, source_note=""):
    """手填汇总。"""
    bill = _blank("manual")
    bill["totals"] = {
        "requests": int(requests or 0), "cost": float(cost or 0), "currency": "CNY",
        "in": int(tin or 0), "out": int(tout or 0), "cache": int(tcache or 0),
        "total": int(tin or 0) + int(tout or 0),
    }
    if source_note:
        bill["notes"].append(source_note)
    return bill


# ------------------------------------------------------------------ 站点牌价（自动填表用）

def _match_entry(arr, want, keys):
    """在价格表里找模型：先精确，再去掉 -日期后缀，最后包含。"""
    def val(e, k):
        return str(e.get(k) or "").strip().lower()

    for e in arr:
        for k in keys:
            if val(e, k) == want:
                return e
    for e in arr:
        for k in keys:
            v = val(e, k)
            if v and (v.startswith(want) or want.startswith(v)):
                return e
    for e in arr:
        for k in keys:
            v = val(e, k)
            if v and want in v:
                return e
    return None


def _tier_of(node):
    """one-api 的 group_prices 可能是 tiers 列表，也可能直接给字段。"""
    if not isinstance(node, dict):
        return None
    tiers = node.get("tiers")
    if isinstance(tiers, list) and tiers:
        t = tiers[0]
        if isinstance(t, dict):
            return t
    return node


def _price_options(entry, rate=DEFAULT_USD_CNY, group_ratio=None):
    """把一条 /api/pricing 记录转成 [{group, in, out, cache}]，单位：元 / 百万 token。"""
    opts = []
    groups = (entry or {}).get("group_prices") or {}
    if isinstance(groups, dict):
        for g, node in groups.items():
            t = _tier_of(node)
            if not t:
                continue
            cur = str((node or {}).get("currency") or "CNY").upper() \
                if isinstance(node, dict) else "CNY"
            k = 1.0 if cur.startswith("CNY") else rate
            pin = _num(t.get("input_cny_per_1m") or t.get("input_per_1m")
                       or t.get("input_price"))
            pout = _num(t.get("output_cny_per_1m") or t.get("output_per_1m")
                        or t.get("output_price"))
            pc = _num(t.get("cache_read_cny_per_1m") or t.get("cache_per_1m")
                      or t.get("cache_price"))
            if pin or pout:
                opts.append({"group": str(g), "in": pin * k,
                             "out": pout * k, "cache": pc * k})
    # 老版 new-api 只有倍率：quota = token*ratio*组倍率，500000 quota = $1
    if not opts and _num((entry or {}).get("model_ratio")):
        gr = group_ratio if isinstance(group_ratio, dict) else {}
        g = "default" if "default" in gr else (next(iter(gr), "") if gr else "")
        mult = _num(gr.get(g), 1.0) if isinstance(gr, dict) else 1.0
        base_usd = _num(entry.get("model_ratio")) * mult * 2.0
        comp = _num(entry.get("completion_ratio"), 1.0) or 1.0
        cache_r = _num(entry.get("cache_ratio"), 0.0)
        opts.append({"group": g or "默认", "in": base_usd * rate,
                     "out": base_usd * comp * rate,
                     "cache": base_usd * cache_r * rate})
    return opts


def _pick_group(opts, prefer="", usable=None, brand=""):
    """在多个分组里挑一个：账号所在组 > 品牌同名组 > default > 可用组最便宜 > 最便宜。"""
    # supply-* / auto-* 是站内供货渠道，不是给用户看的牌价
    clean = [o for o in opts
             if not re.match(r"(supply|auto|internal|test)", o["group"], re.I)]
    pool = clean or opts
    pick = None
    if prefer:
        pick = next((o for o in pool if o["group"] == prefer), None)
    if not pick and brand:
        pick = next((o for o in pool if brand in o["group"].lower()), None)
    if not pick:
        pick = next((o for o in pool if "default" in o["group"].lower()), None)
    if not pick and isinstance(usable, dict):
        cand = [o for o in pool if o["group"] in usable]
        if cand:
            pick = min(cand, key=lambda o: o["in"])
    if not pick:
        pick = min(pool, key=lambda o: o["in"])
    return pick


def fetch_listed_prices(base_url, model, token="", cookie="", user_id="",
                        insecure=False):
    """读站点自己公布的牌价（元/百万 token），用于自动填「实际标价」。

    支持两类站：
      one-api / new-api  GET /api/pricing        -> data[].group_prices[组].tiers[0]
      OpenSlate 系        GET /api/public/models -> data.list[].input_price ...
    返回 {ok, in, out, cache, group, groups, source, notes}
    """
    root = root_of(base_url)
    want = (model or "").strip().lower()
    out = {"ok": False, "model": model, "in": 0.0, "out": 0.0, "cache": 0.0,
           "group": "", "groups": [], "source": "", "notes": []}
    if not root or not want:
        out["notes"].append("地址或模型名为空")
        return out

    rate = DEFAULT_USD_CNY

    # ---- one-api / new-api ----
    st, raw = _get(root + "/api/pricing", timeout=20, insecure=insecure)
    if st == 200:
        obj = _json(raw) or {}
        arr = obj.get("data")
        if isinstance(arr, dict):
            arr = arr.get("models") or arr.get("data") or []
        if isinstance(arr, list) and arr:
            e = _match_entry(arr, want, ("model_name", "model", "name",
                                         "display_name_en", "display_name"))
            if e:
                opts = _price_options(e, rate,
                                      obj.get("group_ratio") if isinstance(obj, dict) else None)

                if opts:
                    # 优先用账号实际所在的分组，否则 default，其次可用的最便宜一组
                    prefer = ""
                    if token or cookie:
                        st2, raw2 = _get(root + "/api/user/self",
                                         _auth_headers(token, cookie, user_id),
                                         timeout=12, insecure=insecure)
                        if st2 == 200:
                            u = ((_json(raw2) or {}).get("data") or {})
                            if isinstance(u, dict):
                                prefer = str(u.get("group") or "")
                    brand = re.split(r"[-_.]", want)[0]
                    pick = _pick_group(opts, prefer, obj.get("usable_group"), brand)
                    out.update({"ok": True, "in": pick["in"], "out": pick["out"],
                                "cache": pick["cache"], "group": pick["group"],
                                "groups": [o["group"] for o in opts],
                                "source": "/api/pricing",
                                "notes": ["站点共 %d 个分组，取「%s」这一组"
                                          % (len(opts), pick["group"])]})
                    return out

    # ---- OpenSlate 系 ----
    for page in (1, 2, 3):
        st, raw = _get(root + "/api/public/models?page=%d&page_size=100" % page,
                       timeout=20, insecure=insecure)
        if st != 200:
            break
        obj = _json(raw) or {}
        data = obj.get("data") if isinstance(obj, dict) else None
        lst = (data or {}).get("list") if isinstance(data, dict) else None
        if not isinstance(lst, list) or not lst:
            break
        e = _match_entry(lst, want, ("name", "model", "model_name", "display_name"))
        if e:
            out.update({"ok": True,
                        "in": _num(e.get("input_price")),
                        "out": _num(e.get("output_price")),
                        "cache": _num(e.get("cache_price")),
                        "group": str(e.get("billing_mode") or "token"),
                        "source": "/api/public/models",
                        "notes": ["模型卡片价"]})
            return out
        total = _num((data or {}).get("total"))
        if total and page * 100 >= total:
            break

    out["notes"].append("站点没有公开价格接口，或价格表里没有这个模型——手填或用账单实测价")
    return out


# ------------------------------------------------------------------ 列出站点模型

def _price_map(root, token="", cookie="", user_id="", insecure=False):
    """拉整张价目表 -> {模型名小写: {in, out, cache, group}}，顺便当「模型清单」兜底。"""
    rate = DEFAULT_USD_CNY
    out = {}

    def prefer_group():
        if not (token or cookie):
            return ""
        st, raw = _get(root + "/api/user/self", _auth_headers(token, cookie, user_id),
                       timeout=12, insecure=insecure)
        if st == 200:
            u = ((_json(raw) or {}).get("data") or {})
            if isinstance(u, dict):
                return str(u.get("group") or "")
        return ""

    st, raw = _get(root + "/api/pricing", timeout=20, insecure=insecure)
    if st == 200:
        obj = _json(raw) or {}
        arr = obj.get("data")
        if isinstance(arr, dict):
            arr = arr.get("models") or arr.get("data") or []
        if isinstance(arr, list) and arr:
            prefer = prefer_group()
            for e in arr:
                name = str(e.get("model_name") or e.get("model") or e.get("name") or "").strip()
                if not name:
                    continue
                opts = _price_options(e, rate, obj.get("group_ratio"))
                if not opts:
                    continue
                brand = re.split(r"[-_.]", name.lower())[0]
                p = _pick_group(opts, prefer, obj.get("usable_group"), brand)
                out[name.lower()] = {"in": p["in"], "out": p["out"],
                                     "cache": p["cache"], "group": p["group"]}

    if out:
        return out

    # OpenSlate 系：模型卡片自带价格
    for page in (1, 2, 3):
        st, raw = _get(root + "/api/public/models?page=%d&page_size=100" % page,
                       timeout=20, insecure=insecure)
        if st != 200:
            break
        obj = _json(raw) or {}
        data = obj.get("data") if isinstance(obj, dict) else None
        lst = (data or {}).get("list") if isinstance(data, dict) else None
        if not isinstance(lst, list) or not lst:
            break
        for e in lst:
            name = str(e.get("model") or e.get("model_name") or e.get("name") or "").strip()
            if not name:
                continue
            out[name.lower()] = {"in": _num(e.get("input_price")),
                                 "out": _num(e.get("output_price")),
                                 "cache": _num(e.get("cache_price")),
                                 "group": str(e.get("billing_mode") or "")}
        total = _num((data or {}).get("total"))
        if total and page * 100 >= total:
            break
    return out


def fetch_site_models(base_url, api_key="", token="", cookie="", user_id="",
                      insecure=False, limit=800, catalog=False):
    """列出**这个 key 能调的**模型名，给「模型」下拉框用。

    默认只问 GET {base}/models：这是 key 自己的权限范围。有的站一个 key 只放
    一个模型，就不该把全站目录（公开价目表）都倒出来。

    没有 key 时不再偷偷退到公开价目表——那是全站目录，不是你的权限。
    确实要看全站目录（比如还没买 key，想先看看模型怎么命名）才传 catalog=True。

    返回 {ok, models:[{id, owner, price}], source, notes, count, scoped, need_key}
    """
    out = {"ok": False, "models": [], "source": "", "notes": [], "count": 0,
           "scoped": False, "need_key": False}
    root = root_of(base_url)
    if not root:
        out["notes"].append("还没填 Base URL")
        return out

    base = (base_url or "").strip().rstrip("/")
    if not re.search(r"/v\d+[a-z]*$", base, re.I):
        base = root + "/v1"

    key = (api_key or "").strip()
    if not key and not catalog:
        out["need_key"] = True
        out["notes"].append("先填 API Key 再读——只列这个 key 能调的模型，不读全站目录")
        return out

    found, owners, src = {}, {}, ""
    errs = []          # 401 比后面的 404 更说明问题，别被后者盖掉
    if key:
        auth = _auth_headers(key, cookie, user_id)
        for url in (base + "/models", root + "/models"):
            st, raw = _get(url, auth, timeout=25, insecure=insecure)
            if st == 0:
                why0 = _short_err(raw)
                if "CERTIFICATE_VERIFY_FAILED" in why0:
                    errs.append((0, "%s 证书验证不过（%s）；可能是本机根证书库缺这张根，"
                                    "重启服务或换个网络再试" % (url, why0)))
                else:
                    errs.append((0, "连不上 %s（%s）" % (url, why0) if why0
                                 else "连不上 %s" % url))
                continue
            if st != 200:
                if st in (401, 403):
                    errs.append((st, "站方不认这个 key（HTTP %d）" % st))
                else:
                    errs.append((st, "%s 返回 HTTP %d" % (url, st)))
                continue
            obj = _json(raw) or {}
            data = obj.get("data") if isinstance(obj, dict) else None
            if isinstance(data, dict):
                data = data.get("list") or data.get("models") or data.get("items") or []
            if isinstance(obj, list) and obj:
                data = obj
            if isinstance(data, list) and data:
                for it in data[:limit]:
                    if isinstance(it, str):
                        mid, ow = it.strip(), ""
                    elif isinstance(it, dict):
                        mid = str(it.get("id") or it.get("model")
                                  or it.get("name") or "").strip()
                        ow = str(it.get("owned_by") or it.get("owner") or "")
                    else:
                        continue
                    if mid:
                        found[mid] = True
                        if ow:
                            owners[mid] = ow
                if found:
                    src = url
                    out["scoped"] = True
                    break
                errs.append((200, "这个 key 在站点上没挂任何模型（HTTP 200 但清单是空的）"))
            else:
                errs.append((200, "%s 没返回模型清单" % url))
        auth_bad = [m for st, m in errs if st in (401, 403)]
        why = auth_bad[0] if auth_bad else (errs[-1][1] if errs else "")

    prices = _price_map(root, token, cookie, user_id, insecure)
    fell_back = False
    if not found and catalog and prices:
        found = {k: True for k in prices}
        src = "/api/pricing 或 /api/public/models（全站目录）"
        fell_back = True
        out["notes"] = []
        out["notes"].append("这是站点公开价目表里的全部 %d 个模型，不是你这个 key 的权限"
                            "——实际能调哪些，要填 API Key 再读" % len(found))

    if not found:
        if not out["notes"]:
            out["notes"].append(why or "站点没给模型清单，手动填模型名")
        elif why and not catalog:
            out["notes"] = [why]
        return out

    models = []
    for mid in sorted(found, key=lambda s: s.lower()):
        p = prices.get(mid.lower())
        models.append({"id": mid, "owner": owners.get(mid, ""),
                       "price": ({"in": round(p["in"], 6), "out": round(p["out"], 6),
                                  "cache": round(p["cache"], 6),
                                  "group": p.get("group", "")} if p else None)})
    priced = sum(1 for m in models if m["price"])
    out.update({"ok": True, "models": models, "count": len(models), "source": src})
    if priced and not fell_back and not out["scoped"]:
        out["notes"].append("其中 %d 个能对到站点价目表，带 ¥ 的选中后会直接填标价" % priced)
    return out


# ------------------------------------------------------------------ 真实单价反推

def fit_unit_prices(logs, cny_per_quota=1.0):
    """
    用多条日志反推站点真实单价：quota ≈ a*in + b*out（二元最小二乘）。

    这是抓猫腻的核心——标价说 ¥0.2/M，但回归出来的 a 可能是 ¥0.9/M。
    要求样本里 in/out 比例有足够变化，否则方程病态，直接返回 ok=False。
    """
    pts = []
    for l in logs or []:
        q = l.get("quota") or 0
        if q <= 0:
            continue
        if l.get("in", 0) < 1 and l.get("out", 0) < 1:
            continue
        pts.append((float(l["in"]), float(l["out"]), float(q)))
    n = len(pts)
    if n < 8:
        return {"ok": False, "why": "样本只有 %d 条，至少要 8 条" % n, "n": n}

    Sxx = Sxy = Syy = Sa = Sb = 0.0
    for x, y, q in pts:
        Sxx += x * x
        Sxy += x * y
        Syy += y * y
        Sa += x * q
        Sb += y * q

    scale = max(Sxx, Syy) or 1.0
    det = (Sxx * Syy - Sxy * Sxy) / (scale * scale)
    if abs(det) < 1e-6:
        return {"ok": False, "n": n,
                "why": "这些记录的输入/输出比例太一致，方程解不开（需要长短不一的调用）"}

    d = Sxx * Syy - Sxy * Sxy
    a = (Sa * Syy - Sb * Sxy) / d        # 每输入 token 的 quota
    b = (Sb * Sxx - Sa * Sxy) / d        # 每输出 token 的 quota
    if a < 0 or b < 0:
        return {"ok": False, "n": n, "why": "拟合结果是负价，样本噪声太大"}

    k = cny_per_quota
    return {
        "ok": True, "n": n,
        "in": a * k * 1e6,      # ¥ / 百万输入 token
        "out": b * k * 1e6,     # ¥ / 百万输出 token
        "avg_in": sum(p[0] for p in pts) / n,
        "avg_out": sum(p[1] for p in pts) / n,
    }


def effective_prices(target, bill):
    """
    从账单反推「实扣单价 + 每次最低消费」，用于跨站同工作量比价。

    思路：先按标价算出这批调用的应扣金额，用「实扣 / 应扣」得到整体折扣 k，
    再等比缩放到三个单价。这是唯一在样本不理想时还站得住的做法——
    直接回归（fit_unit_prices）在输出占比过低或缓存干扰时会解出负价。

    额外识别两件事，它们会让「几折」这个数字失效：
      floor  按次最低消费：最小扣费在多条记录里重复出现，说明小额请求被兜底了
      spread 同尺寸请求的单价离散度：>6 倍说明有分流/倍率差，均值不可复现
    """
    totals = (bill or {}).get("totals") or {}
    logs = (bill or {}).get("logs") or []
    tin = float(totals.get("in") or 0)
    tout = float(totals.get("out") or 0)
    tcache = min(float(totals.get("cache") or 0), tin)
    actual = float(totals.get("cost") or 0)
    if not (tin or tout):
        return {"ok": False, "why": "账单没有 token 明细"}
    if actual <= 0:
        return {"ok": False, "why": "账单没有扣费金额"}
    try:
        pin, pout = float(target["price_in"]), float(target["price_out"])
        pcache = float(target["price_cache"])
    except Exception:
        return {"ok": False, "why": "这个目标还没填标价"}
    if pin <= 0 or pout <= 0:
        return {"ok": False, "why": "标价为 0，无法折算"}

    miss = max(0.0, tin - tcache)
    expect = (miss * pin + tcache * pcache + tout * pout) / 1e6
    if expect <= 0:
        return {"ok": False, "why": "标价为 0，无法折算"}
    ratio = actual / expect

    k = (bill.get("account") or {}).get("cny_per_quota") or 1.0
    out = {"ok": True, "ratio": ratio, "expect": expect, "actual": actual,
           "in": pin * ratio, "out": pout * ratio, "cache": pcache * ratio,
           "floor": 0.0, "floor_n": 0, "spread": None, "stable": True, "notes": []}

    # 每条记录实际扣的钱（one-api 只有 quota，要先乘汇率）
    pairs = []
    for l in logs:
        c = l.get("cost")
        if c is None:
            q = l.get("quota") or 0
            c = q * k if q else 0
        if c and c > 0:
            pairs.append((l, float(c)))
    costs = [c for _, c in pairs]

    # 观测到的最小单次扣费：重复出现说明小额请求很可能被兜底到这个价
    if len(costs) >= 8:
        cmin = min(costs)
        near = [c for c in costs if c <= cmin * 1.02]
        if len(near) >= 3:
            out["floor"] = cmin
            out["floor_n"] = len(near)
            out["notes"].append(
                "观测到的最小单次扣费是 ¥%.5f，有 %d 次调用都是这个数——"
                "比它更小的请求很可能被兜底到这一价" % (cmin, len(near)))

    # 同尺寸请求的单价离散度（只看 2000 token 以上的，避开兜底的影响）
    units = []
    for l, c in pairs:
        # 命中缓存的记录单价天然低一个量级，混进来会误判成「分流」。
        # 只看没走缓存的整条调用。
        if (l.get("cache") or 0) > 0:
            continue
        tok = (l.get("in") or 0) + (l.get("out") or 0)
        if tok >= 2000:
            units.append(c / tok * 1e6)
    if len(units) >= 5:
        lo, hi = min(units), max(units)
        if lo > 0:
            out["spread"] = hi / lo
            if out["spread"] > 6:
                out["stable"] = False
                out["notes"].append(
                    "同样大小的请求，单价最高是最低的 %.0f 倍（%.2f ~ %.2f 元/M），"
                    "说明它按渠道/倍率分流，均值不可复现" % (out["spread"], lo, hi))
    return out
