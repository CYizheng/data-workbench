/* 数据工作台 —— 三块视图共用一份真实数据。
 *
 * 关键约束：页面上的每个数字都来自 SQLite 的真实执行结果，没有任何预置常量。
 * 数据库是 data/ledger.db（真文件），由 sql.js 编译成 WASM 后在浏览器里跑。
 * 口径层的 KPI 走 NLQ.buildSql 生成 SQL，与命令行版 nlq.py 同一套声明；
 * 图表用直白 SQL——它们是展示用的聚合，不是口径，硬套口径层反而是过度设计。
 */
(function () {
  'use strict';

  var state = {
    db: null,
    layer: null,
    audit: null,
    dataMax: null,
    ready: false,
    boardDone: false,
    auditDone: false
  };

  var $ = function (id) { return document.getElementById(id); };

  var EXAMPLES = [
    '本月各城市投递数',
    '近30天面试场次按月',
    '投递最多的前3个城市',
    '各岗位类型的面试场次前3',
    '在流程中的有多少家',
    '今年各月的投递趋势'
  ];

  /* ---------- 基础工具 ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function query(sql, maxRows) {
    maxRows = maxRows || 500;
    var stmt = state.db.prepare(sql);
    var cols = stmt.getColumnNames();
    var rows = [];
    var truncated = false;
    while (stmt.step()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(stmt.get());
    }
    stmt.free();
    return { cols: cols, rows: rows, truncated: truncated };
  }

  function scalar(sql) {
    var r = query(sql, 1);
    return r.rows.length ? r.rows[0][0] : null;
  }

  function fmtNum(v) {
    if (typeof v !== 'number') return String(v);
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
  }

  function setStatus(text, kind) {
    $('statusText').textContent = text;
    var dot = $('dot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
  }

  /* ---------- SQL 高亮 ---------- */

  var KW = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|LEFT JOIN|JOIN|ON|AS|AND|OR|DISTINCT|CASE|WHEN|THEN|ELSE|END|ASC|DESC)\b/g;
  var FN = /\b(COUNT|SUM|AVG|MIN|MAX|SUBSTR|CAST|ROUND)\b/g;

  function highlight(sql) {
    var html = esc(sql);
    html = html.replace(/(&#39;[^&]*?&#39;|'[^']*')/g, '<span class="str">$1</span>');
    html = html.replace(KW, '<span class="kw">$1</span>');
    html = html.replace(FN, '<span class="kw">$1</span>');
    return html;
  }

  /* ---------- 口径查询 ---------- */

  function todayFromInput() {
    var v = $('today').value;
    if (!v) return new Date();
    var p = v.split('-');
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function renderPlan(spec) {
    var tags = ['指标 · ' + spec.metric.name];
    if (spec.group) tags.push('分组 · ' + spec.group);
    spec.filters.forEach(function (f) { tags.push('过滤 · ' + f[0]); });
    if (spec.timeSql) tags.push('时间 · ' + spec.timeLabel);
    if (spec.orderDesc !== null) tags.push('排序 · ' + (spec.orderDesc ? '降序' : '升序'));
    if (spec.limit) tags.push('前 ' + spec.limit);

    $('resPlan').innerHTML = tags.map(function (t) {
      return '<span class="tag' + (t.indexOf('指标') === 0 ? '' : ' plain') + '">' + esc(t) + '</span>';
    }).join('');
  }

  function renderTable(cols, rows, truncated, ms) {
    var numeric = cols.map(function (_, i) {
      var vals = rows.map(function (r) { return r[i]; }).filter(function (v) { return v !== null; });
      return vals.length > 0 && vals.every(function (v) { return typeof v === 'number'; });
    });

    var head = '<tr>' + cols.map(function (c, i) {
      return '<th class="' + (numeric[i] ? 'num' : '') + '">' + esc(c) + '</th>';
    }).join('') + '</tr>';

    var body = rows.map(function (r) {
      return '<tr>' + r.map(function (v, i) {
        var cls = numeric[i] ? ' class="num"' : '';
        var text = numeric[i] ? fmtNum(v) : esc(v);
        return '<td' + cls + '>' + text + '</td>';
      }).join('') + '</tr>';
    }).join('');

    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
      '<div class="res-foot"><span>' + rows.length + ' 行' +
      (truncated ? ' · 已截断' : '') + '</span><span>' +
      (ms < 0.1 ? '< 0.1' : ms.toFixed(1)) + ' ms</span></div>';
  }

  function runQuery() {
    if (!state.ready) return;
    var q = $('question').value.trim();
    var body = $('resBody');

    if (!q) {
      $('resTitle').textContent = '还没有查询';
      $('resPlan').innerHTML = '';
      body.innerHTML = '<div class="empty">在左边输入一句中文，或点一个示例。</div>';
      $('sqlPanel').hidden = true;
      $('notePanel').hidden = true;
      return;
    }

    try {
      var spec = NLQ.parse(q, state.layer, todayFromInput());
      var sql = NLQ.buildSql(state.layer, spec, 200);

      var t0 = performance.now();
      var r = query(NLQ.checkSql(sql, 200), 200);
      var ms = performance.now() - t0;

      $('resTitle').textContent = q;
      renderPlan(spec);
      body.innerHTML = r.rows.length
        ? renderTable(r.cols, r.rows, r.truncated, ms)
        : '<div class="empty">解析成功，但在这个时间范围内没有数据。</div>';

      $('sqlPanel').hidden = false;
      $('sqlCode').innerHTML = highlight(sql);
      $('sqlMeta').textContent = r.rows.length + ' 行';

      $('notePanel').hidden = !spec.metric.note;
      $('noteText').textContent = spec.metric.note || '';

    } catch (e) {
      $('resTitle').textContent = q;
      $('resPlan').innerHTML = '';
      body.innerHTML = '<div class="err-box">' +
        (e.name === 'ParseError' ? '无法解析：' : '执行失败：') + esc(e.message) + '</div>';
      $('sqlPanel').hidden = true;
      $('notePanel').hidden = true;
    }
  }

  function renderDict() {
    var html = state.layer.metrics.map(function (m) {
      return '<div class="dict-item"><span class="k">' + esc(m.name) + '</span>' +
        '<span class="v">' + esc(m.aliases.slice(0, 5).join('、')) +
        (m.aliases.length > 5 ? ' …' : '') + '</span></div>';
    }).join('');

    var dims = state.layer.dimensions.map(function (d) { return d.name; }).join('、');
    html += '<div class="dict-item"><span class="k">维度</span><span class="v">' + esc(dims) + '</span></div>';

    var enums = Object.keys(state.layer.enums).map(function (k) {
      return state.layer.enums[k].values.join('、');
    }).join('；');
    html += '<div class="dict-item"><span class="k">状态</span><span class="v">' + esc(enums) + '</span></div>';

    $('dictList').innerHTML = html;
  }

  function renderChips() {
    $('chips').innerHTML = EXAMPLES.map(function (q) {
      return '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>';
    }).join('');

    $('chips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      $('question').value = b.getAttribute('data-q');
      runQuery();
    });
  }

  /* ---------- 守卫自测 ---------- */

  function tryGuard() {
    var sql = $('sandbox').value;
    var box = $('verdict');
    try {
      var checked = NLQ.checkSql(sql, 500);
      var r = query(checked, 5);
      box.className = 'verdict pass';
      box.textContent = '放行 → 补全后执行：\n' + checked + '\n返回 ' + r.rows.length + ' 行';
    } catch (e) {
      box.className = 'verdict block';
      box.textContent = '拦住 → ' + e.message;
    }
  }

  /* ---------- 一致性核查 ---------- */

  function renderAudit() {
    var a = state.audit;
    $('auditSource').textContent = a.files.length + ' 个文件 · ' +
      a.files.join('、') + ' · 生成于 ' + a.generated_at;

    var order = { high: 0, medium: 1, low: 2 };
    var list = a.findings.slice().sort(function (x, y) {
      return (order[x.severity] - order[y.severity]) || 0;
    });

    $('auditCounts').textContent = '共 ' + list.length + ' 个问题';

    $('findings').innerHTML = list.map(function (f, i) {
      var occ = f.occurrences && f.occurrences.length
        ? '<table class="occ"><thead><tr><th>原值</th><th>归一</th><th>文件</th><th>位置</th></tr></thead><tbody>' +
          f.occurrences.map(function (o) {
            return '<tr><td class="mono">' + esc(o.raw) + '</td><td class="mono">' + esc(o.norm) +
              '</td><td>' + esc(o.file) + '</td><td class="mono">' + esc(o.locator) + '</td></tr>';
          }).join('') + '</tbody></table>'
        : '';

      return '<details class="finding"' + (i === 0 ? ' open' : '') + '>' +
        '<summary><span class="sev ' + esc(f.severity) + '">' + esc(f.severity) + '</span>' +
        '<span class="ft">' + esc(f.title) + '</span>' +
        '<span class="ff">' + esc(f.field) + '</span></summary>' +
        '<div class="finding-body"><div class="detail">' + esc(f.detail) + '</div>' + occ + '</div>' +
        '</details>';
    }).join('');
  }

  /* ---------- 台账看板 ---------- */

  function metricValue(question) {
    var spec = NLQ.parse(question, state.layer, new Date());
    var sql = NLQ.buildSql(state.layer, spec, 1);
    var v = scalar(sql);
    return v === null ? 0 : v;
  }

  function kpi(label, value, unit) {
    return '<div class="kpi"><div class="lab">' + esc(label) + '</div>' +
      '<div class="val">' + esc(fmtNum(value)) + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div></div>';
  }

  function bars(host, rows, max) {
    host.innerHTML = rows.map(function (r) {
      var pct = max ? (r[1] / max) * 100 : 0;
      return '<div class="bar-row"><span class="bl">' + esc(r[0]) + '</span>' +
        '<span class="bt"><span class="bf" style="width:' + pct.toFixed(1) + '%"></span></span>' +
        '<span class="bv">' + fmtNum(r[1]) + '</span></div>';
    }).join('');
  }

  function renderBoard() {
    if (state.boardDone) return;
    state.boardDone = true;

    var total = metricValue('投递数');
    var active = metricValue('在流程中');
    var stalled = metricValue('泡池子');
    var reject = metricValue('已挂');
    var interviews = metricValue('面试场次');

    $('kpis').innerHTML =
      kpi('投递总数', total, '家') +
      kpi('在流程中', active, '家') +
      kpi('泡池子', stalled, '家') +
      kpi('面试场次', interviews, '场');

    var cities = query(
      'SELECT a.city, COUNT(DISTINCT a.id) AS c FROM applications a GROUP BY a.city ORDER BY c DESC LIMIT 9'
    );
    var maxC = cities.rows.length ? cities.rows[0][1] : 0;
    bars($('cityBars'), cities.rows, maxC);
    $('cityMeta').textContent = cities.rows.length + ' 个城市';

    var st = query('SELECT status, COUNT(*) AS c FROM applications GROUP BY status ORDER BY c DESC');
    var statusColors = ['s-0', 's-1', 's-2', 's-3'];
    var stTotal = st.rows.reduce(function (s, r) { return s + r[1]; }, 0);

    $('statusSplit').innerHTML = st.rows.map(function (r, i) {
      var pct = (r[1] / stTotal) * 100;
      return '<div class="bar-row"><span class="bl">' + esc(r[0]) + '</span>' +
        '<span class="bt"><span class="bf ' + (statusColors[i] || 's-3') + '" style="width:' +
        pct.toFixed(1) + '%"></span></span>' +
        '<span class="bv">' + r[1] + '</span></div>';
    }).join('');

    $('statusLegend').innerHTML = '<span>合计 <b>' + stTotal + '</b> 家</span>' +
      '<span>' + st.rows.length + ' 种状态</span>';

    var ms = query(
      "SELECT substr(a.applied_at,1,7) AS m, COUNT(*) AS c FROM applications a " +
      "GROUP BY m ORDER BY m ASC"
    );
    var maxM = Math.max.apply(null, ms.rows.map(function (r) { return r[1]; }).concat([1]));

    $('months').innerHTML = ms.rows.map(function (r) {
      var h = (r[1] / maxM) * 100;
      return '<div class="mcol"><span class="mval">' + r[1] + '</span>' +
        '<div class="mbar" style="height:' + h.toFixed(1) + '%"></div></div>';
    }).join('');

    $('mlabels').innerHTML = ms.rows.map(function (r) {
      return '<span>' + esc(String(r[0]).slice(2)) + '</span>';
    }).join('');
  }

  /* ---------- 视图切换 ---------- */

  function switchView(name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.getAttribute('data-view') === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-on', v.id === 'view-' + name);
    });

    if (!state.ready) return;
    if (name === 'board') renderBoard();
    if (name === 'audit' && !state.auditDone) { state.auditDone = true; renderAudit(); }
  }

  function viewFromHash() {
    var h = (location.hash || '').replace('#', '');
    return ['query', 'audit', 'board'].indexOf(h) !== -1 ? h : 'query';
  }

  /* ---------- 启动 ---------- */

  function initDate() {
    $('today').value = NLQ.iso(new Date());
  }

  function boot() {
    initDate();

    fetch('data/metrics.json').then(function (r) { return r.json(); }).then(function (layer) {
      state.layer = layer;
      renderDict();
      renderChips();

      return fetch('data/audit.json').then(function (r) { return r.json(); }).then(function (a) {
        state.audit = a;
      });
    }).then(function () {
      return initSqlJs({ locateFile: function (f) { return 'vendor/' + f; } });
    }).then(function (SQL) {
      return fetch('data/ledger.db').then(function (r) {
        if (!r.ok) throw new Error('ledger.db 读取失败：' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        state.db = new SQL.Database(new Uint8Array(buf));
      });
    }).then(function () {
      state.ready = true;
      state.dataMax = scalar('SELECT MAX(a.applied_at) FROM applications a');
      setStatus('SQLite 就绪 · ' + scalar('SELECT COUNT(*) FROM applications') + ' 条', 'ok');
      $('dataNote').textContent = '演示数据截止 ' + state.dataMax +
        '；基准日期不是那天时，「本月」「近30天」这类时间词会落到空区间，这是对的。';
      $('question').value = EXAMPLES[0];
      runQuery();
      switchView(viewFromHash());
    }).catch(function (e) {
      state.ready = false;
      setStatus('加载失败', 'err');
      var box = document.createElement('div');
      box.className = 'err-box';
      box.textContent = '初始化失败：' + e.message +
        '（本地打开需要起一个静态服务：python -m http.server）';
      $('resultPanel').appendChild(box);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelector('.tabs').addEventListener('click', function (e) {
      var t = e.target.closest('.tab');
      if (!t) return;
      var name = t.getAttribute('data-view');
      switchView(name);
      if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    });

    window.addEventListener('hashchange', function () { switchView(viewFromHash()); });

    $('run').addEventListener('click', runQuery);
    $('question').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runQuery(); }
    });
    $('today').addEventListener('change', runQuery);
    $('tryGuard').addEventListener('click', tryGuard);

    boot();
  });
})();
