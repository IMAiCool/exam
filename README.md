# 阶段考试系统

[各平台初始化与使用](docs/初始化与使用.md) · [源码仓库](https://github.com/IMAiCool/exam)

账号、试卷、答卷、密钥和本地运行时不在源码仓库中。源码压缩包不等于完整 Windows 独立运行包。

## 跨平台运行

在 Windows、macOS 或 Linux 上准备好支持 Linux 容器的 Docker 和 Compose v2，在项目目录执行：

```sh
docker compose up -d --build
docker compose exec exam node scripts/check-judge.mjs
```

打开 [考试系统登录页](http://localhost:8787/login)。自检通过应用的判题入口分别运行 Python、JavaScript、Java 8 和 SQL/MySQL，每种语言包含两组用例，预期均为 10/10 分。首次部署到空数据库时，创建账号并记录命令输出的随机密码：

```sh
docker compose exec exam node selfhost/account.mjs admin administrator
docker compose exec exam node selfhost/account.mjs student student01
```

网站镜像包含 Node.js、SQLite 和 PDF 生成依赖。编程判题使用三个独立容器：wasi-worker 提供随镜像打包的 Python/JavaScript WASI 运行时，java-worker 提供 Java 8，mysql-worker 提供 MySQL 8.4。所有判题通过内部套接字调用，不使用宿主机的 Python、Node.js、JDK 或 MySQL；判题服务不可用会报错，不回退宿主机。Java 容器关闭网络，使用只读根文件系统和有容量限制的临时目录。站点数据保存在 Compose 的 `exam-data` 命名卷。首次构建需联网下载镜像和依赖，普通考试和编程判题之后可离线运行。使用 AI 辅助解析时，可在项目的 `.env` 中设置 `DEEPSEEK_API_KEY`。

若原服务占用 8787，可在 `.env` 中写入 `EXAM_PORT=8788`，访问 `http://localhost:8788/login` 并行核验。新卷会从空数据库开始。

### 离线部署与数据迁移

在与目标机器 CPU 架构相同的构建机上执行：

```sh
docker compose build
docker image save -o exam-images.tar exam-web:local exam-java8:local exam-wasi:local exam-mysql:local
```

将 `exam-images.tar` 和 `compose.yaml` 放到目标机器的同一目录，执行：

```sh
docker image load -i exam-images.tar
docker compose up -d --no-build --pull never
docker compose exec exam node scripts/check-judge.mjs
```

镜像和考试数据单独迁移。备份时先停止源网站，原生部署复制完整的 `selfhost/data`，容器部署可使用 `docker compose cp exam:/data/. ./exam-backup` 导出数据库和答卷归档。恢复到新机器时，在首次启动前将备份复制到空的 `exam-data` 卷根目录，确保容器的 `node` 用户（UID 1000）可读写。采用 HTTPS 对外提供服务的步骤见下文。

### 学生电脑上的 Windows 置顶题目卡片

将项目的 `windows-card` 文件夹复制到学生电脑。准备包含 Tk 的 Python 3，在 PowerShell 运行安装脚本，地址填学生实际打开的考试网站（含端口）。

```powershell
.\windows-card\install.ps1 -ExamOrigin 'http://192.0.2.10:8787'
```

脚本安装到当前用户目录，准备 Pillow，启动本机助手并加入当前用户的登录启动项。助手仅监听本机回环地址，接受配置的考试网站发来的题目卡片图像。学生打开简答题或编程题，点击「题目卡片」后即可切到其他应用查看置顶题目。拖动浮窗可调整位置，回到考试窗口会自动收起。助手不可用时使用浏览器画中画；浏览器要求手势时，切出前点击卡片上的「系统置顶」。

## 前端目录

- `worker/exam.html` 是考试页面模板，按顺序引用 `worker/styles/` 下的样式表。
- `base.css`、`layout.css` 和 `appearance.css` 管理基础样式、页面布局和主题外观。`catalog.css`、`editor.css`、`account.css` 和 `controls.css` 管理试卷目录、编辑器、账号页面和共享控件。
- 自托管服务和 Sites 构建共用这些样式。修改源文件后，自托管服务需重启，Sites 需重新运行 `node scripts/build.mjs`。导出的 HTML 试卷会内嵌样式，方便离线使用。

## 可选的 Windows 原生运行

完整 Windows 运行包使用 runtime/node/node.exe；裸源码需先按初始化文档制作 runtime。首次运行不会创建默认账号；先通过服务器命令创建管理员，再登录管理教师和学生。再次启动沿用已有数据库。

```powershell
.\runtime\node\node.exe selfhost/account.mjs admin administrator --password
.\start.cmd
```

每位学生应有独立账号，可用 `node selfhost/account.mjs student student01` 增加账号。

打开 http://127.0.0.1:8787 。教师在「教师组卷」中填写题数与默认分值，点击「应用」后编辑题干、选项和逐题分值。合计须等于目标总分。「保存试卷」保存浏览器草稿，「发布给学生」创建独立的试卷版本。每次发布保留旧版及其交卷记录。HTML 和 Markdown 可离线阅读，JSON 沿用原有交换格式。

教师也可在「上传试卷」选择本网站格式的 JSON 文件，点击「上传并发布」。上传或从编辑器发布成功后会显示唯一的数字编号，之后可在「试卷目录」找回。发布给「全部学生」的试卷会出现在所有学生的目录中；发布给自己的学生或指定分组时，目录按对应范围展示。学生在「我的试卷」中按编号查找，或从「待作答试卷」进入考试；「已做试卷」列出本人正式交卷的试卷，点击标题可查看原答卷。再次点击已选项即可取消。未提交的答案保存在当前浏览器。每个学生每版可正式交卷一次，登录同一账号可再次打开已交答卷和下载 PDF。教师的「学生考试」页供本机试答。

教师也可上传 .md 或 .markdown，点击「解析并填入组卷」。支持按题型分节、按三级标题分题、字母选项和围栏代码块。未写分值时使用组卷表中的各题型默认分值。未识别的题目会交给 DeepSeek 整理，教师核对后再发布。启动服务前设置环境变量 `DEEPSEEK_API_KEY` 即可启用 AI，可用 `EXAM_AI_MODEL` 指定模型。密钥仅在服务端使用。

学生交卷时自动生成按整卷题号（从 1 开始）填写的 JSON 答题卡，并附试卷编号、作答版本。单选和多选用选项字母，判断用 T/F，多空按顺序保存，编程题保留语言和代码。新生成的答卷归档保存答题卡，教师评卷和 AI 判分从数据库按试卷编号及作答版本读取原题和参考答案。教师公布最终成绩后，学生可在试卷封面下载 PDF，其中包含原题、作答、参考答案及最终得分，代码块按语言高亮。Windows 独立运行包已包含 reportlab 和 pygments，维护者可显式指定 EXAM_PDF_PYTHON。Windows 使用微软雅黑和 Consolas，Linux 使用文泉驿正黑和 DejaVu Sans Mono，Docker 镜像已配置这些依赖。

在「教师组卷 → 试卷设置」中可逐卷勾选「启用 AI 自动评分」，默认开启，旧版试卷沿用开启状态。设置随试卷版本保存。已配置 `DEEPSEEK_API_KEY` 且该版试卷启用 AI 时，新交卷（含到时自动交卷）会触发以下题目的 AI 辅助评分：未设参考答案的单选、多选、判断题，以及所有填空和简答题。系统按作答时的试卷版本，将单题题干、题干代码、满分、参考答案及学生作答发送给 DeepSeek。填空按空、简答按要点给分。教师在评卷页刷新后可查看建议分与依据，调整后公布成绩。缺少参考答案的客观题先由 AI 根据题干、代码和选项推断答案，再按整题匹配给分；无参考答案的填空和简答题由 AI 独立解题后逐空或按要点初评，最终成绩须由教师确认并公布。服务失败会自动重试，连续三次失败后转人工评分。

本地数据库默认位于 `selfhost/data`，可通过 `EXAM_DATA` 指定目录；备份时停止服务后复制整个数据目录。旧版 Sites 构建仍使用 `node scripts/build.mjs`，自托管服务直接读取 worker 源文件。

## Docker、Nginx 和 HTTPS

以下命令用于部署阶段的 Linux 主机，假设已安装 Docker Compose、宿主机 Nginx 及带 nginx 插件的 Certbot。将项目置于服务器，域名 A 记录及已配置的 AAAA 记录需指向该主机，开放公网 80、443。

```sh
docker compose up -d --build
docker compose exec exam node selfhost/account.mjs admin administrator
docker compose exec exam node selfhost/account.mjs student student01
sudo install -m 644 selfhost/exam.nginx.conf /etc/nginx/conf.d/exam.example.com.conf
sudo nginx -t && sudo systemctl reload nginx
curl -I -X GET http://exam.example.com/login
sudo certbot --nginx --redirect -d exam.example.com
sudo certbot renew --dry-run
```

首次安装 Nginx 配置时确认目标文件名可用。签发后保留 Certbot 写入的 TLS 配置。Compose 只在主机回环地址开放应用端口，HTTPS 模式下登录 Cookie 带 Secure 标记。账号、发布版本与答卷保存在命名卷 exam-data。官方安装和续期说明见 [Certbot Nginx 指南](https://certbot.eff.org/instructions?ws=nginx&os=snap)。



### 编程题测试与评分

教师可给每道编程题添加最多 12 组标准输入和预期输出。Markdown 试卷中成对的“输入示例”和“输出示例”代码块可直接识别。Python、JavaScript 和 Java 8 程序按标准输入输出测试。每个用例独立运行，按通过比例计分，保留两位小数。比较输出时统一换行符，忽略结尾换行，保留其余空格。

学生可在交卷前试跑，逐组查看输入、预期输出、实际输出、通过状态和错误信息。交卷后服务会用最终代码重新判分，教师可以修改并公布成绩。其他语言、缺少用例的编程题保留人工评分。

独立运行包使用 `runtime/python/python.exe` 及其随包扩展，不从系统 PATH 查找 Python。构建运行包时安装固定版本 `wasmtime==50.0.1`。Python 和 JavaScript 在独立 WASI 实例内运行。随项目分发的 [CPython 3.12 WASI 运行时](https://github.com/vmware-labs/webassembly-language-runtimes/releases/tag/python%2F3.12.0%2B20231211-040d5a6) 位于 `selfhost/judge/python.wasm`，SHA-256 为 `e5dc5a398b07b54ea8fdb503bf68fb583d533f10ec3f930963e02b9505f7a763`。

JavaScript 使用 QuickJS-NG v0.18.0，支持用 `readline()` 逐行读取，或用 `require("fs").readFileSync(0, "utf8")` 读取全部输入，用 `console.log()` 或 `process.stdout.write()` 输出。运行时来自 [QuickJS-NG 发布页](https://github.com/quickjs-ng/quickjs/releases/tag/v0.18.0)。

Java 8 使用完整 JDK 8，在默认包中编写 `Main` 类和 `public static void main(String[] args)`。每次试跑或交卷判题编译一次，每组用例启动独立 JVM。可通过 `EXAM_JAVA8_HOME` 指定 JDK 目录。

- Windows 服务使用 AppContainer 和作业对象。为判题解释器安装 `pywin32`，随包的 JDK 8 位于 `runtime/jdk8`，并授予应用容器对该 JDK 的读取执行权限，例如在 PowerShell 中运行 `icacls "runtime\jdk8" /grant '*S-1-15-2-1:(OI)(CI)(RX)'`。
- Linux 原生部署使用 bubblewrap 隔离文件和网络。Compose 部署使用独立 Java 容器，相关运行依赖由镜像提供。


## 三类账号与账号管理

身份为 admin（管理员）、teacher（教师）、student（学生）。旧版本教师身份自动迁移为 teacher，旧学生身份迁移为 student。前端关闭公开注册。管理员登录后进入 /management，可创建教师和学生、分组、修改密码、生成重置码及删除账号和关联记录。删除需要确认。教师通过管理学生创建或绑定学生。

管理员仅由服务器维护，在项目目录执行以下命令。创建时加 --password 会隐藏输入并要求确认，密码为 8 至 128 字符。省略该选项随机生成密码。

```powershell
node selfhost/account.mjs admin administrator --password
node selfhost/account.mjs teacher teacher01 --password
node selfhost/account.mjs student student01 --password
node selfhost/account.mjs list
node selfhost/account.mjs reset administrator
node selfhost/account.mjs delete administrator
```

修改已有管理员密码时，在服务器生成重置码，然后访问 /reset-password 输入新密码。Docker 部署时在命令前加 docker compose exec exam。管理员身份不能通过前端创建、删除或变更。

批量学生导入位于管理员账号管理页，支持 UTF-8 CSV、TSV 和从电子表格复制粘贴。列顺序为账号、姓名、密码、分组，可以带同名表头。逐行密码优先，其次使用页面默认密码，均为空时逐个生成随机密码。导入完成会显示账号与密码供保存。重复账号或无效行会报错。示例

```csv
账号,姓名,密码,分组
student01,张同学,,一班
student02,李同学,ExamplePass123,二班
```

当前分组为管理员的账号分类，教师的教学分组仍通过管理学生维护。

## MySQL 编程题运行测试

编程题选择 SQL 语言后可运行 MySQL 用例。教师在“示例输入”中填写建表、INSERT 等初始化 SQL，在“预期输出”中填写查询结果。输出不包含列名，多列使用制表符分隔，多行使用换行分隔，NULL 显示为 NULL。需要稳定排序时在学生 SQL 中使用 ORDER BY。只有预期输出的用例也受支持，例如 SELECT 1。

每次测试启动独立 MySQL 实例，每组用例开始前创建 exam_db 数据库，显式指定 CHARACTER SET utf8mb4、COLLATE utf8mb4_0900_ai_ci，用例完成后删除，下组重新创建。连接及服务器默认字符集均为 utf8mb4，并使用受限账号。学生账号只有该用例数据库权限，不授予 FILE 或全局管理权限，禁用 LOCAL INFILE。每条客户端执行限时 6 秒、输出上限 1 MB，SELECT 默认执行限时 3 秒。测试完毕关闭实例并清理临时数据。首次初始化可能需要数秒。

独立运行包使用 `runtime/mysql/bin/mysql.exe` 和 `runtime/mysql/bin/mysqld.exe`，不从系统 PATH 查找 MySQL。Docker Compose 使用 mysql-worker 服务并通过内部 Unix socket 调用，MySQL 工作容器无外部网络，配置了内存、CPU 和进程限制。更新容器使用 docker compose up -d --build。

SQL 学生运行、教师评卷运行及交卷后的编程题自动判分复用同一 MySQL 判题入口。最终成绩仍由教师确认公布。

## 自定义题型与代码内填空

教师进入“试卷操作”，点击“自定义题型”，填写名称并选择首个答题组件。创建后，每个组件下方提供添加单选、多选、判断、填空、简答和编程组件的按钮，可在同一命名题型下混合组合。每个组件独立填写题干、分值、参考答案和学生答题内容，题型总分为组件分值之和。组件沿用题干代码块、选项增删、填空插入及编程测试用例等编辑工具。删除组件使用“删除此题”。相同名称的组件归入同一题型。

JSON 保留 customType 字段。Markdown 为自定义组件写入“自定义题型”和“答题组件”说明，回读时恢复名称和答题方式。学生概览、题目导航、教师评卷和已评答卷 PDF 使用自定义题型名称。

填空题代码块中，“〔填空〕”或独立的三个以上连续下划线会显示为可输入空位。学生仅能填写空位，其余代码只读。多个空按题干和代码块出现顺序提交，兼容自动保存与评分。标识符中的下划线（例如 __init__）保持代码文本。

## 题干表格与文件导入

所有题型的题干下方均有“插入表格”。表格默认两行两列，首行为表头，单元格支持多行文本。教师可添加或移除末行、末列，也可移除整张表格。每题最多 10 张表格，每表最多 50 行、20 列。学生端和评卷页显示只读表格；JSON、Markdown、HTML 及已评答卷 PDF 保留表格内容。

“文件导入”位于“试卷操作”弹窗内，包含全量／增量导入方式、普通试卷、带参考答案试卷、单独参考答案及模板下载。

导出 Markdown 和 HTML 试卷时，每题附带空白作答位置。选择题填写选项字母，判断题填写 T/F，填空题按 ①②③ 对应各空；简答和编程题按小题编号分别留空，编程答题区保留语言类型。JSON 导出包含空白 answerCard，题号与原试卷顺序对应。重新导入 Markdown 时，作答留白不会成为题干、参考答案或测试用例。

普通试卷导入还支持本系统导出的 HTML。HTML 内嵌经过校验的试卷结构，用于恢复题号、分值、代码、表格和用例；普通 HTML 导出不包含教师参考答案。MD 和 HTML 每题仅保留一处作答位置，简答小题留空使用 txt 代码块。普通和带答案的 MD／JSON 模板已同步提供小题、表格、代码内填空和编号测试用例示例。

## 多题共用题干

教师在“试卷操作”中点击“共用题干”，输入整卷题号（例如 1,2,4-6）和共用材料，再点击“应用共用题干”。所选题目共用同一段材料，各自保留题目、分值、作答区和参考答案。重新填写相同题号可更新材料，材料留空可移除所选题目的共用题干。

学生逐题作答和题目卡片显示共用材料，教师评卷及 PDF 也携带该材料。AI 初评请求同时传入共用材料、本题题干、表格和代码。JSON、HTML 保留 sharedStem 字段，Markdown 通过“共用题干／本题题干”区块保存并回读。
## SQL 自动补全

SQL 编辑器内置从 MySQL 8.4 的 INFORMATION_SCHEMA.KEYWORDS 读取的 734 个关键字快照；输入时按前缀匹配，不区分大小写，不需要联网。题干代码块、SQL 参考答案与学生 SQL 作答框共用补全逻辑。上下键选择，Enter 或 Tab 插入，Escape 关闭。

另提供 SELECT、INSERT、UPDATE、DELETE、CREATE TABLE、ALTER TABLE、JOIN、GROUP BY、ORDER BY、事务和窗口语句模板，以及 COUNT、COALESCE、JSON_EXTRACT 等常用函数模板。模板会选中首个待填写位置并保留当前缩进。关键字快照不等于所有数据库对象的自动发现，表名、字段名不会从服务端数据库自动拉取。

## 长试卷页面性能

组题页对屏幕外题目延迟布局和绘制。连续输入时自动保存合并为停顿 180 毫秒后执行，持续输入约每 1 秒保存一次；离开页面、页面隐藏、断网及字段变更提交时立即保存。未选择壁纸动效的新用户默认静态，已保存的动态设置继续生效。

公开 CSS 和网站图标支持 gzip 压缩及 ETag 条件缓存，每次使用前校验版本；账号页面、答题内容仍使用 no-store。补全固定词库仅初始化一次，候选位置的滚动更新按动画帧合并。

## 各语言补全范围

题干代码块、参考答案和学生作答框共用补全逻辑，当前支持 Python、JavaScript、Java、HTML、CSS、SQL、JSON。上下键选择，Enter/Tab 插入，Escape 关闭；保留已有多行模板缩进和首个待填写位置。

| 语言 | 支持的补全来源 |
| --- | --- |
| Python | 关键字、内置函数；已有标准库索引及导入别名；常见内置类型、部分标准库类实例的方法和属性；当前代码中函数、参数、自定义类及 self/cls 成员 |
| JavaScript | 关键字、浏览器内置对象、常见实例类型及 DOM 继承成员；已有模块索引中的 ES module/CommonJS 导入和别名；对象字面量、自定义类成员及代码标识符 |
| Java | 关键字、常用内置类、集合/字符串/Scanner 等成员；已有包索引、通配符和静态导入；代码中显式类型变量、自定义类成员 |
| SQL | MySQL 8.4 关键字、常用函数和语句模板；同一编辑框 CREATE TABLE 中的表名、列名及 FROM/JOIN 别名，不访问外部数据库探测结构 |
| HTML | 标签、常用属性、自定义元素、代码中的 id/class 名；HTML 本身不具有包导入和对象方法 |
| CSS | 浏览器支持的属性名、常用属性值、语法模板、当前代码的自定义属性与选择器；不读取远端 @import 样式 |
| JSON | true/false/null、对象/数组模板、当前代码的对象字段；JSON 本身没有方法或包导入 |

此功能是内置索引加静态分析，不是完整的语言服务器或类型检查器。未收录的第三方包、外部文件、运行时动态属性和复杂链式返回类型不能保证完整识别；不会下载或执行导入内容。候选不能替代各语言编译器或运行测试的检查。

## MySQL 判题实例池与排队

SQL 判题现在默认预启动 1 个隔离 MySQL 实例，按 FIFO 队列分配任务，不再每次点击运行都重新初始化 MySQL。每个实例同一时刻只执行一个任务；每组用例重新创建 exam_db，字符集 utf8mb4，使用随机密码的受限临时账号；运行后终止该账号残留连接、删除库和账号并检查清理结果。健康检查或清理失败、运行中取消及任务总超时会丢弃实例，下一任务重新启动实例。不同学生即使使用同名库、同名表也不会共用表数据。

学生和教师运行测试时可看到排队位置、准备数据库或运行状态。同一账号只能有一个试跑请求；SQL 请求最多接收 32 个前台并发等待/执行请求，队列满仍会拒绝。Python、JavaScript、Java 保持原来的最多 3 个同时试跑账号限制。排队是服务端完成，不要求学生手动分批重试。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| EXAM_MYSQL_POOL_SIZE | 1 | 常驻实例数，可设 1～3 |
| EXAM_MYSQL_QUEUE_LIMIT | 32 | 实例池最大等待任务数，可设 1～100；前台另有 32 请求保护 |
| EXAM_MYSQL_QUEUE_TIMEOUT_MS | 60000 | 排队最长等待时间，允许 1000～300000 毫秒 |
| EXAM_MYSQL_TASK_TIMEOUT_MS | 90000 | 单任务总执行时间上限，允许 1000～180000 毫秒，不包含预热和排队 |

原生部署通过服务进程环境变量设置；Compose 可在项目 .env 中设置上述参数，执行 docker compose up -d --build 加载。默认 mysql-worker 的 768MB 内存和 512MB 临时文件系统按单实例配置；提高实例数时，必须同步评估并调整内存、临时目录容量和 CPU。不要只增加实例数。

2 核 2GB 且运行 AdGuard Home 的机器先保留单实例，再在目标机压测。开发机的低延迟不能替代目标服务器验收。队列保存在内存中，服务重启会中断正在等待/运行的试跑，学生可重试；已有作答自动保存机制不受影响。浏览器断开请求会取消对应任务，关闭结果弹窗本身仍仅关闭弹窗。

Linux 实例使用各自的数据目录、端口、Unix socket 和 PID 文件。Windows 关闭 MySQL 自带监控进程，并由独立看护进程在父进程退出时关闭数据库和清理目录，正常停止则由实例池主动关闭。

示例 Nginx 配置增加了 240 秒的读写超时，以支持排队请求。已经部署的反向代理也应同步设置适当超时，并保留已有 HTTPS/Certbot 配置；如果上调排队或任务超时，需要一并调整代理超时。

## 学生 SQL 权限边界

学生只能操作 exam_db 中的表、字段、索引和记录；允许普通建表、删表、ALTER TABLE、增删改查、事务及本库表结构查询。禁止创建/删除数据库、ALTER DATABASE/SCHEMA、切换其他数据库、显式读取系统库、账号和授权管理、全局设置、文件/表空间操作。

不再授予 GRANT ALL ON exam_db.*。库级只保留数据及建表所需的有限权限；ALTER/DROP 仅按已校验的具体表名授予表级权限，包含脚本内新建和重命名的目标表，不给数据库本体 ALTER/DROP 权限。表名在授权语句中进行标识符转义。

执行前解析整个 SQL 批次的字符串、标识符、注释和语句边界，拦截库级命令。为防止绕过校验，PREPARE/EXECUTE、存储程序、触发器/事件、可执行版本注释和客户端命令不开放；SQL 解析模式、连接字符集等设置也不允许由脚本修改。普通注释和字符串里的 SQL 文字不作为命令执行。MySQL 基础连接/版本函数仍可返回有限的诊断信息。

用例初始化 SQL 同样受限，应使用普通表结构及数据语句；系统内部建库、重置字符集和清理仍由独立管理员连接执行，学生拿不到其凭据。每次脚本最多预授权 128 个明确的表名；不支持动态生成表名的脚本。Docker 镜像已包含相同校验模块。


## 编程判题环境与宿主机的关系

正式部署请使用上面的 Docker Compose 方式，宿主机只需 Docker/Compose，不需安装任何语言解释器、JDK、MySQL 或 Python 包。首次构建需要联网，之后可按离线迁移步骤携带四个镜像运行。容器内的运行时是部署组成部分，并非调用宿主机环境。

Python、JavaScript、Java 和 SQL/MySQL 支持运行测试；HTML、CSS、JSON 是编辑语言，目前没有编程判题执行器，不会冒充执行成功。数据库仍为每次用例重置的 exam_db，字符集 utf8mb4。

原生独立运行现已支持随包运行时：Windows x64 使用项目根目录的 `start.cmd`，无需 Docker，也无需安装 Node、Python、JDK 或 MySQL。缺失随包运行环境时明确报错，不会自动查找系统 PATH。现有数据库继续使用 selfhost/data。

可以在空白环境启动后执行 `docker compose exec exam node scripts/check-judge.mjs` 验证四种可执行语言。所有容器的内存上限之和不是实际内存占用，但并发判题仍可能超过 2GB 机器容量；镜像打包不消除运行资源需求。


## Windows x64 独立运行包（无需 Docker）

当前项目的 `runtime` 目录已包含 Node、Python 与判题/PDF 依赖、JDK 8、MySQL 8.4。保留该目录及项目文件，双击根目录 `start.cmd` 启动。整个项目可复制到其他 Windows x64 机器，不必安装这些语言环境。启动脚本为随包 JDK 设置学生隔离运行所需的读取权限；运行账号需拥有项目目录写入权限。学生数据库是程序临时创建的独立实例，不使用目标机器已安装的数据库。

随包结构：`runtime/node/node.exe`、`runtime/python/python.exe`、`runtime/jdk8`、`runtime/mysql`。Python/JavaScript 学生程序仍在项目内 WASI 运行时中执行，Java 仍受 Windows AppContainer 和作业对象限制。HTML/CSS/JSON 仅编辑，不存在判题执行器。操作系统组件和系统字体不属于语言环境。

维护者在构建机上重新制作运行包时，在干净的项目副本执行（目标 runtime 目录必须不存在；构建阶段需要联网下载 Python 扩展）：

```powershell
./scripts/build-portable.ps1 -PythonHome '构建机Python312目录' -JavaHome '构建机JDK8目录' -MySQLHome '构建机MySQL8.4目录'
```

构建脚本将运行时实体复制进项目，不使用符号链接或指向安装目录的虚拟环境。最终用户不执行此构建步骤。此独立包当前验证范围为 Windows x64；Linux/macOS 需要另外打包对应平台运行时与隔离组件，不能使用 Windows exe。运行测试无需联网，AI 评分仍需访问模型服务。

验收：清空 PATH 后，用 `runtime/node/node.exe scripts/check-judge.mjs` 可自检四种可执行语言。2026-11-24 已在清空 PATH 的服务环境中实测 8787，四种语言各两组用例均通过。
