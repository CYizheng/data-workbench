/* 问句 → 查询规划 → SQL → 守卫。四个纯函数，同一条链，放在一个文件里。
 *
 * 移植自 metric-layer/metriclayer/{parse,sqlgen,guard}.py，逻辑逐条对齐：
 * 词表命中取「最长别名」、时间词优先于限额、限额必须带量词或出现在句尾。
 * 改动时两边要一起改，否则命令行和网页给出的数会不一样——那正是这个项目要消灭的问题。
 */
(function (global) {
  'use strict';

  var CN_NUM = {
    '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
  };

  function ParseError(message) {
    this.name = 'ParseError';
    this.message = message;
  }
  ParseError.prototype = Object.create(Error.prototype);

  function cnInt(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return Object.prototype.hasOwnProperty.call(CN_NUM, s) ? CN_NUM[s] : null;
  }

  function iso(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function monthRange(today, offset) {
    offset = offset || 0;
    var y = today.getFullYear();
    var m = today.getMonth() + 1 + offset;
    while (m <= 0) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    var start = new Date(y, m - 1, 1);
    var end = m === 12 ? new Date(y + 1, 0, 1) : new Date(y, m, 1);
    return [start, end];
  }

  function frag(col, s, e) {
    return col + " >= '" + iso(s) + "' AND " + col + " < '" + iso(e) + "'";
  }

  function parseTime(q, layer, today) {
    var col = layer.time.field;
    var m;

    if ((m = q.match(/(?:近|前|过去)\s*(\d+|[一二两三四五六七八九十])\s*天/))) {
      var n = cnInt(m[1]) || 7;
      var start = new Date(today.getTime());
      start.setDate(start.getDate() - n);
      return [col + " >= '" + iso(start) + "'", '近 ' + n + ' 天'];
    }
    if (/近一周|本周内|这一周/.test(q)) {
      var s1 = new Date(today.getTime());
      s1.setDate(s1.getDate() - 7);
      return [col + " >= '" + iso(s1) + "'", '近 7 天'];
    }
    if (/本月|这个月|当月/.test(q)) {
      var a = monthRange(today, 0);
      return [frag(col, a[0], a[1]), a[0].getFullYear() + ' 年 ' + (a[0].getMonth() + 1) + ' 月'];
    }
    if (/上月|上个月/.test(q)) {
      var b = monthRange(today, -1);
      return [frag(col, b[0], b[1]), b[0].getFullYear() + ' 年 ' + (b[0].getMonth() + 1) + ' 月'];
    }
    if (/今年|本年度/.test(q)) {
      var y = today.getFullYear();
      return [frag(col, new Date(y, 0, 1), new Date(y + 1, 0, 1)), y + ' 年'];
    }
    if (/去年|上一年/.test(q)) {
      var y2 = today.getFullYear() - 1;
      return [frag(col, new Date(y2, 0, 1), new Date(y2 + 1, 0, 1)), y2 + ' 年'];
    }
    if ((m = q.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/))) {
      var yy = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (mm >= 1 && mm <= 12) {
        var c = monthRange(new Date(yy, mm - 1, 1), 0);
        return [frag(col, c[0], c[1]), yy + ' 年 ' + mm + ' 月'];
      }
    }
    if ((m = q.match(/(\d{4})-(\d{2})(?!-)/))) {
      var y3 = parseInt(m[1], 10), m3 = parseInt(m[2], 10);
      if (m3 >= 1 && m3 <= 12) {
        var d3 = monthRange(new Date(y3, m3 - 1, 1), 0);
        return [frag(col, d3[0], d3[1]), y3 + ' 年 ' + m3 + ' 月'];
      }
    }
    return ['', '全部时间'];
  }

  function matchMetric(q, layer) {
    var best = null;
    layer.metrics.forEach(function (m) {
      m.aliases.forEach(function (a) {
        if (q.indexOf(a) !== -1 && (!best || a.length > best.len)) {
          best = { len: a.length, metric: m };
        }
      });
    });
    if (!best) {
      throw new ParseError('没认出指标。口径层里已定义：' +
        layer.metrics.map(function (m) { return m.name; }).join('、'));
    }
    return best.metric;
  }

  function matchGroup(q, layer) {
    var best = null;
    layer.dimensions.forEach(function (d) {
      d.aliases.forEach(function (a) {
        if (q.indexOf(a) !== -1 && (!best || a.length > best.len)) {
          best = { len: a.length, key: d.key };
        }
      });
    });
    return best ? best.key : null;
  }

  function parse(question, layer, today) {
    var q = (question || '').trim();
    if (!q) throw new ParseError('问句为空');
    today = today || new Date();

    var spec = {
      question: q,
      metric: matchMetric(q, layer),
      group: null,
      filters: [],
      orderDesc: null,
      limit: null,
      timeSql: '',
      timeLabel: '全部时间',
      hits: {}
    };
    spec.hits.metric = spec.metric.name;

    var group = matchGroup(q, layer);
    if (group === null) {
      if (/趋势|变化|走势|分布|按月|各月/.test(q)) {
        for (var i = 0; i < layer.dimensions.length; i += 1) {
          if (layer.dimensions[i].default_true) { group = layer.dimensions[i].key; break; }
        }
      }
    }
    spec.group = group;

    var t = parseTime(q, layer, today);
    spec.timeSql = t[0];
    spec.timeLabel = t[1];

    Object.keys(layer.enums).forEach(function (ename) {
      var edef = layer.enums[ename];
      for (var j = 0; j < edef.values.length; j += 1) {
        var v = edef.values[j];
        if (q.indexOf(v) !== -1) {
          spec.filters.push([ename + '=' + v, edef.column + " = '" + v + "'"]);
          spec.hits[ename] = v;
          break;
        }
      }
    });

    if (/最多|最高|最大|排名|排行/.test(q)) spec.orderDesc = true;
    else if (/最少|最低|最小/.test(q)) spec.orderDesc = false;

    var m;
    if ((m = q.match(/前\s*(\d+|[一二两三四五六七八九十])\s*(?:名|个|家|位|条)/))) {
      spec.limit = cnInt(m[1]);
    } else if ((m = q.match(/前\s*(\d+|[一二两三四五六七八九十])\s*$/))) {
      spec.limit = cnInt(m[1]);
    } else if ((m = q.match(/top\s*(\d+)/i))) {
      spec.limit = parseInt(m[1], 10);
    }

    if (spec.limit && spec.orderDesc === null) spec.orderDesc = true;
    return spec;
  }

  function describe(spec) {
    var bits = ['指标=' + spec.metric.name];
    if (spec.group) {
      bits.push('分组=' + spec.group);
    }
    if (spec.filters.length) {
      bits.push('过滤=' + spec.filters.map(function (f) { return f[0]; }).join('；'));
    }
    if (spec.timeSql) bits.push('时间=' + spec.timeLabel);
    if (spec.orderDesc !== null) bits.push('排序=' + (spec.orderDesc ? '降序' : '升序'));
    if (spec.limit) bits.push('前 ' + spec.limit);
    return bits.join(' · ');
  }

  function fromClause(layer, spec) {
    var base = 'FROM ' + layer.tables.main + ' ' + layer.tables.main_alias;
    if (spec.metric.needs_events) {
      if (!layer.tables.events) {
        throw new ParseError('指标「' + spec.metric.name + '」需要事件表，但口径层没有声明 tables.events');
      }
      base += '\nLEFT JOIN ' + layer.tables.events + ' ' + layer.tables.events_alias +
        ' ON ' + layer.tables.events_on;
    }
    return base;
  }

  function whereClause(layer, spec) {
    var conds = [];
    if (spec.timeSql) conds.push(spec.timeSql);
    spec.filters.forEach(function (f) { conds.push(f[1]); });
    if (spec.metric.needs_events && spec.metric.event_filter) conds.push(spec.metric.event_filter);
    if (!conds.length) return '';
    return 'WHERE ' + conds.join('\n  AND ');
  }

  function dimension(layer, key) {
    for (var i = 0; i < layer.dimensions.length; i += 1) {
      if (layer.dimensions[i].key === key) return layer.dimensions[i];
    }
    return null;
  }

  function buildSql(layer, spec, defaultLimit) {
    defaultLimit = defaultLimit || 200;
    var metricSql = spec.metric.expr;
    var parts;

    if (spec.group) {
      var dim = dimension(layer, spec.group);
      if (!dim) throw new ParseError('未知维度：' + spec.group);
      var select = 'SELECT ' + dim.column + ' AS "' + dim.name + '",\n' +
        '       ' + metricSql + ' AS "' + spec.metric.name + '"';
      var order;
      if (dim.time_grain) order = 'ORDER BY 1 ASC';
      else if (spec.orderDesc === null) order = 'ORDER BY 2 DESC';
      else order = 'ORDER BY 2 ' + (spec.orderDesc ? 'DESC' : 'ASC');

      parts = [
        select,
        fromClause(layer, spec),
        whereClause(layer, spec),
        'GROUP BY ' + dim.column,
        order,
        'LIMIT ' + (spec.limit || defaultLimit)
      ];
    } else {
      parts = [
        'SELECT ' + metricSql + ' AS "' + spec.metric.name + '"',
        fromClause(layer, spec),
        whereClause(layer, spec),
        'LIMIT 1'
      ];
    }
    return parts.filter(Boolean).join('\n');
  }

  /* ---------- 只读守卫 ---------- */

  var FORBIDDEN = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace',
    'attach', 'detach', 'pragma', 'vacuum', 'analyze', 'reindex',
    'begin', 'commit', 'rollback', 'savepoint', 'release', 'trigger'
  ];

  function stripComments(sql) {
    return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  }

  function stripLiterals(sql) {
    var out = '';
    var i = 0;
    var n = sql.length;
    while (i < n) {
      var ch = sql[i];
      if (ch === "'" || ch === '"') {
        var quote = ch;
        i += 1;
        while (i < n) {
          if (sql[i] === quote) {
            if (i + 1 < n && sql[i + 1] === quote) { i += 2; continue; }
            break;
          }
          i += 1;
        }
        out += "''";
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    }
    return out;
  }

  function checkSql(sql, defaultLimit) {
    defaultLimit = defaultLimit || 500;
    if (!sql || !sql.trim()) throw new ParseError('SQL 为空');

    var body = stripComments(sql).trim().replace(/;+$/, '').trim();
    if (!body) throw new ParseError('SQL 里只有注释');

    var bare = stripLiterals(body);
    if (bare.indexOf(';') !== -1) throw new ParseError('只允许单条语句，检测到分号分隔的多条语句');

    var tokens = bare.match(/[A-Za-z_]+/g) || [];
    var head = tokens.length ? tokens[0].toLowerCase() : '';
    if (head !== 'select' && head !== 'with') {
      throw new ParseError('只允许 SELECT / WITH 查询，检测到以 "' + head + '" 开头');
    }

    var words = (bare.toLowerCase().match(/[A-Za-z_]+/g) || []);
    var seen = {};
    words.forEach(function (w) { seen[w] = true; });
    var bad = FORBIDDEN.filter(function (w) { return seen[w]; });
    if (bad.length) throw new ParseError('包含被禁止的关键字：' + bad.join('、'));

    if (!/\blimit\b/.test(bare.toLowerCase())) body = body + '\nLIMIT ' + defaultLimit;
    return body;
  }

  global.NLQ = {
    ParseError: ParseError,
    parse: parse,
    describe: describe,
    buildSql: buildSql,
    checkSql: checkSql,
    iso: iso
  };
})(window);
