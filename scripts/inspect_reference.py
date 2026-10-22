"""Capture the requested original page for visual comparison (no form submissions)."""
import json
import re
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / '.reference'
html = BeautifulSoup((REF / 'original.html').read_text(encoding='utf-8'), 'html.parser')
print('HEADINGS', [(x.name, x.get_text(' ', strip=True)) for x in html.select('h1,h2')], flush=True)
print('MEDIA', len(html.select('img')), len(html.select('video')), len(html.select('source')), flush=True)
modules = REF / 'modules'
modules.mkdir(exist_ok=True)
bundle = (REF / 'main.js').read_text(encoding='utf-8')
for i, match in enumerate(re.finditer(r'eval\(("(?:[^"\\]|\\.)*")\);', bundle)):
    code = json.loads(match.group(1))
    source = code.split('sourceURL=')[-1]
    if 'node_modules' not in source:
        path = modules / f'module-{i}.js'
        path.write_text(code, encoding='utf-8')
        print(path.name, source[:160], flush=True)

