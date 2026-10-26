"""Регрессии потери отметок и условий в сравнительных таблицах pixelplus.ru."""
import unittest

from bs4 import BeautifulSoup

from extract import content_roots, preserve_table_markers, text_key, to_markdown


class TableMarkersTest(unittest.TestCase):
    def render(self, html):
        soup = BeautifulSoup(html, "lxml")
        return "\n\n".join(to_markdown(str(root)) for root in content_roots(soup))

    def test_css_tariffs_and_footnotes(self):
        md = self.render('''<table class="table-compare">
          <thead><tr><th>Работа</th><td>Старт</td><td>Оптима</td><td>Макси</td></tr></thead>
          <tbody><tr><th>Стратегия*</th>
          <td class="table-compare__not-available"></td>
          <td class="table-compare__available table-compare__favorite"></td>
          <td class="table-compare__available">по согласованию**</td></tr>
          <tr><th>Публикации</th><td>8 в месяц</td><td>16 в месяц</td><td>24 в месяц</td></tr>
          </tbody></table><p>*Без рекламного бюджета</p><p>**Индивидуально</p>''')
        self.assertIn("| Стратегия* | Нет | Да | по согласованию** Да |", md)
        self.assertIn("| Публикации | 8 в месяц | 16 в месяц | 24 в месяц |", md)
        self.assertIn("*Без рекламного бюджета", md)
        self.assertIn("**Индивидуально", md)

    def test_nested_css_and_svg(self):
        md = self.render('''<table><tr><th>Критерий</th><th>A</th><th>B</th></tr>
          <tr><td>CSS</td><td><span class="table__available"></span></td>
          <td><span class="table__not-available"></span></td></tr>
          <tr><td>SVG</td><td><svg><use href="#check-circle"/></svg></td>
          <td><svg><use xlink:href="#close-circle"/></svg></td></tr></table>''')
        self.assertIn("| CSS | Да | Нет |", md)
        self.assertIn("| SVG | Да | Нет |", md)

    def test_unknown_is_not_negative_and_headers_stay_empty(self):
        md = self.render('''<table class="table-compare">
          <thead><tr><th></th><td>Старт</td><td>Макси</td></tr></thead>
          <tbody><tr class="table-compare__heading-row"><th>Раздел</th><td></td><td></td></tr>
          <tr><th>Услуга</th><td></td><td><svg><use href="#unknown"/></svg></td></tr></tbody>
          <tfoot><tr><td></td><td><button>Выбрать</button></td><td></td></tr></tfoot></table>''')
        self.assertIn("| | Старт | Макси |", md)
        self.assertIn("| Раздел | | |", md)
        self.assertIn("| Услуга | Не указано | Не указано |", md)
        self.assertNotIn("Нет", md)
        self.assertNotIn("Выбрать", md)

    def test_plain_layout_table_unchanged(self):
        self.assertNotIn("Не указано", self.render("<table><tr><td>Подпись</td><td></td></tr></table>"))

    def test_repeated_blocks_keep_distinct_membership(self):
        keys = []
        for marker in ("available", "not-available"):
            soup = BeautifulSoup(f'<div><table><tr><th>Работа</th>'
                                 f'<td class="table-compare__{marker}"></td></tr></table></div>', "lxml")
            preserve_table_markers(soup)
            keys.append(text_key(soup)[0])
        self.assertNotEqual(*keys)

    def test_normalization_is_idempotent(self):
        soup = BeautifulSoup('<table class="table-compare"><tr><th>Работа</th>'
                             '<td class="table-compare__available"></td><td></td></tr></table>', "lxml")
        preserve_table_markers(soup)
        once = str(soup)
        preserve_table_markers(soup)
        self.assertEqual(once, str(soup))

    def test_conflicting_markers_fail(self):
        with self.assertRaises(ValueError):
            self.render('<table><tr><td class="table__available table__not-available"></td></tr></table>')


if __name__ == "__main__":
    unittest.main()
