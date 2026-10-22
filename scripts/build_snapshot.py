"""Build the single-page test copy from the public Pixel Plus homepage.

Keeps the original responsive styles and UI; navigation goes to the original.
Requires requests and beautifulsoup4. Run from any directory.
"""
import concurrent.futures
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / '.reference'
DIST = ROOT / 'dist'
ASSETS = DIST / 'assets'
ORIGIN = 'https://pixelplus.ru/'
ASSETS.mkdir(parents=True, exist_ok=True)
REF.mkdir(exist_ok=True)
URL_PATTERN = re.compile(r'url\(\s*([\'\"]?)(.*?)\1\s*\)', re.I)
asset_map = {}
failures = []

def asset_url(value, base=ORIGIN):
    if not value or value.startswith(('data:', '#', 'blob:')):
        return value
    absolute = urljoin(base, value)
    parts = urlsplit(absolute)
    if parts.scheme not in ('http', 'https'):
        return value
    key = absolute.split('#')[0]
    if key not in asset_map:
        name = re.sub(r'[^a-zA-Z0-9._-]', '-', unquote(parts.path.rsplit('/', 1)[-1])) or 'resource'
        name = name[-90:]
        asset_map[key] = '/assets/' + hashlib.sha256(key.encode()).hexdigest()[:12] + '-' + name
    return asset_map[key] + (('#' + parts.fragment) if parts.fragment else '')

def rewrite_css(text, base):
    return URL_PATTERN.sub(lambda m: 'url("' + asset_url(m.group(2), base) + '")' if not m.group(2).startswith(('data:', '#')) else m.group(0), text)

def download(url, local):
    path = DIST / local.lstrip('/')
    if not path.exists():
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        path.write_bytes(response.content)
    return url, path

source = REF / 'original.html'
if not source.exists():
    response = requests.get(ORIGIN, timeout=60)
    response.raise_for_status()
    source.write_bytes(response.content)
soup = BeautifulSoup(source.read_text(encoding='utf-8'), 'html.parser')
# The origin randomizes the banner order. Use a stable first banner for review.
slides = soup.select('.main-slider .splide__list > .splide__slide')
agency_slide = next((slide for slide in slides if 'Агентство' in slide.get_text()), None)
if agency_slide:
    container = agency_slide.parent
    agency_slide.extract()
    container.insert(0, agency_slide)
for script in soup.select('script'):
    script.decompose()
for tag in soup.select('meta[name=robots]'):
    tag['content'] = 'noindex, nofollow'
for tag in soup.select('meta[property="og:url"]'):
    tag['content'] = ORIGIN
for tag in soup.select('link[rel=manifest]'):
    tag.decompose()
canonical = soup.new_tag('link', rel='canonical', href=ORIGIN)
soup.head.append(canonical)

# Convert only navigation. SVG fragments stay local, since they refer to icons.
for tag in soup.find_all():
    for key in list(tag.attrs):
        if key.startswith('on'):
            del tag[key]
    for key in ('data-href', 'action'):
        if tag.get(key):
            tag[key] = urljoin(ORIGIN, tag[key])
    if tag.name in ('a', 'area') and tag.has_attr('href'):
        tag['href'] = urljoin(ORIGIN, tag['href'])
    for key in ('src', 'poster', 'data-src', 'data-flickity-lazyload'):
        if tag.get(key) and tag.name not in ('iframe',):
            tag[key] = asset_url(tag[key])
    for key in ('srcset', 'data-srcset'):
        if tag.get(key):
            tag[key] = ', '.join(' '.join([asset_url(part.strip().split()[0]), *part.strip().split()[1:]]) for part in tag[key].split(',') if part.strip())
    if tag.get('style'):
        tag['style'] = rewrite_css(tag['style'], ORIGIN)
    if tag.name == 'link' and tag.get('href'):
        tag['href'] = asset_url(tag['href'])
for style in soup.select('style'):
    style.string = rewrite_css(style.get_text(), ORIGIN)

# Real navigation links for every call to action, also without JavaScript.
for button in soup.select('button.js-order, div.js-order'):
    button.name = 'a'
    button['href'] = urljoin(ORIGIN, 'contact/zakaz/')
    button.attrs.pop('type', None)
for field in soup.select('input[name=sessid], input[name=recaptcha_response]'):
    field.decompose()
for form in soup.select('form'):
    if form.get('method', '').lower() == 'post':
        form['data-original-destination'] = ORIGIN + 'contact/zakaz/'
        form['action'] = ORIGIN + 'contact/zakaz/'
        form['method'] = 'get'
        form.attrs.pop('data-locked-button', None)

