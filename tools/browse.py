"""
Drive the user's existing Chrome over CDP - no bundled browser needed.

Usage (from node or a shell):
  python tools/browse.py <url> [--text] [--title]
  python tools/browse.py <url> --click "<selector>"
  python tools/browse.py <url> --fill "<selector>=<text>"
  python tools/browse.py <url> --hover "<selector>"
  python tools/browse.py <url> --double-click "<selector>"
  python tools/browse.py <url> --select "<selector>"

Prints JSON: {"ok":true,"url":...,"title":...,"text":...}

Why CDP instead of launching a browser: the Playwright chromium download is
blocked on this network, and the user's Chrome already holds their logins.
"""
import json
import sys
import re

CDP = "http://127.0.0.1:9222"


def parse_fill(arg):
    # 'selector::text' is preferred: '=' appears inside CSS attribute selectors
    if '::' in arg:
        sel, text = arg.split('::', 1)
        return sel.strip(), text
    m = re.match(r'(.+?)=(.*)', arg)
    if not m:
        return None, None
    return m.group(1).strip(), m.group(2)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: browse.py <url> [--text|--click|--fill|--hover|--double-click|--select]"}))
        return 1
    url = sys.argv[1]
    click_sel = None
    fill_sel = None
    fill_text = None
    hover_sel = None
    double_click_sel = None
    select_sel = None
    scroll_dy = None
    want_text = True
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == '--click' and i + 1 < len(sys.argv):
            click_sel = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--fill' and i + 1 < len(sys.argv):
            fill_sel, fill_text = parse_fill(sys.argv[i + 1])
            if not fill_sel:
                print(json.dumps({"ok": False, "error": "--fill needs selector=text"}))
                return 1
            i += 2
        elif sys.argv[i] == '--hover' and i + 1 < len(sys.argv):
            hover_sel = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--double-click' and i + 1 < len(sys.argv):
            double_click_sel = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--scroll' and i + 1 < len(sys.argv):
            scroll_dy = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == '--select' and i + 1 < len(sys.argv):
            select_sel = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--text':
            want_text = True
            i += 1
        elif sys.argv[i] == '--title-only':
            want_text = False
            i += 1
        else:
            i += 1

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        print(json.dumps({"ok": False, "error": "playwright missing: %s" % e}))
        return 1

    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(CDP)
            ctx = browser.contexts[0] if browser.contexts else browser.new_context()
            page = ctx.new_page()
            page.goto(url, timeout=45000, wait_until="domcontentloaded")

            if click_sel:
                page.click(click_sel, timeout=10000)
            elif fill_sel and fill_text is not None:
                page.fill(fill_sel, fill_text, timeout=10000)
            elif hover_sel:
                page.hover(hover_sel, timeout=10000)
            elif double_click_sel:
                page.dblclick(double_click_sel, timeout=10000)
            elif select_sel:
                page.select_option(select_sel, timeout=10000)
            elif scroll_dy is not None:
                page.mouse.wheel(0, scroll_dy)
                page.wait_for_timeout(400)

            title = page.title()
            text = ""
            if want_text:
                try:
                    text = page.inner_text("body")[:8000]
                except Exception:
                    text = ""

            out = {"ok": True, "url": page.url, "title": title, "text": " ".join(text.split())}
            page.close()
            print(json.dumps(out))
            return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300], "cdp": CDP}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
