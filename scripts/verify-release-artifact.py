"""公開経路の実物だけを検証する。開発テストや機能の実行は行わない。"""

import fnmatch
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
from urllib.parse import unquote, urlsplit
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


variant, artifact = sys.argv[1:]
require(variant in ("chrome", "firefox"), "Unknown platform")
target = Path(artifact).resolve(strict=True)
root = Path(__file__).resolve().parent.parent
expected_version = os.environ["EXPECTED_VERSION"]

# ZIP 内の実 bytes を展開して照合する。再コピー・再パッケージはしない。
if variant == "chrome":
    with zipfile.ZipFile(target) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        require(len({entry.filename for entry in entries}) == len(entries), "Duplicate ZIP entries")
        files = {entry.filename: archive.read(entry) for entry in entries}
    identity = hashlib.sha256(target.read_bytes()).hexdigest()
else:
    paths = sorted(target.rglob("*"))
    require(not any(item.is_symlink() for item in paths), "Source contains symlinks")
    files = {item.relative_to(target).as_posix(): item.read_bytes() for item in paths if item.is_file()}
    identity = None

for name in files:
    require(not name.startswith("/") and "\\" not in name and ".." not in PurePosixPath(name).parts,
            f"Unsafe package path: {name}")
    require(name == "manifest.json" or name.startswith(("icons/", "src/", "_locales/")),
            f"Unexpected package entry: {name}")

# copy-package-files.js の選択範囲と一致させ、動的読込み用ファイルの欠落も止める。
expected_files = {"manifest.json"}
source_name = "manifest.firefox.json" if variant == "firefox" else "manifest.json"
source_manifest = json.loads((root / source_name).read_text(encoding="utf-8"))
# PNG は package job で生成するため、公開 job の checkout には存在しない。
# 期待するファイルは manifest の参照からも加え、実物の寸法は後段で検証する。
expected_files.update(source_manifest.get("icons", {}).values())
expected_files.update(source_manifest.get("action", {}).get("default_icon", {}).values())
for directory in ("icons", "src", "_locales"):
    for item in (root / directory).rglob("*"):
        if not item.is_file() or re.search(r"(?:\.DS_Store|\.swp|~)$", item.name):
            continue
        name = item.relative_to(root).as_posix()
        if variant == "chrome" and name == "src/content/volume-booster-mes.js":
            continue
        if variant == "firefox" and name.startswith("src/offscreen/"):
            continue
        expected_files.add(name)
require(set(files) == expected_files,
        f"Package inventory mismatch: missing={sorted(expected_files - set(files))}, extra={sorted(set(files) - expected_files)}")


def present(name):
    require(name in files and len(files[name]) > 0, f"Missing or empty package reference: {name}")


present("manifest.json")
manifest = json.loads(files["manifest.json"])
require(manifest == source_manifest,
        "Packaged manifest differs from release source")
for name in ("manifest.json", "manifest.firefox.json", "package.json"):
    require(json.loads((root / name).read_text(encoding="utf-8"))["version"] == expected_version,
            f"Release version mismatch: {name}")
require(manifest.get("manifest_version") == 3 and manifest.get("version") == expected_version,
        "Expected Manifest V3 release version")
require(manifest.get("name") and manifest.get("description") and manifest.get("default_locale"),
        "Missing extension metadata")

references = list(manifest.get("icons", {}).values())
action = manifest.get("action", {})
references += list(action.get("default_icon", {}).values())
references += [action["default_popup"]]
background = manifest["background"]
if variant == "chrome":
    references += [background["service_worker"], "src/offscreen/offscreen.html", "src/offscreen/offscreen.js"]
    require("offscreen" in manifest["permissions"] and "tabCapture" in manifest["permissions"],
            "Chrome capture permissions missing")
    require("src/content/volume-booster-mes.js" not in files, "Firefox-only script in Chrome package")
