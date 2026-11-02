/* ==========================================================================
   CASHEW INTERACTIVE SVG CHARTS & CALENDAR HEATMAP
   Ported from Cashew fl_chart widgets & homePageHeatmap.dart
   ========================================================================== */

window.CashewCharts = {
  /* Smooth Cubic-Bezier Area Line Chart (HomePageLineGraph / NetWorth) */
  renderAreaLineSVG(points, options = {}) {
    const width = options.width || 560;
    const height = options.height || 175;
    const padX = 16;
    const padTop = 20;
    const padBottom = 28;
    const strokeColor = options.color || 'var(--primary)';
    const symbol = options.symbol || '$';
    const gradId = 'cashewGrad_' + Math.random().toString(36).slice(2, 8);

    if (!points || points.length === 0) {
      return `<div class="empty-cashew" style="padding:24px 10px;">Sin movimientos suficientes para graficar</div>`;
    }

    const data = points.length === 1
      ? [{ label: 'Inicio', value: points[0].value }, points[0]]
      : points;

    const vals = data.map(p => Number(p.value) || 0);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    if (minV === maxV) {
      minV -= 10;
      maxV += 10;
    }
    const range = maxV - minV;
    const innerW = width - padX * 2;
    const innerH = height - padTop - padBottom;

    const coords = data.map((p, i) => {
      const x = padX + (i / (data.length - 1)) * innerW;
      const y = padTop + innerH - ((p.value - minV) / range) * innerH;
      return { x, y, label: p.label, value: p.value };
    });

    let dPath = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[i];
      const p1 = coords[i + 1];
      const cpx = ((p0.x + p1.x) / 2).toFixed(1);
      dPath += ` C ${cpx} ${p0.y.toFixed(1)}, ${cpx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
    }

    const last = coords[coords.length - 1];
    const first = coords[0];
    const areaPath = `${dPath} L ${last.x.toFixed(1)} ${(padTop + innerH).toFixed(1)} L ${first.x.toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;

    const gridLines = [0, 0.5, 1].map(t => {
      const gy = (padTop + innerH * t).toFixed(1);
      return `<line x1="${padX}" y1="${gy}" x2="${width - padX}" y2="${gy}" stroke="var(--divider)" stroke-dasharray="4 4" stroke-width="1"/>`;
    }).join('');

    const step = Math.max(1, Math.floor((coords.length - 1) / 4));
    const labelsSVG = coords
      .filter((_, idx) => idx === 0 || idx === coords.length - 1 || idx % step === 0)
      .map(c => `<text x="${c.x.toFixed(1)}" y="${height - 7}" fill="var(--text-muted)" font-size="10.5" font-weight="600" text-anchor="middle">${c.label}</text>`)
      .join('');

    const dotsSVG = coords
      .filter((_, idx) => idx === coords.length - 1 || coords.length <= 10)
      .map((c, idx, arr) => {
        const isLast = idx === arr.length - 1;
        return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${isLast ? 5 : 3}" fill="${strokeColor}" stroke="var(--bg-card)" stroke-width="2">
          <title>${c.label}: ${symbol}${Number(c.value).toFixed(2)}</title>
        </circle>`;
      }).join('');

    return `
      <div class="chart-container">
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" style="overflow:visible;">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.34"/>
              <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.0"/>
            </linearGradient>
          </defs>
          ${gridLines}
          <path d="${areaPath}" fill="url(#${gradId})" />
          <path d="${dPath}" fill="none" stroke="${strokeColor}" stroke-width="3.2" stroke-linecap="round" />
          ${dotsSVG}
          ${labelsSVG}
        </svg>
      </div>
    `;
  },

  /* Cashew Circular Profit & Loss Chart (Ganancia y Pérdida Circular Donut) */
  renderProfitLossRingSVG(incomeRaw, expenseRaw, fmtFn) {
    const inc = Math.max(0, Number(incomeRaw) || 0);
    const exp = Math.max(0, Number(expenseRaw) || 0);
    const total = inc + exp;
    const net = inc - exp;
    const fmt = typeof fmtFn === 'function'
      ? fmtFn
      : (v) => (v < 0 ? '-$' + Math.abs(v).toFixed(2) : '$' + Number(v).toFixed(2));

    const size = 204;
    const cx = size / 2;
    const cy = size / 2;
    const r = 74;
    const circumference = 2 * Math.PI * r;

    if (total <= 0) {
      return `
        <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:20px; padding:10px 4px;">
          <div style="position:relative; width:${size}px; height:${size}px; flex-shrink:0;">
            <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
              <circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" stroke="var(--bg-input)" stroke-width="24"/>
            </svg>
            <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
              <span style="font-size:11.5px; color:var(--text-muted); font-weight:700;">Sin movimientos</span>
              <span style="font-size:18px; font-weight:800;">${fmt(0)}</span>
            </div>
          </div>
          <div style="flex:1; min-width:200px; color:var(--text-muted); font-size:13px;">
            Registra ingresos o gastos en este período para visualizar el gráfico circular de Ganancia y Pérdida.
          </div>
        </div>
      `;
    }

    const incPct = inc / total;
    const expPct = exp / total;
    const gap = (inc > 0 && exp > 0) ? 5 : 0;

    const incLen = Math.max(0, incPct * circumference - gap);
    const expLen = Math.max(0, expPct * circumference - gap);

    const savingsRate = inc > 0 ? Math.round(((inc - exp) / inc) * 100) : -100;
    const isProfit = net >= 0;

    return `
      <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:22px;">
        <div style="position:relative; width:${size}px; height:${size}px; flex-shrink:0;">
          <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" stroke="var(--bg-input)" stroke-width="24"/>
            ${inc > 0 ? `
              <circle
                cx="${cx}" cy="${cy}" r="${r}"
                fill="transparent"
                stroke="var(--cashew-income)"
                stroke-width="24"
                stroke-dasharray="${incLen.toFixed(2)} ${(circumference - incLen).toFixed(2)}"
                stroke-dashoffset="0"
                stroke-linecap="round"
                transform="rotate(-90 ${cx} ${cy})"
              >
                <title>Ingresos: +${fmt(inc)} (${(incPct * 100).toFixed(1)}%)</title>
              </circle>
            ` : ''}
            ${exp > 0 ? `
              <circle
                cx="${cx}" cy="${cy}" r="${r}"
                fill="transparent"
                stroke="var(--cashew-expense)"
                stroke-width="24"
                stroke-dasharray="${expLen.toFixed(2)} ${(circumference - expLen).toFixed(2)}"
                stroke-dashoffset="${(-(incPct * circumference)).toFixed(2)}"
                stroke-linecap="round"
                transform="rotate(-90 ${cx} ${cy})"
              >
                <title>Gastos: -${fmt(exp)} (${(expPct * 100).toFixed(1)}%)</title>
              </circle>
            ` : ''}
          </svg>
          <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; pointer-events:none; padding:0 18px;">
            <span style="font-size:11px; color:var(--text-muted); font-weight:800; text-transform:uppercase; letter-spacing:0.04em;">
              ${isProfit ? 'Ganancia Neta' : 'Pérdida Neta'}
            </span>
            <span style="font-size:19px; font-weight:800; letter-spacing:-0.02em; color:${isProfit ? 'var(--cashew-income)' : 'var(--cashew-expense)'};">
              ${isProfit ? '+' : ''}${fmt(net)}
            </span>
            <span style="font-size:11px; color:var(--text-muted); font-weight:700; margin-top:2px;">
              ${inc > 0 ? `${savingsRate >= 0 ? '+' : ''}${savingsRate}% margen` : 'Solo gastos'}
            </span>
          </div>
        </div>

        <div style="flex:1; min-width:210px; display:flex; flex-direction:column; gap:10px;">
          <div style="background:var(--bg-elevated); border-radius:15px; padding:11px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="display:flex; align-items:center; gap:9px;">
              <span style="width:12px; height:12px; border-radius:4px; background:var(--cashew-income);"></span>
              <div>
                <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Ingresos Totales</div>
                <div style="font-size:15.5px; font-weight:800; color:var(--cashew-income);">+${fmt(inc)}</div>
              </div>
            </div>
            <span class="status-chip available">${(incPct * 100).toFixed(1)}%</span>
          </div>

          <div style="background:var(--bg-elevated); border-radius:15px; padding:11px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="display:flex; align-items:center; gap:9px;">
              <span style="width:12px; height:12px; border-radius:4px; background:var(--cashew-expense);"></span>
              <div>
                <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Gastos Totales</div>
                <div style="font-size:15.5px; font-weight:800; color:var(--cashew-expense);">-${fmt(exp)}</div>
              </div>
            </div>
            <span class="status-chip out">${(expPct * 100).toFixed(1)}%</span>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between; padding:2px 6px; font-size:12.5px; color:var(--text-muted); font-weight:700;">
            <span>Resultado del período:</span>
            <strong style="color:${isProfit ? 'var(--cashew-income)' : 'var(--cashew-expense)'};">
              ${isProfit ? 'Superávit ' + '+' + fmt(net) : 'Déficit ' + fmt(net)}
            </strong>
          </div>
        </div>
      </div>
    `;
  },

  /* Cashew Category Donut Chart (HomePagePieChart) */
  renderDonutSVG(slices, centerLabel = 'Total', centerVal = '$0.00', fmtFn = null) {
    const total = slices.reduce((acc, s) => acc + (Number(s.value) || 0), 0);
    const fmt = typeof fmtFn === 'function' ? fmtFn : (v) => '$' + Number(v).toFixed(2);

    if (total <= 0) {
      return `<div class="empty-cashew" style="padding:26px 12px;">
        <span class="material-symbols-rounded">donut_large</span>
        <div>Sin datos en este período</div>
      </div>`;
    }

    const size = 194;
    const cx = size / 2;
    const cy = size / 2;
    const r = 70;
    const circumference = 2 * Math.PI * r;
    let offsetAccum = 0;

    const circles = slices.map(s => {
      const pct = s.value / total;
      const segLen = Math.max(0, pct * circumference - (slices.length > 1 ? 3 : 0));
      const dashArray = `${segLen.toFixed(2)} ${(circumference - segLen).toFixed(2)}`;
      const dashOffset = (-offsetAccum).toFixed(2);
      offsetAccum += pct * circumference;
      return `<circle
        cx="${cx}" cy="${cy}" r="${r}"
        fill="transparent"
        stroke="${s.color || '#5f85c2'}"
        stroke-width="22"
        stroke-dasharray="${dashArray}"
        stroke-dashoffset="${dashOffset}"
        stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})"
      >
        <title>${s.name}: ${fmt(s.value)} (${(pct * 100).toFixed(1)}%)</title>
      </circle>`;
    }).join('');

    return `
      <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:20px;">
        <div style="position:relative; width:${size}px; height:${size}px; flex-shrink:0;">
          <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" stroke="var(--bg-input)" stroke-width="22"/>
            ${circles}
          </svg>
          <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; pointer-events:none;">
            <span style="font-size:11.5px; color:var(--text-muted); font-weight:700;">${centerLabel}</span>
            <span style="font-size:17.5px; font-weight:800; letter-spacing:-0.02em;">${centerVal}</span>
          </div>
        </div>
        <div style="flex:1; min-width:195px; display:flex; flex-direction:column; gap:8px;">
          ${slices.slice(0, 7).map(s => {
            const pct = ((s.value / total) * 100).toFixed(1);
            return `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:13px;">
                <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                  <span style="width:11px; height:11px; border-radius:4px; background:${s.color}; flex-shrink:0;"></span>
                  <span style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${s.name}</span>
                </div>
                <div style="font-weight:800; white-space:nowrap;">
                  ${fmt(s.value)} <span style="color:var(--text-muted); font-size:11.5px; font-weight:600;">(${pct}%)</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  },

  /* Cashew Multi-Month Calendar Heatmap (Ported from homePageHeatmap.dart) */
  renderCashewHeatmapHTML(dailyMap, options = {}) {
    const weeksCount = options.weeks || 22; // ~5 months
    const fmt = typeof options.fmtFn === 'function'
      ? options.fmtFn
      : (v) => (v < 0 ? '-$' + Math.abs(v).toFixed(2) : '$' + Number(v).toFixed(2));

    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Align grid start to Monday `weeksCount - 1` weeks ago
    const dayOfWeekMon0 = (today.getDay() + 6) % 7; // Mon=0 .. Sun=6
    const endSunday = new Date(today);
    endSunday.setDate(today.getDate() + (6 - dayOfWeekMon0));

    const startMonday = new Date(endSunday);
    startMonday.setDate(endSunday.getDate() - (weeksCount * 7 - 1));

    // Find max positive and max negative daily net for intensity scaling
    let maxPos = 0;
    let maxNeg = 0;
    for (const info of Object.values(dailyMap || {})) {
      if (!info) continue;
      if (info.net > maxPos) maxPos = info.net;
      if (info.net < 0 && Math.abs(info.net) > maxNeg) maxNeg = Math.abs(info.net);
    }
    if (maxPos <= 0) maxPos = 100;
    if (maxNeg <= 0) maxNeg = 100;

    const getIntensityClass = (info) => {
      if (!info || info.count === 0) return 'hm-empty';
      if (Math.abs(info.net) < 0.01) return 'hm-neutral';
      if (info.net > 0) {
        const ratio = info.net / maxPos;
        if (ratio > 0.72) return 'hm-inc-4';
        if (ratio > 0.42) return 'hm-inc-3';
        if (ratio > 0.16) return 'hm-inc-2';
        return 'hm-inc-1';
      } else {
        const ratio = Math.abs(info.net) / maxNeg;
        if (ratio > 0.72) return 'hm-exp-4';
        if (ratio > 0.42) return 'hm-exp-3';
        if (ratio > 0.16) return 'hm-exp-2';
        return 'hm-exp-1';
      }
    };

    const monthShortNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const weeks = [];
    let lastLabeledMonth = -1;

    const cursor = new Date(startMonday);
    for (let w = 0; w < weeksCount; w++) {
      const days = [];
      let monthHeader = '';
      for (let d = 0; d < 7; d++) {
        const yyyy = cursor.getFullYear();
        const mm = String(cursor.getMonth() + 1).padStart(2, '0');
        const dd = String(cursor.getDate()).padStart(2, '0');
        const iso = `${yyyy}-${mm}-${dd}`;
        const isFuture = iso > todayISO;

        if (cursor.getDate() <= 7 && cursor.getMonth() !== lastLabeledMonth) {
          monthHeader = monthShortNames[cursor.getMonth()];
          lastLabeledMonth = cursor.getMonth();
        }

        const info = (dailyMap && dailyMap[iso]) || { net: 0, income: 0, expense: 0, count: 0 };
        const prettyDay = cursor.toLocaleDateString('es-ES', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        });

        const tip = info.count > 0
          ? `${prettyDay} • ${info.net >= 0 ? '+' : ''}${fmt(info.net)} (${info.count} mov${info.count === 1 ? '' : 's'})`
          : `${prettyDay} • Sin movimientos`;

        days.push({
          iso,
          dayNum: cursor.getDate(),
          isToday: iso === todayISO,
          isFuture,
          cls: isFuture ? 'hm-future' : getIntensityClass(info),
          tip
        });

        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push({ monthHeader, days });
    }

    const weekDayLabels = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

    return `
      <div class="cashew-heatmap-wrap">
        <div class="cashew-heatmap-scroll">
          <div class="hm-weekdays-col">
            <div class="hm-month-spacer"></div>
            ${weekDayLabels.map(lbl => `<div class="hm-weekday-lbl">${lbl}</div>`).join('')}
          </div>
          <div class="hm-weeks-row">
            ${weeks.map(wk => `
              <div class="hm-week-col">
                <div class="hm-month-lbl">${wk.monthHeader}</div>
                ${wk.days.map(day => `
                  <button type="button"
                    class="hm-cell ${day.cls} ${day.isToday ? 'hm-today' : ''}"
                    title="${day.tip}"
                    onclick="CashewApp.openDayTransactionsModal('${day.iso}')">
                  </button>
                `).join('')}
              </div>
            `).join('')}
          </div>
        </div>

        <div class="hm-legend-row">
          <span style="font-size:11.5px; color:var(--text-muted);">Toca cualquier día para ver o agregar movimientos</span>
          <div style="display:flex; align-items:center; gap:5px; font-size:11px; color:var(--text-muted); font-weight:700;">
            <span>Gasto</span>
            <span class="hm-legend-dot hm-exp-4"></span>
            <span class="hm-legend-dot hm-exp-2"></span>
            <span class="hm-legend-dot hm-empty"></span>
            <span class="hm-legend-dot hm-inc-2"></span>
            <span class="hm-legend-dot hm-inc-4"></span>
            <span>Ganancia</span>
          </div>
        </div>
      </div>
    `;
  }
};
