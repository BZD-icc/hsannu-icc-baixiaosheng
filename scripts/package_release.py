#!/usr/bin/env python3
"""Produce the preview directory and the two documented release archives."""
from pathlib import Path
import argparse
import shutil
import zipfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.1.0"
SKILL = "hsannu-icc-baixiaosheng"
WEB_FILES = (
    "index.html", "styles.css", "app.mjs", "core.mjs", "store.mjs",
    "model.mjs", "knowledge.mjs", "sync.mjs", "courses.mjs",
    "vendor/peerjs.min.js", "vendor/PeerJS-LICENSE.txt", "vendor/THIRD-PARTY-NOTICES.txt",
)
KNOWLEDGE_FILES = ("index.json", "公开知识正文.md", "来源索引.md", "提问模板.md", "选课评价示例.json")
SKILL_FILES = ("SKILL.md", "agents/openai.yaml", "references/公开知识正文.md", "references/来源索引.md")


def write_zip(target, source, files):
    with zipfile.ZipFile(target, "w") as archive:
        for relative in sorted(files):
            item = zipfile.ZipInfo(relative.as_posix(), date_time=(2026, 11, 7, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o644 << 16
            archive.writestr(item, (source / relative).read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    output = args.destination.resolve()
    output.mkdir(parents=True, exist_ok=True)
    stage = output / "HSANNU-ICC百晓生"
    knowledge = [Path("web/knowledge") / name for name in KNOWLEDGE_FILES]
    files = (
        [Path("使用说明.md")]
        + [Path("web") / name for name in WEB_FILES]
        + knowledge
        + [Path("skill") / SKILL / name for name in SKILL_FILES]
    )
    for relative in files:
        if not (ROOT / relative).is_file():
            raise SystemExit("缺少发布文件 " + str(relative))
    for relative in files:
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    write_zip(output / (SKILL + "-v" + VERSION + ".zip"), stage, files)
    write_zip(
        output / ("hsannu-icc-knowledge-v" + VERSION + ".zip"),
        stage / "web/knowledge",
        [Path(name) for name in KNOWLEDGE_FILES],
    )
    print("Prepared " + str(stage) + " and two ZIP archives.")


if __name__ == "__main__":
    main()
