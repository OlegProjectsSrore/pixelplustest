"""Очистка сырых страниц из raw/ в Markdown для базы знаний kb/.

Запуск: python -I knowledge-base/scripts/extract.py
Берёт страницы из urls.json (их собирает crawl.py), убирает шапку, подвал, меню, формы и призывы
оставить заявку. Блоки, которые повторяются на нескольких страницах, выносятся в общий файл раздела,
чтобы в базе каждый текст был один раз. Итог: kb/**.md и index.json.
"""
import gzip
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from bs4 import BeautifulSoup
from markdownify import markdownify

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "kb"
SITE = "https://pixelplus.ru"
REPEATS = 3  # блок, встреченный на стольких страницах и более, считается общим
SIMILAR = 0.75  # доля общих четвёрок слов, начиная с которой страницы считаются вариантами одной
MIN_TEXT = 200  # страница с меньшим текстом (только картинки и кнопка заказа) в базу не берётся

CHROME = [
    "script", "style", "noscript", "svg", "img", "picture", "video", "iframe", "button", "input", "select",
    "textarea", "form", "header.page-header", "footer.page-footer", ".aside__menu", ".call-to-action",
    ".stories-video", ".page__breadcrumb", "[class*=breadcrumb]", ".form", "[class*=modal]", "[class*=popup]",
    "[class*=cookie]", ".case-calc", ".case-conversion--calc", ".seo-form", ".wide-block--footer",
    ".wide-block--meeting", ".wide-block--meeting-analytics", ".wide-block--woman", "#loadCounters",
    "nav", ".seo-landing-menu", ".portfolio-page-nav", ".projects-nav", ".soc-icons",
]
# Строки-кнопки и призывы оставить заявку, которые остаются после удаления форм.
NOISE = {"Подробнее об услуге", "Подробнее о кейсе", "Поделиться", "Оставить заявку", "Текущий проект",
         "## Хотите такие результаты?", "Хотите такие результаты?", "Подробнее", "Посмотреть портфолио",
         "Перейти к работе", "Полный текст отзыва", "Скрыть", "Все контакты", "У вас есть вопрос?",
         "Отвечаем на часто задаваемые вопросы о сотрудничестве с нами.", "Показать", "Предыдущая работа", "Следующая работа", "Поделиться:", "Заказать"}
NOISE_START = ("Заполните форму", "Если вы не нашли ответ на свой вопрос", "любым удобным способом")
# Телефоны и почта отдела продаж, ответы «Ответов: N» под вопросами FAQ, пустые строки таблиц.
NOISE_LINE = re.compile(r"^(?:[+\d][\d ()-]{9,}|manager@pixelplus\.ru|Ответов: \d+|\|[\s|]*)$")
TABLE_RULE = re.compile(r"^\|(?:\s*:?-+:?\s*\|)+$")
# Блок «Смотрите другие наши кейсы» — ссылки на соседние кейсы, а не содержание.
OTHER_CASES = ".other-projects"
BLOCK = re.compile(r"(?:^|\s)(?:wide-block|case-conversion)(?:\s|$)")


def page_title(soup, kind):
    """Заголовок страницы. В кейсах h1 часто стоит на разделе («Задачи проекта»), поэтому там берём <title>."""
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    title = re.sub(r"\s*[—|-]\s*Пиксель Плюс\s*$", "", title)
    if kind != "case" and soup.h1:
        return soup.h1.get_text(" ", strip=True)
    return title or (soup.h1.get_text(" ", strip=True) if soup.h1 else "")


def content_roots(soup):
    """Части страницы с содержанием: шапка с заголовком и основной блок; для старых шаблонов — всё тело."""
    for selector in CHROME:
        for element in soup.select(selector):
            element.decompose()
    for element in soup.select(OTHER_CASES):
        (element.find_parent(class_="wide-block") or element).decompose()
    main = soup.select_one("main.page__content")
    if main:
        heading = soup.select_one(".page__heading")
        return [r for r in (heading, main) if r]
    return [soup.body] if soup.body else []


def blocks(roots):
    """Самые внутренние смысловые блоки шаблона (wide-block и подобные)."""
    found = []
    for root in roots:
        for element in root.find_all(class_=BLOCK):
            if not element.find(class_=BLOCK):
                found.append(element)
    return found


def text_key(element):
    text = re.sub(r"\s+", " ", element.get_text(" ", strip=True))
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16], len(text)


