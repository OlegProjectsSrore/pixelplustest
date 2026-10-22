"""Обход pixelplus.ru: собирает страницы услуг, кейсов и раздела «о компании» в raw/.

Запуск: python -I knowledge-base/scripts/crawl.py [--limit N]
Повторный запуск продолжает с места остановки: уже скачанные страницы берутся из raw/.
Итог: raw/<путь>.html.gz (сырой HTML) и urls.json (что найдено, что взято, что пропущено и почему).
"""
import argparse
import gzip
import json
import re
import sys
import time
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
URLS = ROOT / "urls.json"
HOST = "pixelplus.ru"
START = "https://pixelplus.ru/"
DELAY = 1.0
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

# Разделы услуг (первый сегмент адреса).
SERVICES = {
    "prodvizhenie-sajtov", "geo", "vnedrenie-ii", "podderzhka-sajtov", "context", "smm",
    "razrabotka-sajtov", "sozdanie-sajtov", "marketplace", "crm", "1c", "uzabiliti",
    "mediynaya-reklama", "brand", "mobile-app", "mobile", "performance", "tarify", "skidki",
    "internet-marketing", "orm", "aso", "express", "ai-seo",
}
# Статьи (/studio/stat/) и публикации в СМИ в базу не входят, как и новости, команда и вакансии.
STUDIO_EXCLUDED = ("/studio/news/", "/studio/team/", "/studio/vacancy/", "/studio/smi/", "/studio/stat/", "/studio/publication/")
# Общий список кейсов услуги с постраничной разбивкой. Списки по отраслям и «избранное» его повторяют,
# поэтому по ним не ходим.
CASE_LISTING = re.compile(r"^/portfolio/(?:[^/]+/(?:page-\d+/)?)?$")
# Кейс: /portfolio/<раздел>/<имя>.html или /portfolio/sozdanie-saytov/<группа>/<имя>/ (так у создания сайтов).
# Адреса той же формы в других разделах — списки с двумя фильтрами (/portfolio/prodvizhenie-saytov/mebel/internet-magazin/).
CASE_PAGE = re.compile(r"^/portfolio/(?:[^/]+/[^/]+\.html|sozdanie-saytov/[^/]+/(?!page-\d+/)[^/]+/)$")


def kind_of(path):
    """Тип страницы или None, если она вне базы."""
    first = path.strip("/").split("/")[0]
    if first in SERVICES:
        return "service"
    if path.startswith("/studio/"):
        return None if path.startswith(STUDIO_EXCLUDED) else "company"
    if path.startswith("/portfolio/"):
        if CASE_PAGE.match(path):
            return "case"
        if CASE_LISTING.match(path) and not path.startswith("/portfolio/favorites/"):
            return "case-listing"
    return None


