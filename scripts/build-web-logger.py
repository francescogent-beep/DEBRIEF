#!/usr/bin/env python3
"""Copy the Chrome extension's logger into the dashboard as a web page at /log.

The extension is the single source of truth. Run this after changing any file
in extension/ so the web version (for Safari, Firefox and phones) stays identical:

    python3 scripts/build-web-logger.py
"""
import json, pathlib, shutil, zipfile

root = pathlib.Path(__file__).resolve().parent.parent
src = root / "extension"
out = root / "dashboard" / "public" / "log"

if out.exists():
    shutil.rmtree(out)
(out / "icons").mkdir(parents=True)

for name in ["sidepanel.css", "sidepanel.js", "api.js", "config.js", "compat.js"]:
    shutil.copy(src / name, out / name)
for icon in (src / "icons").glob("*.png"):
    shutil.copy(icon, out / "icons" / icon.name)

html = (src / "sidepanel.html").read_text()
head_extra = """  <base href="/log/" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="icon" href="icons/icon48.png" />
  <link rel="apple-touch-icon" href="icons/icon192.png" />
  <meta name="theme-color" content="#15171c" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Debrief" />
"""
assert "<head>" in html
html = html.replace("<head>\n", "<head>\n" + head_extra, 1)
html = html.replace("<title>Debrief</title>", "<title>Debrief — Call Logger</title>")
(out / "index.html").write_text(html)

manifest = {
    "name": "Debrief — Call Logger",
    "short_name": "Debrief",
    "start_url": "/log/",
    "scope": "/log/",
    "display": "standalone",
    "background_color": "#f7f7f4",
    "theme_color": "#15171c",
    "icons": [
        {"src": "icons/icon192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icons/icon512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
    ],
}
(out / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Web logger written to {out.relative_to(root)}")

# Downloadable copy of the Chrome extension for reps: /downloads/debrief-extension.zip
dl = root / "dashboard" / "public" / "downloads"
dl.mkdir(parents=True, exist_ok=True)
zip_path = dl / "debrief-extension.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            z.write(f, pathlib.Path("debrief-extension") / f.relative_to(src))
print(f"Extension download written to {zip_path.relative_to(root)}")