def to_markdown(html):
    md = markdownify(html, heading_style="ATX", bullets="-", strip=["a", "span"], escape_underscores=False, escape_misc=False, escape_asterisks=False)
    lines = [re.sub(r"[ \t ]+", " ", line).rstrip() for line in md.splitlines()]
    lines = [line for line in lines if line.strip() not in ("-", "*", "|", "#", "##", "###", "####")
             and line.strip() not in NOISE and not line.strip().startswith(NOISE_START) and not NOISE_LINE.match(line.strip())]
    # Разделитель таблицы без строки заголовка над ним (заголовок был пустым и удалён).
    lines = [line for i, line in enumerate(lines) if not (TABLE_RULE.match(line.strip()) and (i == 0 or not lines[i - 1].lstrip().startswith("|")))]
    md = "\n".join(lines)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def single_h1(body, title, h1):
    """Один заголовок первого уровня в начале файла: исходный h1 убираем, остальные h1 понижаем."""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if h1 and re.sub(r"^-\s*", "", line.strip()) == f"# {h1}":
            del lines[i]
            break
    lines = ["#" + line if line.startswith("# ") else line for line in lines]
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return f"# {title}\n\n{body}" if title else body


def shingles(text, size=4):
    words = re.findall(r"\w+", text.lower())
    return {" ".join(words[i:i + size]) for i in range(len(words) - size + 1)}


def group_variants(docs):
    """Сводит почти одинаковые страницы одного каталога (города, тематики) к одной.

    Сравниваются страницы с общим родительским каталогом и сама родительская страница. Первая страница
    группы (родитель, если он похож, иначе первая по алфавиту) остаётся, остальные считаются её вариантами.
    """
    groups = defaultdict(list)
    for doc in docs:
        path = doc["page"]["path"].rstrip("/")
        groups[path.rsplit("/", 1)[0] + "/"].append(doc)
    by_path = {doc["page"]["path"]: doc for doc in docs}
    of, lists, paths = {}, defaultdict(list), defaultdict(list)
    for parent, members in groups.items():
        candidates = ([by_path[parent]] if parent in by_path else []) + sorted(members, key=lambda d: d["page"]["path"])
        if len(candidates) < 3:
            continue
        reps = []
        for doc in candidates:
            if doc["page"]["path"] in of:
                continue
            words = shingles(doc["body"])
            match = next((rep for rep, rep_words in reps if words and len(words & rep_words) / len(words | rep_words) >= SIMILAR), None)
            if match:
                of[doc["page"]["path"]] = match["page"]["path"]
                lists[match["page"]["path"]].append(doc)
                paths[match["page"]["path"]].append(doc["page"]["path"])
            elif doc["page"]["path"] not in lists:
                reps.append((doc, words))
    return {"of": of, "list": lists, "paths": paths}