else:
    references += background["scripts"] + ["src/content/volume-booster-mes.js"]
    require(manifest["browser_specific_settings"]["gecko"]["id"], "Missing Firefox extension ID")
    require(not {"offscreen", "tabCapture"}.intersection(manifest["permissions"]), "Chrome permissions in Firefox")
    require(not any(name.startswith("src/offscreen/") for name in files), "Chrome-only files in Firefox source")
    require(b"__FIREFOX_STRIP_BEGIN__" not in files["src/background/background.js"], "Firefox source was not stripped")
    metadata = json.loads((root / ".amo-metadata.json").read_text(encoding="utf-8"))
    require(metadata["version"]["license"] and metadata["categories"]["firefox"], "Missing AMO submission metadata")
for content in manifest.get("content_scripts", []):
    references += content.get("js", []) + content.get("css", [])
for group in manifest.get("web_accessible_resources", []):
    for pattern in group["resources"]:
        matches = fnmatch.filter(files, pattern)
        require(matches, f"Missing web accessible resource: {pattern}")
        references += matches
for name in references:
    present(name.lstrip("/"))

# default_locale に加え、製品が同梱する両言語の JSON と manifest 内 MSG 参照を確認する。
for locale in {manifest["default_locale"], "en", "ja"}:
    name = f"_locales/{locale}/messages.json"
    present(name)
    messages = json.loads(files[name])
    for key in re.findall(r"__MSG_(\w+)__", json.dumps(manifest)):
        require(isinstance(messages.get(key, {}).get("message"), str) and messages[key]["message"],
                f"Missing manifest locale message: {locale}/{key}")
for icons in (manifest["icons"], action["default_icon"]):
    for size, name in icons.items():
        require(files[name].startswith(b"\x89PNG\r\n\x1a\n") and len(files[name]) >= 24,
                f"Invalid PNG icon: {name}")
        require(int.from_bytes(files[name][16:20], "big") == int(size)
                and int.from_bytes(files[name][20:24], "big") == int(size), f"Icon dimensions mismatch: {name}")


def local_reference(owner, value):
    url = urlsplit(value)
    if not value or url.scheme or url.netloc or value.startswith("#"):
        return
    name = unquote(url.path)
    name = name.lstrip("/") if name.startswith("/") else posixpath.join(posixpath.dirname(owner), name)
    present(posixpath.normpath(name))


class References(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for key in ("src", "href"):
            if key in attrs and attrs[key]:
                local_reference(self.owner, attrs[key])


for name, data in files.items():
    if name.endswith(".html"):
        parser = References()
        parser.owner = name
        parser.feed(data.decode("utf-8"))
    elif name.endswith(".css"):
        for value in re.findall(r"url\(\s*['\"]?([^'\")\s]+)", data.decode("utf-8")):
            local_reference(name, value)
    elif name.endswith(".js"):
        source = data.decode("utf-8")
        for value in re.findall(r"runtime\.getURL\(\s*['\"]([^'\"]+)['\"]\s*\)", source):
            present(value.lstrip("/"))
        for arguments in re.findall(r"importScripts\(([^)]+)\)", source):
            for value in re.findall(r"['\"]([^'\"]+)['\"]", arguments):
                local_reference(name, value)

# MAIN-world 等、manifest 以外から動的参照されるファイルも全件の identity に含む。
inventory = "".join(f"{hashlib.sha256(files[name]).hexdigest()}  {name}\n" for name in sorted(files))
inventory_hash = hashlib.sha256(inventory.encode("utf-8")).hexdigest()
identity = identity or inventory_hash
require(not os.environ.get("EXPECTED_SHA256") or identity == os.environ["EXPECTED_SHA256"],
        "Downloaded artifact differs from verified package")
print(f"source={os.environ.get('GITHUB_SHA', 'local')} version={expected_version} platform={variant}")
print(f"artifact={target} sha256={identity} inventory_sha256={inventory_hash}")
print("signature=unsigned submission input; store signing/repackaging has a separate identity")
print(inventory, end="")
if os.environ.get("GITHUB_OUTPUT"):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"sha256={identity}\n")
