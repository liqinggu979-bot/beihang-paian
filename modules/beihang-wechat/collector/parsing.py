"""Extract public article facts without treating observation time as publication time."""
import html
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from bs4 import BeautifulSoup

CST = timezone(timedelta(hours=8))


class ArticleRejected(ValueError):
    pass


def canonical_article_url(value):
    u = urlparse(value)
    if u.scheme not in ("http", "https") or u.hostname != "mp.weixin.qq.com" or not (u.path == "/s" or u.path.startswith("/s/")):
        raise ArticleRejected("not_an_original_wechat_article")
    query = parse_qs(u.query)
    kept = {k: query[k][0] for k in ("__biz", "mid", "idx", "sn") if k in query}
    if u.path == "/s" and not all(k in kept for k in ("__biz", "mid", "idx", "sn")):
        # Public search opens a signed WeChat URL. Its signature is necessary for the link to work;
        # stable deduplication comes from the public article ID, not this expiring query string.
        if not all(query.get(k) for k in ("src", "timestamp", "ver", "signature")):
            raise ArticleRejected("original_article_identity_missing")
        kept = {k: query[k][0] for k in ("src", "timestamp", "ver", "signature", "new") if k in query}
    return urlunparse(("https", "mp.weixin.qq.com", u.path.replace("~", "_"), "", urlencode(kept), ""))


def _js_text(value):
    def replace(m):
        escaped = m.group(0)[1:]
        if escaped.startswith(("x", "u")):
            return chr(int(escaped[1:], 16))
        return {"n": "\n", "r": "\r", "t": "\t"}.get(escaped, escaped)
    return re.sub(r"\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)", replace, value)


def parse_article(markup, url, account, now=None):
    now = now or datetime.now(timezone.utc)
    soup = BeautifulSoup(markup, "html.parser")
    # The public publisher ID must match the account resolved during setup.
    biz = parse_qs(urlparse(url).query).get("__biz", [None])[0]
    found = re.search(r"\b(?:var\s+)?biz\s*=\s*['\"]([^'\"]+)['\"]", markup)
    if found:
        page_biz = html.unescape(found.group(1))
        if biz and biz != page_biz:
            raise ArticleRejected("conflicting_publisher_id")
        biz = page_biz
    if biz != account["biz"]:
        raise ArticleRejected("publisher_id_not_verified")
    name = soup.select_one("#js_name")
    if name and name.get_text(" ", strip=True) not in {account["name"], *account.get("previousNames", [])}:
        raise ArticleRejected("publisher_name_mismatch")
    title = soup.select_one("#activity-name")
    if title:
        title = title.get_text(" ", strip=True)
    else:
        meta = soup.select_one('meta[property="og:title"]')
        title = meta.get("content", "").strip() if meta else ""
    if not title:
        raise ArticleRejected("missing_article_title")
    ct = re.search(r"\b(?:var\s+)?ct\s*=\s*['\"](\d{10})['\"]", markup)
    if not ct:
        raise ArticleRejected("original_publication_time_missing")
    published = datetime.fromtimestamp(int(ct.group(1)), timezone.utc)
    if published > now + timedelta(hours=1):
        raise ArticleRejected("future_publication_time")
    body = soup.select_one("#js_content") or soup.select_one(".rich_media_content")
    if body is not None:
        for element in body.select("script,style,noscript,iframe,form"):
            element.decompose()
        text = body.get_text("\n", strip=True)
    else:
        fallback = re.search(r"content_noencode\s*:\s*'((?:\\.|[^'\\])*)'", markup)
        text = html.unescape(_js_text(fallback.group(1))).strip() if fallback else ""
    if len(text) < 20:
        raise ArticleRejected("article_body_insufficient")
    mid = re.search(r"\b(?:var\s+)?(?:mid|appmsgid)\s*=\s*['\"](\d+)['\"]", markup)
    idx = re.search(r"\b(?:var\s+)?idx\s*=\s*['\"](\d+)['\"]", markup)
    original = soup.select_one('meta[property="og:url"]')
    original_url = None
    for candidate in [original.get("content") if original else None, url]:
        if not candidate:
            continue
        try:
            original_url = canonical_article_url(candidate)
            break
        except ArticleRejected:
            continue
    if not original_url:
        raise ArticleRejected("original_link_unavailable")
    if urlparse(original_url).path == "/s" and not (mid and idx):
        raise ArticleRejected("stable_article_identity_missing")
    result = {"title": title, "url": original_url, "publishedAt": published.isoformat(),
            "bodyText": text, "author": account["name"], "publisherBiz": biz,
            "publicationTimeEvidence": "original-page-ct"}
    if mid and idx:
        result.update({"wechatMid":mid.group(1),"wechatIdx":idx.group(1),
            "identityKey":f"wechat:{biz}:{mid.group(1)}:{idx.group(1)}"})
    if urlparse(url).path.startswith("/s/"):
        result["aliases"] = [canonical_article_url(url)]
    return result


def list_date(value):
    found = re.search(r"(20\d{2})-(\d{1,2})-(\d{1,2})", value or "")
    if not found:
        return None
    try:
        return datetime(*(int(x) for x in found.groups()), tzinfo=CST)
    except ValueError:
        return None
