"""Verify PDFs from check-print-preview.mjs. Requires pypdf; accepts output directory."""
from pathlib import Path
import sys
from pypdf import PdfReader

output = Path(sys.argv[1])
papers = {
    "a4-portrait": (210, 297),
    "a4-landscape": (297, 210),
    "a3-portrait": (297, 420),
    "a3-landscape": (420, 297),
}
for name, (width, height) in papers.items():
    for suffix in ("blank", "title"):
        file = output / f"{name}-{suffix}.pdf"
        reader = PdfReader(file)
        assert len(reader.pages) == 1, f"{file.name}: {len(reader.pages)} pages"
        page = reader.pages[0]
        assert abs(float(page.mediabox.width) - width * 72 / 25.4) < 1, file.name
        assert abs(float(page.mediabox.height) - height * 72 / 25.4) < 1, file.name
        text = page.extract_text()
        assert "PRINT TEST SOURCE" in text, f"{file.name}: missing attribution"
        assert "印刷設定" not in text and "再読み込み" not in text, file.name
        assert ("避難場所" in text) == (suffix == "title"), file.name
        print(f"PASS {file.name}: one page, correct size, title and attribution")
