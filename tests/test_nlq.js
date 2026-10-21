/* 前端端口的行为测试。直接 node tests/test_nlq.js，无依赖。
 *
 * 这些用例与 metric-layer/tests/test_core.py 对齐——两边的解析器必须给出同样的
 * 结论，否则同一个问句在命令行和网页上会得到不同的数，那正是这个项目要消灭的事。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'assets', 'nlq.js'), 'utf8');
const layer = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'metrics.json'), 'utf8'));

// nlq.js 是浏览器脚本，挂在 window 上；这里造一个假 window 把它接出来
global.window = {};
new Function('window', src)(global.window);
const NLQ = global.window.NLQ;

let pass = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? '  ← ' + extra : ''));
}

function eq(name, actual, expected) {
  ok(name, actual === expected, '实际 ' + JSON.stringify(actual) + ' 期望 ' + JSON.stringify(expected));
}

const TODAY = new Date(2026, 9, 21); // 2026-10-21

function P(q) { return NLQ.parse(q, layer, TODAY); }
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

console.log('解析 · 指标与维度');
{
  const s = P('本月各城市投递数');
  eq('本月各城市投递数 → 指标', s.metric.key, 'applications');
  eq('本月各城市投递数 → 分组', s.group, 'city');
  eq('本月各城市投递数 → 时间标签', s.timeLabel, '2026 年 10 月');
  ok('本月各城市投递数 → 时间条件落在 10-01', s.timeSql.indexOf('2026-10-01') !== -1, s.timeSql);
}
{
  const s = P('近30天面试场次按月');
  eq('近30天面试场次按月 → 指标', s.metric.key, 'interviews');
  eq('近30天面试场次按月 → 分组', s.group, 'month');
  ok('近30天面试场次按月 → 需要事件表', s.metric.needs_events === true);
  ok('近30天面试场次按月 → 限额为空', s.limit === null, '限额 ' + s.limit);
}
{
  const s = P('投递最多的前3个城市');
  eq('投递最多的前3个城市 → 分组', s.group, 'city');
  eq('投递最多的前3个城市 → 限额', s.limit, 3);
  eq('投递最多的前3个城市 → 排序', s.orderDesc, true);
}
{
  // 「前30天」里的 30 是时间长度，不是条数。这一条在 Python 版是 bug，这里钉死。
  const s = P('前30天的投递数');
  ok('前30天不被当成限额', s.limit === null, '限额 ' + s.limit);
  ok('前30天被当成时间', s.timeLabel === '近 30 天', '时间标签 ' + s.timeLabel);
}
{
  const s = P('在流程中的有多少家');
  eq('在流程中的有多少家 → 指标', s.metric.key, 'active');
  ok('在流程中的有多少家 → 带状态过滤',
    s.filters.length === 1 && s.filters[0][1].indexOf("'流程中'") !== -1,
    JSON.stringify(s.filters));
}
{
  const s = P('今年各月的投递趋势');
  eq('今年各月的投递趋势 → 分组取默认时间维', s.group, 'month');
  eq('今年各月的投递趋势 → 时间标签', s.timeLabel, '2026 年');
}
{
  const s = P('各岗位类型的笔试场次前3');
  eq('各岗位类型的笔试场次前3 → 指标', s.metric.key, 'exams');
  eq('各岗位类型的笔试场次前3 → 分组', s.group, 'category');
}
{
  const e = throws(function () { P('帮我算算天气'); });
  ok('词典外问句抛 ParseError', e !== null && e.name === 'ParseError', e && e.message);
}
{
  const s = P('投递数');
  eq('无分组时 group 为空', s.group, null);
}

console.log('SQL 生成');
{
  const sql = NLQ.buildSql(layer, P('投递最多的前3个城市'));
  ok('分组查询带 GROUP BY', sql.indexOf('GROUP BY a.city') !== -1, sql);
  ok('分组查询带 LIMIT 3', sql.indexOf('LIMIT 3') !== -1, sql);
  ok('按指标降序', sql.indexOf('ORDER BY 2 DESC') !== -1, sql);
}
{
  const sql = NLQ.buildSql(layer, P('近30天面试场次按月'));
  ok('事件指标带 LEFT JOIN', sql.indexOf('LEFT JOIN events e') !== -1, sql);
  ok('关联条件不是 None', sql.indexOf('ON e.app_id = a.id') !== -1, sql);
  ok('带事件类型过滤', sql.indexOf("e.kind = '面试'") !== -1, sql);
  ok('时间维度按自身升序', sql.indexOf('ORDER BY 1 ASC') !== -1, sql);
}
{
  const sql = NLQ.buildSql(layer, P('投递数'));
  ok('无分组补 LIMIT 1', /LIMIT\s+1\s*$/.test(sql), sql);
}

console.log('只读守卫 · 该拦的');
[
  ['DROP TABLE applications', '小写 drop 也要拦'],
  ['delete from events', '小写 delete 也要拦'],
  ['UPDATE applications SET status = 1', 'UPDATE 要拦'],
  ['SELECT * FROM applications; DROP TABLE events', '多语句要拦'],
  ['PRAGMA table_info(applications)', 'PRAGMA 要拦'],
  ["ATTACH DATABASE 'x.db' AS x", 'ATTACH 要拦'],
  ['INSERT INTO events VALUES (1)', 'INSERT 要拦']
].forEach(function (c) {
  const e = throws(function () { NLQ.checkSql(c[0]); });
  ok('拦住：' + c[1], e !== null, e ? '' : '被放行了');
});

console.log('只读守卫 · 该放的');
[
  ["SELECT * FROM applications WHERE note = 'drop table now'", '字面量里的 drop 不算'],
  ['SELECT 1 -- drop table x', '注释里的 drop 不算'],
  ["SELECT * FROM applications WHERE note = 'it''s ok'", '转义引号不该让剥离器跑偏']
].forEach(function (c) {
  const e = throws(function () { NLQ.checkSql(c[0]); });
  ok('放行：' + c[1], e === null, e && e.message);
});
{
  const out = NLQ.checkSql('SELECT * FROM applications');
  ok('缺 LIMIT 时自动补', /\bLIMIT 500\b/.test(out), out);
}
{
  const out = NLQ.checkSql('SELECT * FROM applications LIMIT 5');
  ok('已有 LIMIT 不重复补', (out.match(/\bLIMIT\b/g) || []).length === 1, out);
}

console.log('');
if (fails.length) {
  console.log('共 ' + (pass + fails.length) + ' 项：通过 ' + pass + '，失败 ' + fails.length);
  fails.forEach(function (f) { console.log('  [失败] ' + f); });
  process.exit(1);
}
console.log('共 ' + pass + ' 项：全部通过');