# The shared icon sprite is requested dynamically by the original UI bundle.
icon_url = ORIGIN + 'local/templates/pixelplus.ru_2021/images/icons.svg'
icon_path = asset_url(icon_url)
vendor_url = ORIGIN + 'local/templates/pixelplus.ru_2021/js/libs.min.js'
vendor_path = asset_url(vendor_url)
jquery_path = asset_url(ORIGIN + 'bitrix/js/main/jquery/jquery-2.2.4.min.js')
form_scripts = [asset_url(ORIGIN + path) for path in (
    'js/jquery-ui/jquery-ui.min.js',
    'js/inputmaskMulti/jquery.inputmask.bundle.min.js',
    'js/inputmaskMulti/jquery.inputmask-multi.js',
    'js/FormStyler/jquery.formstyler.min.js',
    'local/templates/pixelplus.ru_2015.mobile/js/jquery.filestyle/jquery.filestyle.min.js',
)]
phone_codes = asset_url(ORIGIN + 'js/inputmaskMulti/phone-codes.json')
feedback_source = REF / 'FeedbackForm.js'
if not feedback_source.exists():
    response = requests.get(ORIGIN + 'local/templates/.default/js/FeedbackForm.js', timeout=60)
    response.raise_for_status()
    feedback_source.write_bytes(response.content)
feedback = feedback_source.read_text(encoding='utf-8').replace('/js/inputmaskMulti/phone-codes.json', phone_codes).replace('app.numberFormat', 'window.pixelplusTest.numberFormat')
(ASSETS / 'original-feedback.js').write_text(feedback, encoding='utf-8')

# Retain original UI components, remove backend/analytics initialization.
bundle_path = REF / 'main.js'
if not bundle_path.exists():
    response = requests.get(ORIGIN + 'local/templates/pixelplus.ru_2021/js/main.js', timeout=60)
    response.raise_for_status()
    bundle_path.write_bytes(response.content)
bundle = bundle_path.read_text(encoding='utf-8')
def transform_module(match):
    code = json.loads(match.group(1))
    if code.split('sourceURL=')[-1].startswith('webpack://pixelplus.ru-frontend/./src/js/main.js?'):
        code = code.replace("window.location.hostname === 'localhost' ? '/images/icons.svg' : '/local/templates/pixelplus.ru_2021/images/icons.svg'", json.dumps(icon_path))
        code = code.replace('window.pixelplus.initPhoneInputs(document);', '/* Phone fields remain local; no geo-IP lookup. */')
        cookie_start = code.index('  if (typeof _classes_AcceptCookie')
        callback_start = code.index('      on: {', cookie_start)
        callback_end = code.index('\n    });\n  } // Лайк', callback_start)
        code = code[:callback_start] + '      on: { beforeSet: function () {}, afterSet: function () {}, afterClose: function () {} }' + code[callback_end:]
    return 'eval(' + json.dumps(code, ensure_ascii=True) + ');'
bundle = re.sub(r'eval\(("(?:[^"\\]|\\.)*")\);', transform_module, bundle)
(ASSETS / 'original-ui.js').write_text(bundle, encoding='utf-8')
for src in (jquery_path, vendor_path, *form_scripts, '/assets/original-feedback.js', '/assets/original-ui.js', '/assets/site.js'):
    tag = soup.new_tag('script', src=src, defer=True)
    soup.body.append(tag)
soup.head.append(soup.new_tag('link', rel='stylesheet', href='/assets/site.css'))
soup.head.append(soup.new_tag('link', rel='stylesheet', href='/assets/ai-lead.css'))
lead = BeautifulSoup((ASSETS / 'ai-lead.html').read_text(encoding='utf-8'), 'html.parser')
soup.select_one('.page__heading').insert_after(lead)

done = set()
while pending := [(url, path) for url, path in asset_map.items() if url not in done]:
    print(f'Downloading {len(pending)} resources ({len(done)} already processed)', flush=True)
    # Parse styles after concurrent downloads, keeping graph mutation sequential.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(download, url, path): url for url, path in pending}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            done.add(url)
            try:
                _, path = future.result()
                if path.suffix.lower() == '.css':
                    raw = REF / path.name
                    if not raw.exists():
                        raw.write_bytes(path.read_bytes())
                    path.write_text(rewrite_css(raw.read_text(encoding='utf-8-sig'), url), encoding='utf-8')
            except Exception as exc:
                failures.append({'url': url, 'error': str(exc)})
                print('RESOURCE ERROR', url, str(exc), flush=True)

html = str(soup)
# Failed legacy CSS images are kept as original URLs for transparent fallback.
for failure in failures:
    html = html.replace(asset_map[failure['url']], failure['url'])
    for css in ASSETS.glob('*.css'):
        css.write_text(css.read_text(encoding='utf-8').replace(asset_map[failure['url']], failure['url']), encoding='utf-8')
(DIST / 'index.html').write_text(html, encoding='utf-8')
(DIST / 'robots.txt').write_text('User-agent: *\nDisallow: /\n', encoding='utf-8')
(ROOT / 'asset-manifest.json').write_text(json.dumps({'source': ORIGIN, 'assets': asset_map, 'unavailable': failures}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'assets':len(asset_map),'unavailable':len(failures),'html_bytes':len(html.encode())}), flush=True)
