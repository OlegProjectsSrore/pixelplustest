"""Текст презентаций в PDF как Markdown: раздел на каждый слайд, карточки по колонкам слайда.

Используется extract.py. Проверка вручную: python -I knowledge-base/scripts/pdf_markdown.py <файл.pdf>
"""
import re
import sys

import fitz

COPYRIGHT = re.compile(r"^©|^Плюс»$")
LETTERS = re.compile(r"[^\W\d_]{3}")


def block_text(block):
    """Строки блока: соседние по высоте (ячейки одной строки таблицы) через « | », переносы слов склеиваются."""
    text, last_y = "", None
    for line in block["lines"]:
        part = "".join(span["text"] for span in line["spans"]).strip()
        if not part:
            continue
        y = round(line["bbox"][1])
        if not text:
            text = part
        elif last_y is not None and abs(y - last_y) <= 2:
            text += " | " + part
        elif re.search(r"[а-яa-z]-$", text) and re.match(r"[а-яa-z]", part):
            text = text[:-1] + part
        else:
            text += " " + part
        last_y = y
    return re.sub(r"\s+", " ", text).strip()


def join(text, part):
    """Склейка соседних блоков: перенос слова («бизне-» + «са») и дефис перед заглавной («1С-» + «Битрикс»)."""
    if not text:
        return part
    if re.search(r"[а-яa-z]-$", text) and re.match(r"[а-яa-z]", part):
        return text[:-1] + part
    if text.endswith("-") and re.match(r"[А-ЯA-Z]", part):
        return text + part
    return text + " " + part


def reading_order(blocks, headings):
    """Слайд как набор карточек: блок принадлежит ближайшему заголовку карточки над ним, перекрывающему его
    по горизонтали. Блоки вне карточек идут первыми (сверху вниз, слева направо), затем карточки по рядам."""
    cards = {id(h): [] for h in headings}
    loose = []
    for block in blocks:
        above = [h for h in headings if h["y"] < block["y"] and block["x0"] < h["x1"] + 10 and block["x1"] > h["x0"] - 10]
        if above:
            cards[id(max(above, key=lambda h: h["y"]))].append(block)
        else:
            loose.append(block)
    parts = [b["text"] for b in sorted(loose, key=lambda b: (round(b["y"] / 15), b["x0"]))]
    for heading in sorted(headings, key=lambda h: (round(h["y"] / 15), h["x0"])):
        body = ""
        for block in sorted(cards[id(heading)], key=lambda b: b["y"]):
            body = join(body, block["text"])
        parts.append(f"**{heading['text']}**" + (f"\n{body}" if body else ""))
    return parts


def page_markdown(page, number):
    blocks = []
    for raw in page.get_text("dict")["blocks"]:
        if raw["type"] != 0:
            continue
        text = block_text(raw)
        sizes = [span["size"] for line in raw["lines"] for span in line["spans"] if span["text"].strip()]
        if not text or COPYRIGHT.search(text) or text == f"{number:02d}" or text == str(number):
            continue
        x0, y0, x1, _ = raw["bbox"]
        blocks.append({"text": text, "size": max(sizes), "x0": x0, "x1": x1, "y": y0})
    worded = [b for b in blocks if LETTERS.search(b["text"])]
    # Заголовок слайда — самый крупный текст в верхней части слайда.
    top = [b for b in worded if b["y"] < 120]
    title = max(top, key=lambda b: (b["size"], -b["y"])) if top else None
    rest = [b for b in blocks if b is not title]
    body_size = min((b["size"] for b in worded), default=0)
    # Заголовки карточек (и крупные числа в плашках «250+») набраны крупнее основного текста.
    headings = [b for b in rest if b["size"] > body_size + 1.5 and len(b["text"]) < 80]
    others = [b for b in rest if b not in headings]
    # Заголовок карточки в две строки PDF иногда отдаёт двумя блоками, а под названием тарифа отдельным блоком
    # стоит цена: блок сразу под заголовком и перекрывающий его по горизонтали присоединяется к нему.
    merged = []
    for heading in sorted(headings, key=lambda h: h["y"]):
        upper = next((m for m in merged if 0 < heading["y"] - m["last_y"] < max(m["size"], heading["size"]) * 2.5
                      and heading["x0"] < m["x1"] and heading["x1"] > m["x0"]), None)
        if upper:
            same = abs(upper["last_size"] - heading["size"]) < 0.5
            upper["text"] = join(upper["text"], heading["text"]) if same else f"{upper['text']} — {heading['text']}"
            upper.update(last_y=heading["y"], last_size=heading["size"], x0=min(upper["x0"], heading["x0"]), x1=max(upper["x1"], heading["x1"]))
        else:
            merged.append({**heading, "last_y": heading["y"], "last_size": heading["size"]})
    headings = merged
    lines = [f"## Слайд {number}" + (f". {title['text']}" if title else "")]
    lines += reading_order(others, headings)
    return "\n\n".join(lines)


def pdf_markdown(path):
    """Markdown всех слайдов и дата изменения из метаданных PDF (ГГГГ-ММ-ДД или пустая строка)."""
    with fitz.open(path) as document:
        slides = [page_markdown(page, i + 1) for i, page in enumerate(document)]
        modified = re.match(r"D:(\d{4})(\d{2})(\d{2})", document.metadata.get("modDate") or "")
    return "\n\n".join(slides), "-".join(modified.groups()) if modified else ""


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    text, modified = pdf_markdown(sys.argv[1])
    print(f"<!-- изменён {modified} -->\n{text}")