class Robots:
    """robots.txt с подстановками * и $ (стандартный robotparser их не понимает)."""

    def __init__(self, text):
        self.rules = []
        active = False
        for line in text.splitlines():
            line = line.split("#")[0].strip()
            if ":" not in line:
                continue
            key, value = (s.strip() for s in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                active = value == "*"
            elif active and key in ("allow", "disallow") and value:
                pattern = re.escape(value).replace(r"\*", ".*")
                if pattern.endswith(r"\$"):
                    pattern = pattern[:-2] + "$"
                self.rules.append((len(value), key == "allow", re.compile(pattern)))

    def allowed(self, path):
        matches = [(length, allow) for length, allow, rx in self.rules if rx.match(path)]
        return max(matches)[1] if matches else True


def normalize(href, base):
    """Канонический путь внутри сайта или None для внешних и нестраничных ссылок."""
    if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
        return None
    parts = urlsplit(urljoin(base, href.strip()))
    if parts.scheme not in ("http", "https") or parts.hostname not in (HOST, "www." + HOST):
        return None
    path = re.sub(r"/{2,}", "/", unquote(parts.path or "/"))
    if re.search(r"\.(?:jpe?g|png|gif|svg|webp|ico|pdf|docx?|xlsx?|zip|rar|mp4|webm|css|js|json|xml|txt|woff2?)$", path, re.I):
        return None
    if not path.endswith("/") and not path.endswith(".html") and not path.endswith(".php"):
        path += "/"
    return path


def raw_file(path):
    name = path.strip("/") or "index"
    if path.endswith("/"):
        name += "/index"
    elif name.endswith(".html"):
        name = name[:-5]
    return RAW / (name + ".html.gz")


def save(state):
    state["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    tmp = URLS.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    tmp.replace(URLS)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="остановиться после N скачиваний (для пробы)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    session = requests.Session()
    session.headers["User-Agent"] = UA
    robots = Robots(session.get(urljoin(START, "/robots.txt"), timeout=30).text)

    pages = {}  # путь -> запись о странице
    if URLS.exists():
        # Страницы, которые после изменения правил больше не входят в базу, отбрасываются.
        pages = {p["path"]: p for p in json.loads(URLS.read_text(encoding="utf-8"))["pages"] if kind_of(p["path"])}
    skipped = Counter()  # путь вне базы -> сколько раз встречен
    reasons = {}
    queue = deque(["/"])
    seen = {"/"}
    downloads = 0

    def enqueue(path, source):
        if path in seen:
            return
        seen.add(path)
        kind = kind_of(path)
        if kind is None:
            skipped[path] += 1
            reasons.setdefault(path, "вне базы")
            return
        if not robots.allowed(path):
            skipped[path] += 1
            reasons[path] = "robots.txt"
            return
        pages.setdefault(path, {"path": path, "kind": kind, "found_on": source})
        queue.append(path)

    while queue:
        path = queue.popleft()
        record = pages.get(path, {"path": path, "kind": "start"})
        target = raw_file(path)
        if target.exists():
            html = gzip.decompress(target.read_bytes()).decode("utf-8", "replace")
        else:
            time.sleep(DELAY)
            url = "https://" + HOST + quote(path)
            try:
                response = session.get(url, timeout=60)
            except requests.RequestException as error:
                record.update(status="error", error=str(error))
                print(f"ОШИБКА {path}: {error}")
                continue
            downloads += 1
            final = normalize(response.url, url)
            record.update(status=response.status_code, fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            if final != path:
                record["redirect"] = final
            if response.status_code != 200 or "text/html" not in response.headers.get("Content-Type", ""):
                print(f"{response.status_code} {path}")
                continue
            if final != path and final is not None:
                # Перенаправление: страницу сохраняем под конечным адресом, если она ещё не взята.
                if final in pages and pages[final].get("status") == 200:
                    record["duplicate_of"] = final
                    continue
                enqueue(final, path)
                continue
            html = response.text
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(gzip.compress(html.encode("utf-8")))
            if downloads % 25 == 0:
                save({"pages": list(pages.values()), "skipped": []})
            print(f"[{downloads}] {record.get('kind')} {path} (в очереди {len(queue)})")
        record.setdefault("status", 200)
        record["file"] = target.relative_to(ROOT).as_posix()
        if path != "/":
            pages[path] = record
        soup = BeautifulSoup(html, "lxml")
        for link in soup.find_all("a", href=True):
            found = normalize(link["href"], "https://" + HOST + path)
            if found:
                enqueue(found, path)
        if args.limit and downloads >= args.limit:
            print("Достигнут --limit, остановка.")
            break

    state = {
        "pages": sorted(pages.values(), key=lambda p: p["path"]),
        "skipped": [{"path": p, "reason": reasons[p], "seen": n} for p, n in sorted(skipped.items())],
    }
    save(state)
    kinds = Counter(p["kind"] for p in state["pages"] if p.get("status") == 200)
    print(f"Готово: скачано за запуск {downloads}; в базе {dict(kinds)}; пропущено адресов {len(skipped)}.")


if __name__ == "__main__":
    main()
