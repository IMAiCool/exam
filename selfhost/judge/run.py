"""Run the selected language and return bounded per-case diagnostics as UTF-8 JSON."""
import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LIMIT = 65536

def result(reason, actual="", diagnostic="", sample=None):
    def normalize(text):
        return text.replace("\r\n", "\n").rstrip("\n")
    if reason is None:
        reason = "通过" if normalize(actual) == normalize(sample["output"]) else "输出不符"
    return {"status": reason, "actual": actual, "diagnostic": diagnostic[:4096]}

def run(engine, module, linker, program, sample, language):
    import wasmtime as wasm
    with tempfile.TemporaryDirectory() as temp, wasm.Store(engine) as store:
        stdin = Path(temp) / "stdin"
        stdin.write_bytes(sample["input"].encode("utf-8"))
        wasi = wasm.WasiConfig()
        if language == "JavaScript":
            prelude = """
const [readline,require,process]=((input)=>{
  const lines=input.split(/\\r?\\n/); if(lines.at(-1)==='') lines.pop();
  let cursor=0;
  function readFileSync(fd,encoding) {
    if(fd!==0) throw Error('仅支持标准输入');
    if(encoding) return input;
    const bytes=Uint8Array.from(unescape(encodeURIComponent(input)),c=>c.charCodeAt(0));
    bytes.toString=()=>input; return bytes;
  }
  return [()=>lines[cursor++], name=>{
    if(name==='fs'||name==='node:fs') return {readFileSync};
    throw Error('不支持模块 '+name);
  },{stdout:{write:s=>std.out.puts(String(s))}}];
})(INPUT);
"""
            wasi.argv = ["qjs", "--std", "-e", prelude.replace("INPUT", json.dumps(sample["input"])) + "\n(()=>{\n" + program + "\n})();"]
        else:
            wasi.argv = ["python", "-I", "-B", "-c", program]
        wasi.stdin_file = str(stdin)
        output, errors = bytearray(), bytearray()
        def capture(buf, maximum):
            def write(data):
                buf.extend(data[:max(0, maximum - len(buf))])
                return len(data)
            return write
        wasi.stdout_custom = capture(output, LIMIT + 1)
        wasi.stderr_custom = capture(errors, 4096)
        store.set_limits(memory_size=96 * 1024 * 1024)
        store.set_fuel(2_000_000_000)
        store.set_wasi(wasi)
        instance = linker.instantiate(store, module)
        reason = None
        try:
            instance.exports(store)["_start"](store)
        except wasm.ExitTrap as error:
            if error.code:
                reason = "运行错误"
        except wasm.Trap as error:
            reason = "超过运行限制" if error.trap_code == wasm.TrapCode.OUT_OF_FUEL else "运行错误"
        if len(output) > LIMIT:
            reason = "输出过长"
        return result(reason, output[:LIMIT].decode("utf-8", "replace"), errors.decode("utf-8", "replace"), sample)

def main():
    request = json.loads(sys.stdin.buffer.read())
    language = request["language"]
    if language == "Java":
        sys.path.insert(0, str(ROOT))
        from java8 import run_java
        rows = run_java(request["code"], request["cases"], result)
    else:
        import wasmtime as wasm
        config = wasm.Config()
        config.consume_fuel = True
        config.cache = True
        engine = wasm.Engine(config)
        module = wasm.Module.from_file(engine, str(ROOT / {"Python":"python.wasm", "JavaScript":"qjs.wasm"}[language]))
        linker = wasm.Linker(engine)
        linker.define_wasi()
        rows = [run(engine, module, linker, request["code"], case, language) for case in request["cases"]]
    print(json.dumps(rows))

if __name__ == "__main__":
    # The Node runner decodes diagnostics from this pipe as UTF-8 on every OS.
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
