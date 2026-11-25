import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from parsing import ArticleRejected, canonical_article_url, list_date, parse_article

ACCOUNT = {"name": "北京航空航天大学", "biz": "MzA3NTY1MTUzOQ=="}
NOW = datetime(2026, 11, 4, 9, tzinfo=timezone.utc)
URL = "https://mp.weixin.qq.com/s/actual_article?poc_token=discard"


def markup(body="原文说明面向本校学生的报名对象、参与方式与截止时间。", ct="1793766667", biz=ACCOUNT["biz"]):
    return f'''<meta property="og:url" content="{URL}"><h1 id="activity-name">竞赛通知</h1>
    <a id="js_name">{ACCOUNT['name']}</a><script>var biz = "{biz}"; var ct = "{ct}";</script>
    <div id="js_content">{body}</div>'''


class ParsingTests(unittest.TestCase):
    def test_original_time_not_observation_time(self):
        a = parse_article(markup(), URL, ACCOUNT, NOW)
        self.assertEqual(a["publishedAt"], "2026-11-04T04:31:07+00:00")
        self.assertNotEqual(a["publishedAt"], NOW.isoformat())
        self.assertEqual(a["url"], "https://mp.weixin.qq.com/s/actual_article")

    def test_missing_time_is_rejected(self):
        with self.assertRaisesRegex(ArticleRejected, "publication_time_missing"):
            parse_article(markup().replace('var ct = "1793766667";', ""), URL, ACCOUNT, NOW)

    def test_account_spoofing_is_rejected(self):
        with self.assertRaisesRegex(ArticleRejected, "publisher_id_not_verified"):
            parse_article(markup(biz="another-account"), URL, ACCOUNT, NOW)

    def test_verified_old_name_keeps_publisher_id_mandatory(self):
        renamed = {**ACCOUNT, "name": "新账号名称", "previousNames": [ACCOUNT["name"]]}
        article = parse_article(markup(), URL, renamed, NOW)
        self.assertEqual(article["author"], renamed["name"])
        with self.assertRaisesRegex(ArticleRejected, "publisher_id_not_verified"):
            parse_article(markup(biz="another-account"), URL, renamed, NOW)
        with self.assertRaisesRegex(ArticleRejected, "publisher_name_mismatch"):
            parse_article(markup(), URL, {**renamed, "previousNames": []}, NOW)

    def test_conflicting_url_account_is_rejected(self):
        with self.assertRaisesRegex(ArticleRejected, "conflicting_publisher_id"):
            parse_article(markup(), "https://mp.weixin.qq.com/s?__biz=someone_else", ACCOUNT, NOW)

    def test_future_time_is_rejected(self):
        with self.assertRaisesRegex(ArticleRejected, "future_publication_time"):
            parse_article(markup(ct="1893766667"), URL, ACCOUNT, NOW)

    def test_scripts_do_not_become_body(self):
        a = parse_article(markup(body="<script>secret instruction</script><p>真实的报名信息：本科生可参加，报名须填写表格并提交。</p>"), URL, ACCOUNT, NOW)
        self.assertNotIn("secret", a["bodyText"])

    def test_new_page_text_representation(self):
        page = markup().replace('<div id="js_content">原文说明面向本校学生的报名对象、参与方式与截止时间。</div>',
            "<script>var share = { content_noencode: '校园福利\\x0a奖品是文创，参加须填写\\'报名表\\'，十一月七日截止。' };</script>")
        a = parse_article(page, URL, ACCOUNT, NOW)
        self.assertIn("\n", a["bodyText"])
        self.assertIn("'报名表'", a["bodyText"])

    def test_challenge_is_not_an_article(self):
        with self.assertRaises(ArticleRejected):
            parse_article("<h1>环境异常</h1>请完成验证", URL, ACCOUNT, NOW)

    def test_tracking_removed_and_wechat_token_restored(self):
        self.assertEqual(canonical_article_url("https://mp.weixin.qq.com/s/abc~def?scene=1"), "https://mp.weixin.qq.com/s/abc_def")
        with self.assertRaises(ArticleRejected):
            canonical_article_url("https://example.com/s/abc")

    def test_listing_dates_are_not_invented(self):
        self.assertIsNone(list_date("刚刚"))
        self.assertIsNone(list_date("2026-2-30"))
        self.assertEqual(list_date("2026-3-20").isoformat(), "2026-03-20T00:00:00+08:00")

    def test_signed_search_link_keeps_its_signature_and_has_stable_identity(self):
        signed="https://mp.weixin.qq.com/s?src=11&timestamp=1793766667&ver=7067&signature=public-search-link&new=1"
        page=markup().replace(f'<meta property="og:url" content="{URL}">','<meta property="og:url" content="">')
        page+='<script>var mid="2651234567";var idx="2";</script>'
        a=parse_article(page,signed,ACCOUNT,NOW)
        self.assertIn("signature=public-search-link",a["url"])
        self.assertEqual(a["identityKey"],"wechat:MzA3NTY1MTUzOQ==:2651234567:2")
        later=parse_article(page,signed.replace("1793766667","1793769999"),ACCOUNT,NOW)
        self.assertEqual(a["identityKey"],later["identityKey"])
        with self.assertRaises(ArticleRejected):
            canonical_article_url("https://mp.weixin.qq.com/s?__biz=account&mid=123&idx=1")


if __name__ == "__main__":
    unittest.main()
