# 第三方运行时

本项目的应用源码与第三方组件是独立的作品；本文件不改变第三方原有许可，也不为应用源码另行指定开源许可证。

源码内的 WASI 文件：

- CPython 3.12 WASI：selfhost/judge/python.wasm；许可见同目录 PYTHON-LICENSE。来源：https://github.com/vmware-labs/webassembly-language-runtimes/releases/tag/python%2F3.12.0%2B20231211-040d5a6
- QuickJS WASI：selfhost/judge/qjs.wasm；许可见同目录 QUICKJS-LICENSE。上游：https://bellard.org/quickjs/

Windows x64 独立包包含：

| 运行时 | 当前打包版本 | 许可和来源 |
| --- | --- | --- |
| Node.js | 26.8.2 | runtime/node/LICENSE；https://nodejs.org/dist/v26.8.2/ |
| CPython | 3.12.10 | runtime/python/LICENSE.txt；https://www.python.org/downloads/release/python-31210/ |
| Eclipse Temurin JDK | 8u512 | runtime/jdk8/LICENSE、THIRD_PARTY_README 等随包文件；https://github.com/adoptium/temurin8-binaries/releases |
| MySQL Community | 8.4.13 | runtime/mysql/LICENSE 及相关随包许可；https://dev.mysql.com/downloads/mysql/8.4.html |

Python 扩展的许可、作者和包元数据保留在 runtime/python/Lib/site-packages 的 dist-info 等目录。运行包包含 wasmtime、pywin32、reportlab、pygments、pillow、charset-normalizer。查看这些组件的许可证后再做二次分发。

MySQL 对应版本的上游源码入口：https://downloads.mysql.com/archives/community/ ，选择 MySQL Community Server、8.4.13、Source Code。Node.js 对应版本源码：https://nodejs.org/dist/v26.8.2/node-v26.8.2.tar.gz 。Temurin 对应源代码入口：https://github.com/adoptium/jdk8u 。这些链接用于定位第三方上游，不能将本项目源码误认为 MySQL/JDK 的源代码。

源代码包不包含 Windows runtime；独立运行包保留第三方二进制原始许可证和元数据。
