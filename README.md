# 数据工作台 · data-workbench

三个各自能跑的东西 —— **口径层查询**、**材料一致性核查**、**台账看板** ——
放在一个页面里，共用一个前端、一份数据。

重点是那句容易含混的话：**页面上每个数字都是 SQLite 真实执行的结果。**

不是预置的截图，也不是写死的 JSON。数据库是 `data/ledger.db`（真文件），
由 [sql.js](https://github.com/sql-js/sql.js)（SQLite 编译成 WASM）在浏览器里加载，
问句经口径层翻译成 SQL，跑出来的就是表里显示的那个数。

---

## 三个视图

### 1. 口径查询

输入一句中文，得到**结果 + 用的 SQL + 这条数的口径**。

```
输入：投递最多的前3个城市
解析：指标 · 投递数   分组 · city   排序 · 降序   前 3
```

生成的 SQL：

```sql
SELECT a.city AS "城市",
       COUNT(DISTINCT a.id) AS "投递数"
FROM applications a
GROUP BY a.city
ORDER BY 2 DESC
LIMIT 3
```

三条信息一起给，是为了让「这个数能不能信」变成一个可判断的问题——
只看结果无法反驳，看到 SQL 和口径才能说「不对，你说的投递数包括已放弃的」。

词典是封闭的：指标名、维度名、状态值都写在声明里，命中即用。
所以不会出现「同一个问句今天和明天给不同答案」。

### 2. 一致性核查

同一套求职材料里，同一个字段在不同文件里是不是同一个值。

演示里 5 个问题全部来自真实运行结果：

| 字段 | 问题 |
|---|---|
| 毕业时间 | `2027-06` 与 `2027-07` 两个取值 |
| 手机号 | 1 处不符合声明格式；另有 1 处疑似漏字 |
| 软著登记号 | 疑似数字转置（字符组成相同，顺序不同） |
| 本科专业 | 两个取值 |

「数字转置」和「漏字」是两回事，修法完全不同，所以判定要分开给结论。
这条判断逻辑在 [consistency-audit](https://github.com/CYizheng/consistency-audit) 里，
这里只做展示层。

### 3. 台账看板

投递总数、在流程中、泡池子、面试场次，加城市分布、状态构成、月度节奏。

前四个 KPI **走的是口径层**——`buildSql()` 生成 SQL 后执行，和页面上「口径查询」
是同一套声明。图表用直白 SQL：它们是展示用的聚合，不是口径，
硬套口径层反而是过度设计。

---

## 只读是三层，不是一句 `if`

页面上有个折叠面板可以自己试：把 `DROP TABLE applications` 丢给守卫，看它拦不拦。

| 层 | 手段 | 兜住什么 |
|---|---|---|
| 连接层 | 浏览器里是内存副本，刷新即还原；命令行版用 `mode=ro` 打开文件 | 关掉页面就等于放弃所有改动 |
| 语句层 | 只放行单条 `SELECT`/`WITH`；禁用 `INSERT/UPDATE/DELETE/DROP/ATTACH/PRAGMA` 等 | 注入与误操作 |
| 结果层 | 没有 `LIMIT` 就自动补；结果行数封顶 | 一条误写把内存打爆 |

判断前先**剥掉注释和字符串字面量**，否则字段值里出现 `drop` 就会被误杀：

```sql
SELECT * FROM applications WHERE note = 'drop table now'   -- 该放行
SELECT 1 -- drop table x                                    -- 该放行
```

这两条都有测试钉着。

---

## 一次真实的自我修正

写前端测试时撞到一个案例：`前30天的投递数`。

原来的时间正则只认 `近30天`，`前30天` 不匹配；而限额正则要求带量词或出现在句尾，
`前30天` 也不匹配。结果是**时间不生效、限额也不生效，静默返回全量数据**。

比报错更糟——报错至少知道错了。改成 `(?:近|前|过去)\s*N\s*天` 后，
同一个问句返回 37 家，与手工核对一致。

这条修复同时进了 Python 版和前端版，两个仓库各自加了用例。
两个解析器给出不同结论，正是这个项目要消灭的事。

---

## 文件结构

```
index.html              单页应用
assets/
  nlq.js                问句 → 查询规划 → SQL → 守卫（移植自 metric-layer 的 Python 版）
  app.js                三个视图的渲染与交互
  style.css             视觉语言，见 DESIGN.md
data/
  ledger.db             真实 SQLite 文件，128 条投递 / 232 条事件（虚构数据）
  metrics.json          口径层编译产物，由 tools/compile_metrics.py 从 yaml 生成
  audit.json            一致性核查结果
vendor/
  sql-wasm.js/.wasm     sql.js（本地化，不依赖 CDN）
tools/
  compile_metrics.py    口径层 yaml → json
tests/
  test_nlq.js           41 项，直接 node 跑，无依赖
```

## 跑起来

```bash
python -m http.server 8791
# 打开 http://127.0.0.1:8791/
```

必须走 HTTP，不能双击 `index.html`：`fetch` 在 `file://` 下被浏览器拒绝。
页面会给出明确提示，不会白屏。

改了口径层 yaml 之后要重编译，否则页面用的还是旧口径：

```bash
python tools/compile_metrics.py metrics.yaml -o data/metrics.json
```

## 测试

```bash
node tests/test_nlq.js
# 共 41 项：全部通过
```

覆盖解析（指标/维度/时间/限额/状态过滤）、SQL 生成（GROUP BY、JOIN、排序、LIMIT）、
守卫（7 条该拦的、3 条该放的）。

## 与另外两个仓库的关系

| 仓库 | 管什么 |
|---|---|
| [metric-layer](https://github.com/CYizheng/metric-layer) | 口径写成声明，CLI 版取数 |
| [consistency-audit](https://github.com/CYizheng/consistency-audit) | 定义有没有被写对 |
| **data-workbench** | 前两者共用一个界面，让「能点开」代替「能说明」 |

前两个是命令行工具，面试官不会装 Python。这个仓库存在的唯一理由就是：
**把「我说我会做」换成「你自己点一下」。**

## 设计

视觉规则写在 [DESIGN.md](DESIGN.md)——顺便验证一件常被忽略的事：
AI 生成的界面之所以一眼就假，通常不是因为配色难看，而是**间距没有节奏、层级没有差别**。
DESIGN.md 就是把这类规则写成 agent 能读的约束，而不是留在脑子里。

## 许可

MIT。演示数据由脚本生成，与任何真实单位、个人无对应关系。
