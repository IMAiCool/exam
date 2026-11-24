"""Start the JDK in a capability-free, per-submission Windows AppContainer."""
import ctypes as ct
import msvcrt
import os
import subprocess
import time
import uuid
from pathlib import Path
from ctypes import wintypes as w

import win32job
import win32security

kernel = ct.WinDLL("kernel32", use_last_error=True)
userenv = ct.WinDLL("userenv")
P = ct.c_void_p
SIZE = ct.c_size_t

class Startup(ct.Structure):
    _fields_ = [("cb", w.DWORD), ("reserved", P), ("desktop", P), ("title", P),
                ("dimensions", w.DWORD * 7), ("flags", w.DWORD), ("show", w.WORD),
                ("reserved_size", w.WORD), ("reserved_bytes", P), ("stdin", P),
                ("stdout", P), ("stderr", P), ("attributes", P)]

class Process(ct.Structure):
    _fields_ = [("process", P), ("thread", P), ("pid", w.DWORD), ("tid", w.DWORD)]

class Capabilities(ct.Structure):
    _fields_ = [("sid", P), ("capabilities", P), ("count", w.DWORD), ("reserved", w.DWORD)]

def checked(ok):
    if not ok:
        raise ct.WinError(ct.get_last_error())

class Sandbox:
    def __init__(self, root):
        self.root = root
        self.sid = P()
        self.name = "ExamJudge." + uuid.uuid4().hex
        result = userenv.CreateAppContainerProfile(self.name, self.name, self.name, None, 0, ct.byref(self.sid))
        if result:
            raise OSError("无法创建判题隔离身份", result)
        length = ct.windll.advapi32.GetLengthSid(self.sid)
        sid_text = win32security.ConvertSidToStringSid(
            win32security.SID(ct.string_at(self.sid, length)))
        subprocess.run([str(Path(os.environ['SystemRoot']) / 'System32' / 'icacls.exe'), str(root), "/grant", "*" + sid_text + ":(OI)(CI)(M)"],
                       capture_output=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW)

    def close(self):
        userenv.DeleteAppContainerProfile(self.name)
        ct.windll.advapi32.FreeSid(self.sid)

    def run(self, args, stdin, stdout, stderr, timeout):
        job = win32job.CreateJobObject(None, "ExamJudge." + uuid.uuid4().hex)
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits["BasicLimitInformation"].update(ActiveProcessLimit=1, LimitFlags=0x2000 | 8 | 0x200)
        limits["JobMemoryLimit"] = 512 * 1024 * 1024
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        size = SIZE()
        kernel.InitializeProcThreadAttributeList(None, 3, 0, ct.byref(size))
        attrs = ct.create_string_buffer(size.value)
        checked(kernel.InitializeProcThreadAttributeList(attrs, 3, 0, ct.byref(size)))
        info = Process()
        try:
            caps = Capabilities(self.sid, None, 0, 0)
            handles = (P * 3)(*(msvcrt.get_osfhandle(f.fileno()) for f in (stdin, stdout, stderr)))
            jobs = (P * 1)(int(job))
            for handle in handles:
                os.set_handle_inheritable(handle, True)
            for key, value in [(0x20009, caps), (0x20002, handles), (0x2000D, jobs)]:
                checked(kernel.UpdateProcThreadAttribute(attrs, 0, key, ct.byref(value),
                                                          SIZE(ct.sizeof(value)), None, None))
            start = Startup(cb=ct.sizeof(Startup), flags=0x100, stdin=handles[0],
                            stdout=handles[1], stderr=handles[2], attributes=ct.addressof(attrs))
            command = ct.create_unicode_buffer(subprocess.list2cmdline([str(a) for a in args]))
            values = {k: os.environ[k] for k in ("SystemRoot", "SystemDrive", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "windir", "ALLUSERSPROFILE", "PUBLIC") if k in os.environ}
            values.update(TEMP=str(self.root), TMP=str(self.root), PATH=os.path.join(os.environ["SystemRoot"], "System32"))
            env = ct.create_unicode_buffer("\0".join(k + "=" + v for k,v in sorted(values.items())) + "\0")
            checked(kernel.CreateProcessW(str(args[0]), command, None, None, True,
                                          0x08080400, env, str(self.root), ct.byref(start), ct.byref(info)))
            process = P(info.process)
            compiling = os.path.basename(args[0]).lower() == "javac.exe"
            deadline = time.monotonic() + timeout * 3
            wait_ms = timeout * 1000
            while True:
                wait = kernel.WaitForSingleObject(process, wait_ms)
                if wait == 0:
                    break
                checked(wait == 258)
                if not compiling:
                    return None
                # Wall time includes time spent waiting for a CPU on a busy host.
                times = [w.FILETIME() for _ in range(4)]
                checked(kernel.GetProcessTimes(process, *(ct.byref(t) for t in times)))
                cpu = sum((t.dwHighDateTime << 32) + t.dwLowDateTime for t in times[2:]) / 10_000_000
                if cpu >= timeout:
                    return None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Java 编译等待超时，编译进程未用完 CPU 时间")
                wait_ms = max(1, int(1000 * min(remaining, timeout - cpu)))
            status = w.DWORD()
            checked(kernel.GetExitCodeProcess(P(info.process), ct.byref(status)))
            return status.value
        finally:
            job.Close()
            for handle in (info.thread, info.process):
                if handle:
                    kernel.CloseHandle(P(handle))
            kernel.DeleteProcThreadAttributeList(attrs)

