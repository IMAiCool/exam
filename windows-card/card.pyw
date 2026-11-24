"""Per-user Windows question overlay. Only the configured exam origin can send cards."""
import argparse
import base64
import ctypes
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import queue
import re
import threading
import time
import tkinter as tk

from PIL import Image, ImageTk

PORT = 18749
parser = argparse.ArgumentParser()
parser.add_argument("--origin", action="append", required=True)
origins = set(parser.parse_args().origin)
updates = queue.Queue(maxsize=32)
user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


class Bridge(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def allowed(self):
        return (self.headers.get("Host") == f"127.0.0.1:{PORT}"
                and self.headers.get("Origin") in origins and self.path == "/card")

    def reply(self, status, body=b""):
        self.send_response(status)
        if self.allowed():
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204 if self.allowed() else 403)

    def do_GET(self):
        if self.allowed():
            self.reply(200, b"exam-native-card-v1")
        else:
            self.reply(403)

    def do_POST(self):
        if not self.allowed():
            return self.reply(403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 12_000_000:
                return self.reply(413)
            data = json.loads(self.rfile.read(length))
            key, seq = data["key"], data["seq"]
            if not re.fullmatch(r"[a-f0-9]{24}", key) or not isinstance(seq, int):
                return self.reply(400)
            image = None
            if "png" in data:
                with Image.open(BytesIO(base64.b64decode(data["png"], validate=True))) as src:
                    if src.format != "PNG" or max(src.size) > 4096:
                        return self.reply(400)
                    image = src.convert("RGB")
            updates.put_nowait((key, seq, image, str(data.get("title", ""))[:100]))
        except queue.Full:
            return self.reply(503)
        except (ValueError, TypeError, KeyError, OSError):
            return self.reply(400)
        self.reply(204)


def window_title(hwnd):
    title = ctypes.create_unicode_buffer(1024)
    user32.GetWindowTextW(hwnd, title, len(title))
    return title.value


def browser_for(key):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd) and key in window_title(hwnd):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(visit, 0)
    return found[0] if found else None


server = ThreadingHTTPServer(("127.0.0.1", PORT), Bridge)
threading.Thread(target=server.serve_forever, daemon=True).start()
root = tk.Tk()
root.withdraw()
root.overrideredirect(True)
root.attributes("-topmost", True)
label = tk.Label(root, bd=0, highlightthickness=0)
label.pack()
cards, versions, last_seen = {}, {}, {}
position = None
visible = None


def move(event):
    global position
    x = event.x_root - label.drag[0]
    y = event.y_root - label.drag[1]
    position = (x, y)
    root.geometry(f"+{x}+{y}")


label.bind("<ButtonPress-1>", lambda event: setattr(label, "drag", (event.x, event.y)))
label.bind("<B1-Motion>", move)


def refresh():
    global visible, position
    now = time.monotonic()
    while not updates.empty():
        key, seq, bitmap, title = updates.get_nowait()
        if seq <= versions.get(key, 0):
            continue
        versions[key] = seq
        last_seen[key] = now
        cards.pop(key, None)
        if bitmap:
            cards[key] = (bitmap, title)
    foreground = user32.GetForegroundWindow()
    selected = None
    for key in reversed(cards):
        owner = browser_for(key)
        if owner:
            last_seen[key] = now
            browser_pid, active_pid = wintypes.DWORD(), wintypes.DWORD()
            user32.GetWindowThreadProcessId(owner, ctypes.byref(browser_pid))
            user32.GetWindowThreadProcessId(foreground, ctypes.byref(active_pid))
            if browser_pid.value != active_pid.value:
                selected = (key, versions[key])
            break
    # Clean up if a tab or browser exited without delivering its close message.
    for key in list(last_seen):
        if now - last_seen[key] > 180:
            cards.pop(key, None)
            del last_seen[key], versions[key]
    if selected != visible:
        if selected:
            bitmap, title = cards[selected[0]]
            work = wintypes.RECT()
            user32.SystemParametersInfoW(48, 0, ctypes.byref(work), 0)
            width, height = work.right - work.left, work.bottom - work.top
            image = bitmap.copy()
            image.thumbnail((min(860, int(width * .72)), int(height * .83)), Image.Resampling.LANCZOS)
            label.photo = ImageTk.PhotoImage(image)
            label.configure(image=label.photo)
            root.title(title)
            x, y = position or (work.right - image.width - 18, work.top + 24)
            x = max(work.left, min(x, work.right - image.width))
            y = max(work.top, min(y, work.bottom - image.height))
            root.geometry(f"{image.width}x{image.height}+{x}+{y}")
            root.update_idletasks()
            hwnd = user32.GetAncestor(root.winfo_id(), 2)
            # WS_EX_NOACTIVATE and SW_SHOWNOACTIVATE keep the other app focused.
            user32.SetWindowLongW(hwnd, -20, user32.GetWindowLongW(hwnd, -20) | 0x08000080)
            user32.ShowWindow(hwnd, 4)
            user32.SetWindowPos(hwnd, -1, x, y, image.width, image.height, 0x50)
        else:
            user32.ShowWindow(user32.GetAncestor(root.winfo_id(), 2), 0)
        visible = selected
    root.after(160, refresh)


root.after(0, refresh)
root.mainloop()
