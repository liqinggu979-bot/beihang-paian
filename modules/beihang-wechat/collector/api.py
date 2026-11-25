"""Authenticated extension mounted into the existing local WeRSS service.

No publishing, messaging, stealth scripts, paid services, or desktop windows.
"""
import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlparse

import requests
from fastapi import APIRouter, Depends, HTTPException
from playwright.async_api import async_playwright
from pydantic import BaseModel

from core.auth import get_current_user
from core.wx.model.weread_mp import MpsWereadMP
from .parsing import ArticleRejected, CST, canonical_article_url, list_date, parse_article

router = APIRouter(prefix="/api/v1/wx/paian", tags=["北航拍案"])
LOCK = asyncio.Lock()
TARGETS = Path("/app/data/paian-targets.json")
PROFILE = "/app/data/paian-public-search-browser"
PROGRESS = Path("/app/data/paian-search-status.json")


class CollectRequest(BaseModel):
    bookId: str
    since: datetime | None = None


class LatestPageRequired(ArticleRejected):
    def __init__(self, url):
        super().__init__("latest_original_page_required")
        self.url = url


def _write_status(value):
    temp = PROGRESS.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temp.chmod(0o600)
    temp.replace(PROGRESS)


def _latest(account):
    wx = MpsWereadMP()
    wx._load_weread_auth()
    cover = wx._get_mp_cover(account["bookId"])
    if cover.get("name") not in {account["name"], *account.get("previousNames", [])}:
        raise ArticleRejected("latest_publisher_mismatch")
    review_id = cover.get("reviewId", "")
    prefix = account["bookId"] + "_"
    if not review_id.startswith(prefix):
        raise ArticleRejected("latest_review_id_mismatch")
    token = review_id[len(prefix):].replace("~", "_")
    url = canonical_article_url("https://mp.weixin.qq.com/s/" + token)
    response = requests.get("https://weread.qq.com/web/mp/content",
        params={"reviewId": review_id}, headers=wx._request_headers(),
        proxies=wx._get_proxies(), timeout=(10, 30))
    response.raise_for_status()
    # An expired WeRead session need not block a publicly readable original.
    # Keep its public article link; the browser path still verifies publisher, date and body.
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("errCode") == -2012:
        raise LatestPageRequired(url)
    article = parse_article(response.text, url, account)
    article["discovery"] = "latest-article"
    return article


async def _latest_original(account, url):
    async with async_playwright() as p:
        browser = await p.webkit.launch(headless=True)
        try:
            page = await browser.new_page(locale="zh-CN")
            response = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            if not response or response.status != 200:
                raise ArticleRejected("article_http_error")
            if urlparse(page.url).hostname != "mp.weixin.qq.com":
                raise ArticleRejected("article_redirect_not_wechat")
            article = parse_article(await page.content(), page.url, account)
            article["discovery"] = "latest-original-page"
            return article
        finally:
            await browser.close()


def _issue(stage, error):
    # Provider exceptions may contain authenticated URLs; never return them.
    code = str(error) if isinstance(error, ArticleRejected) else str(getattr(error, "code", type(error).__name__))
    return {"stage": stage, "code": code[:100]}