def clean_kb():
    """Удаляет прежнее содержимое kb/. Каталог, открытый другой программой, остаётся пустым, а не роняет сборку."""
    if not KB.exists():
        return
    for path in sorted(KB.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        try:
            path.rmdir() if path.is_dir() else path.unlink()
        except OSError:
            pass


def location(page):
    """Папка и имя файла в kb/, раздел и тип материала."""
    parts = [p for p in page["path"].strip("/").split("/") if p]
    if parts and parts[-1].endswith(".html"):
        parts[-1] = parts[-1][:-5]
    parts = [re.sub(r"[^\w.-]+", "-", p).strip("-") for p in parts]
    if page["kind"] == "service":
        section = parts[0]
        rest = parts[1:] or ["index"]
        return KB / "services" / section / ("/".join(rest) + ".md"), section
    if page["kind"] == "case":
        # Кейсы лежат и в /portfolio/<раздел>/, и внутри разделов услуг (/podderzhka-sajtov/cases/).
        section = parts[1] if parts[0] == "portfolio" else parts[0]
        return KB / "cases" / section / (parts[-1] + ".md"), section
    rest = parts[1:] or ["index"]
    return KB / "company" / ("/".join(rest) + ".md"), "studio"


def front_matter(fields):
    return "---\n" + "".join(f"{k}: {json.dumps(v, ensure_ascii=False)}\n" for k, v in fields.items() if v not in (None, "")) + "---\n\n"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    state = json.loads((ROOT / "urls.json").read_text(encoding="utf-8"))
    pages = [p for p in state["pages"] if p.get("status") == 200 and p.get("file") and p["kind"] in ("service", "case", "company")]
    for page in pages:
        if page["kind"] == "service" and re.search(r"/cases/.+", page["path"]):
            page["kind"] = "case"

    parsed = []
    seen_on = defaultdict(set)  # ключ блока -> страницы, где он встречается
    for page in pages:
        soup = BeautifulSoup(gzip.decompress((ROOT / page["file"]).read_bytes()).decode("utf-8", "replace"), "lxml")
        description = soup.find("meta", attrs={"name": "description"})
        title = page_title(soup, page["kind"])
        h1 = soup.h1.get_text(" ", strip=True) if soup.h1 else ""
        roots = content_roots(soup)
        for element in blocks(roots):
            key, length = text_key(element)
            if length:
                seen_on[key].add(page["path"])
        # Храним только очищенные части страницы: целые разобранные страницы не поместятся в память.
        parsed.append((page, title, h1, description.get("content", "").strip() if description else "", [str(r) for r in roots]))
        soup.decompose()

    clean_kb()
    shared = defaultdict(dict)  # раздел -> ключ блока -> (markdown, страницы)
    index, docs, empty = [], [], []
    for page, title, h1, description, root_html in parsed:
        target, section = location(page)
        roots = [BeautifulSoup(html, "lxml").body for html in root_html]
        for element in blocks(roots):
            key, length = text_key(element)
            places = seen_on[key]
            if len(places) >= REPEATS and length > 40:
                sections = {location(next(p for p in pages if p["path"] == path))[1] for path in places} if len(places) < 50 else {"*"}
                owner = section if sections == {section} else "*"
                if key not in shared[owner]:
                    shared[owner][key] = (to_markdown(str(element)), sorted(places))
                element.decompose()
        body = "\n\n".join(to_markdown(str(root)) for root in roots)
        if len(single_h1(body, "", h1)) < MIN_TEXT:
            # Страница целиком из общих блоков (шаблон, у которого меняется только заголовок): оставляем её
            # полностью, а одинаковые такие страницы потом сведёт group_variants.
            body = "\n\n".join(to_markdown(html) for html in root_html)
        if len(single_h1(body, "", h1)) < MIN_TEXT:
            empty.append(SITE + page["path"])
            continue
        fields = {"url": SITE + page["path"], "title": title, "kind": page["kind"], "section": section,
                  "description": description, "crawled_at": page.get("fetched_at")}
        docs.append({"page": page, "target": target, "fields": fields, "body": single_h1(body, title, h1)})

    variants = group_variants(docs)
    for doc in docs:
        if doc["page"]["path"] in variants["of"]:
            continue
        body, fields = doc["body"], doc["fields"]
        same = variants["list"].get(doc["page"]["path"], [])
        if same:
            listed = "\n".join(f"- {d['fields']['title']} — {d['fields']['url']}" for d in same)
            body += (f"\n\n## Варианты этой страницы\n\nНа сайте есть ещё {len(same)} почти таких же страниц "
                     f"(отличаются городом, тематикой или площадкой); в базу взята одна:\n\n{listed}")
            fields = {**fields, "variants": len(same)}
        doc["target"].parent.mkdir(parents=True, exist_ok=True)
        doc["target"].write_text(front_matter(fields) + body + "\n", encoding="utf-8", newline="\n")
        index.append({**fields, "file": doc["target"].relative_to(ROOT).as_posix(), "chars": len(body)})

    for owner, items in shared.items():
        target = KB / "company" / "obshchie-bloki.md" if owner == "*" else KB / "services" / owner / "_obshchie-bloki.md"
        if owner != "*" and not target.parent.exists():
            target = KB / ("cases" if owner != "studio" else "company") / owner / "_obshchie-bloki.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        title = "Общие блоки сайта" if owner == "*" else f"Общие блоки раздела {owner}"
        parts = [f"# {title}\n\nБлоки, которые повторяются на нескольких страницах. Здесь каждый приведён один раз."]
        for markdown, places in items.values():
            shown = ", ".join(SITE + p for p in places[:5]) + (f" и ещё {len(places) - 5}" if len(places) > 5 else "")
            parts.append(f"---\n\nВстречается на {len(places)} стр.: {shown}\n\n{markdown}")
        body = "\n\n".join(parts)
        target.write_text(front_matter({"title": title, "kind": "shared", "section": owner}) + body + "\n", encoding="utf-8", newline="\n")
        index.append({"title": title, "kind": "shared", "section": owner, "file": target.relative_to(ROOT).as_posix(), "chars": len(body)})

    (ROOT / "index.json").write_text(json.dumps(sorted(index, key=lambda r: r["file"]), ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    total = sum(r["chars"] for r in index)
    by_kind = defaultdict(int)
    for r in index:
        by_kind[r["kind"]] += 1
    (ROOT / "excluded.json").write_text(json.dumps({
        "empty": sorted(empty),
        "variants": {SITE + rep: [SITE + p for p in paths] for rep, paths in sorted(variants["paths"].items())},
    }, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    print(f"Файлов: {len(index)} {dict(by_kind)}; знаков: {total:,}; общих блоков: {sum(len(v) for v in shared.values())}; "
          f"без текста: {len(empty)}; свёрнуто вариантов: {len(variants['of'])}")


if __name__ == "__main__":
    main()
