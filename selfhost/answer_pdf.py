"""Render a reviewed answer sheet from JSON on stdin to PDF on stdout."""
import json
import os
import sys
from html import escape
from reportlab.platypus import Table, TableStyle, Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from functools import lru_cache
from pathlib import Path

from pygments import lex
from pygments.lexers import get_lexer_by_name
from pygments.lexers.special import TextLexer
from pygments.styles import get_style_by_name
from pygments.util import ClassNotFound
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


def register_fonts():
    if os.name == "nt":
        fonts = Path(os.environ["WINDIR"]) / "Fonts"
        text, mono = fonts / "msyh.ttc", fonts / "consola.ttf"
    else:
        fonts = Path("/usr/share/fonts/truetype")
        text, mono = fonts / "wqy/wqy-zenhei.ttc", fonts / "dejavu/DejaVuSansMono.ttf"
    pdfmetrics.registerFont(TTFont("Body", str(text)))
    pdfmetrics.registerFont(TTFont("Mono", str(mono)))


@lru_cache(maxsize=8192)
def width(char, font, size):
    return pdfmetrics.stringWidth(char, font, size)


class Paper:
    def __init__(self, title, theme):
        self.pdf = Canvas(sys.stdout.buffer, pagesize=A4, pageCompression=1)
        self.pdf.setTitle(title)
        dark = theme == "dark"
        self.background = "#181b21" if dark else "#ffffff"
        self.foreground = "#edf1f6" if dark else "#202936"
        self.code_background = "#252930" if dark else "#f0f2f6"
        self.toolbar = "#30353e" if dark else "#e4e8ee"
        self.style = get_style_by_name("monokai" if dark else "friendly")
        self.begin_page()

    def table(self, rows):
        style = ParagraphStyle("Cell", fontName="Body", fontSize=10, leading=16, textColor=HexColor(self.foreground))
        cells = [[Paragraph(escape(value).replace("\n", "<br/>"), style) for value in row] for row in rows]
        table = Table(cells, colWidths=[(A4[0] - 88) / len(rows[0])] * len(rows[0]), repeatRows=1 if len(rows) > 1 else 0, splitInRow=1)
        table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .5, HexColor("#888888")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BACKGROUND", (0, 0), (-1, 0), HexColor(self.toolbar)), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        pending = [table]
        while pending:
            part = pending.pop(0)
            _, height = part.wrap(A4[0] - 88, self.y - 42)
            if height <= self.y - 42:
                part.drawOn(self.pdf, 44, self.y - height)
                self.y -= height + 8
                continue
            pieces = part.split(A4[0] - 88, self.y - 42)
            if pieces:
                pending = pieces + pending
                continue
            self.pdf.showPage()
            self.begin_page()
            pending.insert(0, part)

    def begin_page(self):
        self.pdf.setFillColor(self.background)
        self.pdf.rect(0, 0, *A4, fill=1, stroke=0)
        self.y = A4[1] - 42

    def space(self, height, language=None):
        if self.y - height < 42:
            self.pdf.showPage()
            self.begin_page()
            if language:
                self.code_header(language)

    def lines(self, tokens, size, language=None):
        pad = 10 if language else 0
        left, right = 44 + pad, A4[0] - 44 - pad
        height = size * 1.65
        runs, x = [], left

        def flush():
            self.space(height, language)
            if language:
                self.pdf.setFillColor(self.code_background)
                self.pdf.rect(44, self.y-height, A4[0]-88, height, fill=1, stroke=0)
            for start, font, color, chars in runs:
                self.pdf.setFont(font, size)
                self.pdf.setFillColor(color)
                self.pdf.drawString(start, self.y-size-1, "".join(chars))
            self.y -= height
            runs.clear()

        for color, value in tokens:
            for ch in value.replace("\r\n", "\n").replace("\r", "\n").expandtabs(4):
                if ch == "\n":
                    flush()
                    x = left
                    continue
                font = "Mono" if language and ch.isascii() else "Body"
                advance = width(ch, font, size)
                if x + advance > right:
                    flush()
                    x = left
                if not runs or runs[-1][1:3] != (font, color):
                    runs.append((x, font, color, []))
                runs[-1][3].append(ch)
                x += advance
        if runs:
            flush()

    def text(self, value, size=11):
        self.lines([(self.foreground, str(value))], size)
        self.y -= 4

    def code_header(self, language):
        height = 22
        self.pdf.setFillColor(self.toolbar)
        self.pdf.rect(44, self.y-height, A4[0]-88, height, fill=1, stroke=0)
        for i, color in enumerate(("#e76b5b", "#edbf4f", "#6ac558")):
            self.pdf.setFillColor(color)
            self.pdf.circle(55 + 11*i, self.y-height/2, 3.4, fill=1, stroke=0)
        self.pdf.setFillColor(self.foreground)
        self.pdf.setFont("Body", 9)
        self.pdf.drawRightString(A4[0]-54, self.y-14, language)
        self.y -= height

    def code(self, source, language):
        self.space(40)
        self.code_header(language)
        try:
            lexer = get_lexer_by_name(language.lower(), stripnl=False, ensurenl=False)
        except ClassNotFound:
            lexer = TextLexer(stripnl=False, ensurenl=False)
        self.lines((("#"+(self.style.style_for_token(t)["color"] or self.foreground[1:]), s)
                    for t, s in lex(source or " ", lexer)), 10, language=language)
        self.y -= 8


def main():
    data = json.load(sys.stdin.buffer)
    register_fonts()
    out = Paper(data["title"], data.get("theme", "light"))
    out.text(data["title"], 20)
    out.text(f'学生：{data["student"]}　试卷编号：{data["id"]}　第 {data["revision"]} 版')
    out.text(f'最终成绩：{data["score"]} / {data["max"]} 分')
    for item in data["items"]:
        out.space(64)
        out.text(item["heading"], 14)
        out.text(item["prompt"])
        for table in item.get("tables", []):
            out.table(table)
        for block in item["blocks"]:
            out.code(block["code"], block["language"])
            if block.get("followingText"):
                out.text(block["followingText"])
        for option in item["choices"]:
            out.text(option)
        for i, sample in enumerate(item["cases"], 1):
            if sample.get("input"):
                out.text(f"示例输入 {i}")
                out.code(sample["input"], "text")
            out.text(f"预期输出 {i}")
            out.code(sample["output"], "text")
        for label, key in [("学生作答", "answer"), ("参考答案", "reference")]:
            out.space(40)
            out.text(label, 12)
            if item[key+"Language"]:
                out.code(item[key], item[key+"Language"])
            else:
                out.text(item[key])
        out.y -= 8
    out.pdf.save()


if __name__ == "__main__":
    main()
