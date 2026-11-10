#!/usr/bin/env python3
"""Seed the local test PukiWiki (dev/pukiwiki-test, port 18090) with sample pages.

Never run this against a real wiki. Usage: python3 -I dev/seed-test-wiki.py [base_url]
"""
import re
import struct
import sys
import urllib.parse
import urllib.request
import zlib

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18090/'
if not re.match(r'^http://(127\.0\.0\.1|localhost)[:/]', BASE):
    sys.exit('refusing to seed a non-local wiki')
ENC = 'euc-jp'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def form(d):
    return urllib.parse.urlencode({k: v.encode(ENC) for k, v in d.items()})


def get(q):
    return urllib.request.urlopen(BASE + '?' + form(q)).read().decode(ENC, 'replace')


def post(d):
    req = urllib.request.Request(BASE, data=form({**d, 'encode_hint': 'ぷ'}).encode(),
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        return opener.open(req).status
    except urllib.error.HTTPError as e:
        return e.code


def write(page, src):
    h = get({'cmd': 'edit', 'page': page})
    digest = re.search(r'name="digest" value="([0-9a-f]+)"', h).group(1)
    st = post({'cmd': 'edit', 'page': page, 'digest': digest, 'msg': src, 'original': src, 'write': '1'})
    print(st, page)


def png(w=160, h=90):
    raw = b''.join(b'\x00' + b''.join(bytes([x * 255 // w, 120, y * 255 // h]) for x in range(w)) for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def upload(page, name, data, ctype):
    bd = '----seed'
    def part(n, v, fn=None, ct=None):
        head = f'--{bd}\r\nContent-Disposition: form-data; name="{n}"'.encode()
        if fn is not None:
            head += b'; filename="' + fn + b'"'
        head += b'\r\n' + (f'Content-Type: {ct}\r\n'.encode() if ct else b'') + b'\r\n'
        return head + v + b'\r\n'
    body = (part('encode_hint', 'ぷ'.encode(ENC)) + part('plugin', b'attach') + part('pcmd', b'post') +
            part('refer', page.encode(ENC)) + part('pass', b'testpass') +
            part('attach_file', data, name.encode(ENC), ctype) + f'--{bd}--\r\n'.encode())
    req = urllib.request.Request(BASE, data=body, headers={'Content-Type': f'multipart/form-data; boundary={bd}'})
    try:
        opener.open(req)
    except urllib.error.HTTPError:
        pass
    print('attach', page, name)


PAGES = {
    'TopPage': """* Wiki へようこそ
業務の手順・障害対応・日報をまとめています。

- [[Wiki運用ルール]]
- [[保守]]
- [[Web]]
- [[総務]]
""",
    'Wiki運用ルール': """* Wiki運用ルール
** ページ名の付け方
- スペース（最上位の階層）ごとにまとめる
- 日報は ''名前/YYYY-MM-DD'' とする
** 書いてはいけないもの
- パスワードや鍵などの認証情報（パスワード管理ツールに保存する）
""",
    '保守': """* 保守
保守業務のトップページです。
#ls2(保守/)
""",
    '保守/障害対応/テンプレート': """** 発生日時・影響範囲
- 発生：
- 影響：
** 対応
** 原因
** 再発防止
""",
    '保守/障害対応/2026/10-28 証明書の更新漏れ': """* 概要
証明書の自動更新が失敗し、期限切れの警告が表示された。

* 再発防止
- 更新の監視を追加する（[[保守/手順書/証明書の更新]]）
""",
    '保守/障害対応/2026/11-05 メール配送遅延': """#contents
* 概要
一部の宛先へのメール配送が遅延した。送信キューに滞留が発生し、再送処理で解消した。

* 経過
|時刻|事象|対応|h
|09:10|配送遅延の問い合わせ|送信キューを確認|
|09:25|特定の宛先ドメインで再送待ちを確認|相手先の受信制限を疑う|
|09:50|再送処理を実施|キューの滞留が解消|

* 原因
- 相手先の受信制限により、一時エラーで再送待ちになった
- 再送間隔の設定が長く、解消までに時間がかかった

** 参考
 postqueue -p | tail -n 1
 postqueue -f

* 再発防止
+ 再送間隔の設定を見直す（[[保守/手順書/メールサーバー設定]]）
+ キュー滞留の監視を追加する（[[保守/手順書/キュー監視]]）

&ref(構成図.png);

#comment
""",
    '保守/手順書/メールサーバー設定': """* メールサーバー設定
送信キューの確認方法と、再送間隔の設定について。
** キューの確認
 postqueue -p
** 再送間隔
''queue_run_delay'' を 10 分にする。
関連: [[保守/障害対応/2026/11-05 メール配送遅延]]
""",
    '保守/手順書/証明書の更新': """* 証明書の更新
+ 期限を確認する
+ 更新コマンドを実行する
+ Web サーバーを再読み込みする
""",
    '保守/定期作業/メールキュー点検': """* メールキュー点検
週に 1 回、送信キューの滞留を確認する。滞留があれば [[保守/障害対応/テンプレート]] で記録する。
関連: [[保守/手順書/メールサーバー設定]]
""",
    'Web/問い合わせ対応': """* 問い合わせ対応
- 受付は [[Web/問い合わせ対応フロー]] に従う
- 返信のひな形は [[Web/返信テンプレート]]
""",
    '総務/月次報告/2026-11': """* 2026年11月 月次報告
** 保守
- メール配送遅延 1 件（[[保守/障害対応/2026/11-05 メール配送遅延]]）
""",
    '試験/記法サンプル': """* 記法サンプル [#sample01]
本文の段落です。''太字''、'''斜体'''、%%取り消し%%、%%%下線%%%、&color(red){赤い文字};、&size(20){大きい文字};、注釈((注釈の本文))。~
改行のあとの行。

** リスト
- 項目 1
-- 項目 1-1
--- 項目 1-1-1
+ 番号 1
+ 番号 2

** 定義リスト
:用語|説明
:もう一つ|その説明

** 引用
>引用した文章
>>二段目の引用

** 文字揃え
CENTER:中央揃えの段落
RIGHT:右揃えの段落

** 表（セル結合・CSV）
|>|結合したセル|h
|A|B|
,CSV,形式,の表

** 整形済み
 $ echo hello
 hello

** 区切り
----
// このコメント行は表示されない
#hr
""",
    '試験/Markdown': """* Markdown のページ
PukiWiki 記法の段落。
#markdown()
# Markdown の見出し
* 箇条書き 1
* 箇条書き 2

| 列A | 列B |
|---|---|
| 1 | 2 |

関連: [[保守/手順書/メールサーバー設定]] と [外部](https://example.com/)

```python
def hello():
    return "world"
```
#endmarkdown()
** Markdown の後ろの見出し
この段落は旧 UI では隠れてしまう。
""",
    '試験/Markdown旧形式': """#markdown{{
## 古い形式の見出し
- 旧 UI では表示されない
}}
""",
}
for d in range(2, 7):
    PAGES[f'山田/2026-11-0{d}'] = f"* 作業内容\n- 保守作業\n- 見積の作成（{d} 件目）\n\n* 明日の予定\n- 打ち合わせ\n"
PAGES['山田/2026-11-09'] = """[[山田]]

#markdown()
# 2026-11-09 作業記録

## 保守
- メールサーバーの **キュー監視** を追加（[[保守/定期作業/メールキュー点検]]）
- 証明書の期限を確認：残り `42` 日

| 作業 | 時間 |
| --- | --- |
| 障害の振り返り | 1.5 h |
| 手順書の更新 | 1.0 h |

```bash
mailq | tail -1
```
#endmarkdown()
"""
PAGES['山田'] = """* 日報
最新の日報を新しい順に表示します。
#calendar_viewer(山田,3)
"""
PAGES['MenuBar'] = """#calendar2(off)

** メニュー
- [[TopPage]]
- [[Wiki運用ルール]]
** 保守
- [[障害対応>保守/障害対応/テンプレート]]
- [[手順書>保守/手順書/メールサーバー設定]]
** 日報
- [[山田]]
"""

if __name__ == '__main__':
    for p, s in PAGES.items():
        write(p, s)
    upload('保守/障害対応/2026/11-05 メール配送遅延', '構成図.png', png(), 'image/png')
    upload('保守/障害対応/2026/11-05 メール配送遅延', 'mailq-1105.txt', b'-- 2 Kbytes in 3 Requests.\n', 'text/plain')
    # a second revision so history/diff have something to show
    src = PAGES['保守/障害対応/2026/11-05 メール配送遅延'].replace('解消した。', '解消した。担当者が確認済み。')
    write('保守/障害対応/2026/11-05 メール配送遅延', src)