async def _search(account, since):
    now = datetime.now(timezone.utc)
    year_floor = now.replace(year=now.year - 1) if not (now.month == 2 and now.day == 29) else now.replace(year=now.year - 1, day=28)
    # Search engines may index an older article after the last successful check.
    # Rediscover the rolling year and let the site's stable IDs handle duplicates.
    cutoff = year_floor
    items, issues, seen = [], [], set()
    stats = {"pages": 0, "results": 0, "matchingResults": 0, "state": "ok"}
    async with async_playwright() as p:
        context = await p.webkit.launch_persistent_context(PROFILE, headless=True, locale="zh-CN")
        context.set_default_timeout(8000)
        try:
            deadline = asyncio.get_running_loop().time() + 140
            page = await context.new_page()
            # Search indexing, rather than the publisher's restricted private list API.
            query = account.get("searchTerm", account["name"]) + " " + str(now.astimezone(CST).year)
            # The outgoing-link handler is installed at load; clicking earlier can open a blank redirect.
            navigation = await page.goto("https://weixin.sogou.com/weixin?" + urlencode({"type": 2, "query": query}), wait_until="load", timeout=30000)
            if not navigation or navigation.status != 200:
                raise ArticleRejected("search_http_error")
            for page_number in range(2):
                text = await page.locator("body").inner_text()
                if any(s in text for s in ["请输入验证码", "您的访问过于频繁", "异常访问", "完成验证"]):
                    raise ArticleRejected("search_verification_required")
                if "搜狗" not in await page.title():
                    raise ArticleRejected("unexpected_search_page")
                stats["pages"] += 1
                _write_status({"state":"running","account":account["name"],"headless":True,"stage":"public-search","pages":stats["pages"],"verifiedArticles":len(items)})
                rows = page.locator(".news-list li")
                count = await rows.count()
                if not count and not any(s in text for s in ["没有找到", "未找到", "没有相关"]):
                    raise ArticleRejected("search_results_missing")
                stats["results"] += count
                for index in range(count):
                    if asyncio.get_running_loop().time() >= deadline:
                        raise ArticleRejected("search_time_budget_reached")
                    row = rows.nth(index)
                    author = row.locator(".all-time-y2")
                    if not await author.count() or (await author.inner_text()).strip() not in {account["name"], *account.get("previousNames", [])}:
                        continue
                    stats["matchingResults"] += 1
                    date_node = row.locator(".s2")
                    date = list_date(await date_node.inner_text()) if await date_node.count() else None
                    if date and date + timedelta(days=1) < cutoff:
                        continue
                    title_link = row.locator("h3 a")
                    if not await title_link.count():
                        continue
                    href = await title_link.get_attribute("href")
                    if not href or href in seen:
                        continue
                    seen.add(href)
                    article_page = None
                    try:
                        # A normal click is required: Sogou's click handler signs its outgoing link.
                        async with page.expect_popup(timeout=10000) as popup:
                            await title_link.click()
                        article_page = await popup.value
                        await article_page.wait_for_url(re.compile(r"^https?://mp\.weixin\.qq\.com/"), wait_until="domcontentloaded", timeout=25000)
                        if urlparse(article_page.url).hostname != "mp.weixin.qq.com":
                            raise ArticleRejected("article_redirect_not_wechat")
                        markup = await article_page.content()
                        article = parse_article(markup, article_page.url, account, now)
                        if datetime.fromisoformat(article["publishedAt"]) >= cutoff:
                            article["discovery"] = "public-web-search"
                            items.append(article)
                        _write_status({"state":"running","account":account["name"],"headless":True,"stage":"article-verified","pages":stats["pages"],"verifiedArticles":len(items)})
                    except Exception as exc:
                        issues.append(_issue("search-article", exc))
                    finally:
                        if article_page:
                            await article_page.close()
                    await asyncio.sleep(2)
                if page_number == 1:
                    break
                next_link = page.get_by_text("下一页", exact=True)
                if not await next_link.count():
                    break
                async with page.expect_navigation(wait_until="load", timeout=30000) as navigation:
                    await next_link.click()
                response = await navigation.value
                if not response or response.status != 200:
                    raise ArticleRejected("search_http_error")
                await asyncio.sleep(2)
        except Exception as exc:
            stats["state"] = "partial" if items else "failed"
            issues.append(_issue("public-search", exc))
        finally:
            await context.close()
    return items, issues, stats


@router.post("/collect")
async def collect(req: CollectRequest, user=Depends(get_current_user)):
    targets = json.loads(TARGETS.read_text())
    account = next((a for a in targets if a["bookId"] == req.bookId), None)
    if not account:
        raise HTTPException(400, "Account is not in the configured target list")
    if req.since and req.since.tzinfo is None:
        raise HTTPException(400, "since must include a timezone")
    async with LOCK:
        started = datetime.now(timezone.utc).isoformat()
        _write_status({"state": "running", "account": account["name"], "startedAt": started, "headless": True})
        items, issues = [], []
        stats = {"state": "failed", "pages": 0, "results": 0, "matchingResults": 0}
        try:
            found, errors, stats = await _search(account, req.since)
            items.extend(found)
            issues.extend(errors)
        except Exception as exc:
            issues.append(_issue("public-search", exc))
        latest_state = "failed"
        try:
            try:
                latest = await asyncio.to_thread(_latest, account)
            except LatestPageRequired as exc:
                latest = await _latest_original(account, exc.url)
            now = datetime.now(timezone.utc)
            floor = now - timedelta(days=366)
            if datetime.fromisoformat(latest["publishedAt"]) >= floor:
                items.append(latest)
            latest_state = "ok"
        except Exception as exc:
            issues.append(_issue("latest-article", exc))
        unique = {item.get("identityKey") or item["url"]: item for item in items}
        result = {"account": account["name"], "bookId": account["bookId"],
            "coverage": "public-search-and-latest", "headless": True,
            "search": stats, "latest": latest_state, "issues": issues,
            "items": list(unique.values()), "checkedAt": datetime.now(timezone.utc).isoformat()}
        state = "ok" if stats["state"] == "ok" and not issues else "partial" if items else "failed"
        result["state"] = state
        evidence = Path("/app/data/paian-result-" + account["id"] + ".json")
        evidence.write_text(json.dumps(result, ensure_ascii=False))
        evidence.chmod(0o600)
        _write_status({k: v for k, v in result.items() if k != "items"} | {"items": len(unique), "startedAt": started})
        return result
