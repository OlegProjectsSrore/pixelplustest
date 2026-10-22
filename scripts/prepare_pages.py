"""Prepare the existing static snapshot for a GitHub Pages project URL."""
import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-path', required=True)
args = parser.parse_args()
base_path = '/' + args.base_path.strip('/')
destination = ROOT / 'outputs' / 'github-pages'

for source in (ROOT / 'dist').rglob('*'):
    if not source.is_file():
        continue
    target = destination / source.relative_to(ROOT / 'dist')
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() in {'.html', '.css', '.js', '.json', '.svg', '.txt'}:
        content = source.read_text(encoding='utf-8')
        content = content.replace('/assets/', base_path + '/assets/')
        target.write_text(content, encoding='utf-8')
    else:
        shutil.copy2(source, target)

(destination / '.nojekyll').touch()
print(f'GitHub Pages artifact: {destination}')
