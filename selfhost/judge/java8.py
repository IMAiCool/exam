"""Compile once with Java 8, then run Main in a fresh JVM for each input."""
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

LIMIT = 65536

class ContainerSandbox:
    """The dedicated Compose worker has no network, exam volume or credentials."""
    def __init__(self, root):
        self.root = root

    def run(self, args, stdin, stdout, stderr, timeout):
        cmd = ["prlimit", "--cpu=" + str(timeout), "--fsize=8388608", "--core=0",
               "--as=1610612736", "--"] + args
        with subprocess.Popen(cmd, cwd=self.root, env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"},
                              stdin=stdin, stdout=stdout, stderr=stderr) as child:
            try:
                return child.wait(timeout)
            except subprocess.TimeoutExpired:
                child.kill()
                return None

    def close(self):
        pass

class LinuxSandbox:
    def __init__(self, root, jdk):
        self.root = root
        self.prefix = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session",
                       "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
        for path in ["/usr", "/lib", "/lib64", "/etc/alternatives", "/etc/ld.so.cache", str(jdk)]:
            if Path(path).exists():
                self.prefix.extend(["--ro-bind", path, path])
        self.prefix.extend(["--bind", str(root), str(root), "--chdir", str(root)])
        if not shutil.which("bwrap"):
            raise RuntimeError("缺少 Java 隔离环境 bubblewrap")

    def run(self, args, stdin, stdout, stderr, timeout):
        import resource
        def limits():
            resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout))
            resource.setrlimit(resource.RLIMIT_FSIZE, (8 << 20, 8 << 20))
            resource.setrlimit(resource.RLIMIT_AS, (1536 << 20, 1536 << 20))
        with subprocess.Popen(self.prefix + args, stdin=stdin, stdout=stdout, stderr=stderr,
                              preexec_fn=limits) as child:
            try:
                return child.wait(timeout)
            except subprocess.TimeoutExpired:
                child.kill()
                return None

    def close(self):
        pass

def execute(box, command, data, timeout):
    outputs = [bytearray(), bytearray()]
    def drain(pipe, buf):
        with pipe:
            while chunk := pipe.read(8192):
                buf.extend(chunk[:max(0, LIMIT + 1 - len(buf))])
    with tempfile.TemporaryFile() as stdin:
        stdin.write(data.encode("utf-8"))
        stdin.seek(0)
        writers, threads = [], []
        try:
            for buf in outputs:
                r, w = os.pipe()
                writers.append(os.fdopen(w, "wb"))
                thread = threading.Thread(target=drain, args=(os.fdopen(r, "rb"), buf))
                thread.start()
                threads.append(thread)
            status = box.run(command, stdin, *writers, timeout)
        finally:
            for writer in writers:
                writer.close()
            for thread in threads:
                thread.join()
    return status, *outputs

def run_java(code, cases, result):
    windows = os.name == "nt"
    default = Path(__file__).resolve().parents[2] / "runtime" / "jdk8"
    jdk = Path(os.environ.get("EXAM_JAVA8_HOME", default)).resolve()
    if not (jdk / "release").exists() or 'JAVA_VERSION="1.8.' not in (jdk / "release").read_text():
        raise RuntimeError("请配置 EXAM_JAVA8_HOME 指向 Java 8 JDK")
    ext = ".exe" if windows else ""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        if windows:
            from windows_java import Sandbox
            box = Sandbox(root)
        elif os.environ.get("EXAM_DEDICATED_JAVA_WORKER") == "1":
            box = ContainerSandbox(root)
        else:
            box = LinuxSandbox(root, jdk)
        try:
            (root / "Main.java").write_bytes(code.encode("utf-8"))
            policy = root / "student.policy"
            policy.write_text("grant {};", encoding="ascii")
            vm = ["-Xmx96m", "-Xss512k", "-XX:+UseSerialGC", "-XX:-UsePerfData",
                  "-XX:ReservedCodeCacheSize=32m", "-XX:MaxMetaspaceSize=96m", "-Dfile.encoding=UTF-8"]
            compiler = [jdk / "bin" / ("javac" + ext)] + ["-J" + flag for flag in vm]
            status, _, err = execute(box, compiler + ["-proc:none", "-encoding", "UTF-8",
                                                      "-classpath", ".", "Main.java"], "", 10)
            diagnostic = err.decode("utf-8", "replace").replace(str(root), ".")
            if status and ("bwrap:" in diagnostic or not diagnostic or not (root / "Main.class").exists()
                           and "Main.java:" not in diagnostic):
                raise RuntimeError("Java 编译环境异常 " + diagnostic[:400])
            if status != 0:
                return [result("编译超时" if status is None else "编译错误", "", diagnostic) for _ in cases]
            runtime = [jdk / "bin" / ("java" + ext)] + vm + ["-Djava.security.manager",
                       "-Djava.security.policy==" + policy.as_uri(), "-cp", ".", "Main"]
            rows = []
            for case in cases:
                status, out, err = execute(box, runtime, case["input"], 5)
                actual = out[:LIMIT].decode("utf-8", "replace")
                if status and err.startswith(b"bwrap:"):
                    raise RuntimeError("Java 隔离环境不可用")
                reason = "超过运行限制" if status is None else "输出过长" if len(out)>LIMIT else "运行错误" if status else None
                rows.append(result(reason, actual, err[:4096].decode("utf-8","replace"), case))
            return rows
        finally:
            box.close()
