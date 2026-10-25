// 真实 CSV 边界：明确频率单位与 dBm；空值/坏行不能变成 0 或静默补点。
(function (global) {
  'use strict';
  function rowsOf(text, delimiter) {
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false, line = 1, rowLine = 1;
    const endCell = () => { row.push(cell.trim()); cell = ''; closed = false; };
    const endRow = () => { endCell(); if (row.some(Boolean)) rows.push({cells:row, line:rowLine}); row = []; rowLine = line + 1; };
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (char === '"') { quoted = false; closed = true; }
        else { cell += char; if (char === '\n') line++; }
      } else if (char === delimiter) endCell();
      else if (char === '\n') { endRow(); line++; }
      else if (char === '"' && !cell.trim() && !closed) quoted = true;
      else if (char === '"' || (closed && char.trim())) throw new Error(`第 ${line} 行引号格式错误`);
      else cell += char;
    }
    if (quoted) throw new Error(`第 ${rowLine} 行引号未闭合`);
    if (cell || row.length) endRow();
    return rows;
  }

  const normalized = value => String(value).toLowerCase().replace(/[\s_()[\]\/\\-]+/g, '');
  function numberCell(value, kind) {
    const match = String(value ?? '').trim().match(/^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(mhz|khz|hz|dbm)?$/i);
    if (!match) throw new Error(`${kind} 为空或不是有效数值`);
    const valueNumber = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(valueNumber)) throw new Error(`${kind} 不是有限数值`);
    return {value:valueNumber, unit:match[2]?.toLowerCase()};
  }

  function parseScanCsv(text, options = {}) {
    text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    let selected;
    for (const delimiter of [',',';','\t']) {
      let rows;
      try { rows = rowsOf(text, delimiter); } catch (_) { continue; }
      const headerIndex = rows.findIndex((row, index) => index < 100 && !row.cells[0].startsWith('#') &&
        row.cells.some((value, fi) => /frequency|freq|频率/.test(normalized(value)) &&
          row.cells.some((other, li) => li !== fi && /dbm|level|amplitude|rssi|power|电平|强度/.test(normalized(other)))));
      if (headerIndex >= 0) { selected = {rows, delimiter, headerIndex}; break; }
    }
    if (!selected) throw new Error('未找到有效 CSV 表头或引号格式错误；示例：Frequency (MHz),Level (dBm)');
    const {rows, delimiter, headerIndex} = selected;
    const headers = rows[headerIndex].cells;
    const frequencyIndex = headers.findIndex(value => /frequency|freq|频率/.test(normalized(value)));
    const levelIndex = headers.findIndex((value, index) => index !== frequencyIndex && /dbm|level|amplitude|rssi|power|电平|强度/.test(normalized(value)));
    if (levelIndex < 0) throw new Error('频率和电平必须为不同列');
    const headerUnit = DatyFrequency.detectFrequencyUnit(headers[frequencyIndex]);
    const frequencyUnit = headerUnit !== 'auto' ? headerUnit : ({auto:'auto',mhz:'MHz',khz:'kHz',hz:'Hz'}[String(options.frequencyUnit || 'auto').trim().toLowerCase()]);
    if (!frequencyUnit) throw new Error('频率单位必须为 Hz、kHz 或 MHz');
    if (/dbfs|dbuv|dbµv|%/.test(normalized(headers[levelIndex]))) throw new Error('电平必须是已校准的 dBm，不能把 dBFS、dBµV 或百分比当成 dBm');
    const levelUnit = /dbm/i.test(headers[levelIndex]) ? 'dbm' : String(options.levelUnit || '').toLowerCase();
    if (levelUnit && levelUnit !== 'dbm') throw new Error('只支持 dBm 扫描电平');
    const byFrequency = new Map(), issues = [];
    let duplicateRows = 0;
    for (const row of rows.slice(headerIndex + 1)) {
      if (row.cells[0].startsWith('#')) continue;
      try {
        if (row.cells.length !== headers.length) throw new Error('列数与表头不一致');
        const frequency = numberCell(row.cells[frequencyIndex], '频率');
        const level = numberCell(row.cells[levelIndex], '电平');
        if (frequency.unit === 'dbm' || (level.unit && level.unit !== 'dbm')) throw new Error('频率/电平单位混用');
        if (frequency.unit && frequencyUnit !== 'auto' && frequency.unit !== frequencyUnit.toLowerCase()) throw new Error('频率单元格单位与表头冲突');
        if (frequencyUnit === 'auto' && !frequency.unit) throw new Error('频率单位缺失，请在表头注明 Hz、kHz 或 MHz');
        if (!levelUnit && level.unit !== 'dbm') throw new Error('电平单位缺失，请在表头注明 dBm');
        const frequencyKHz = DatyFrequency.toFrequencyKHz(frequency.value, frequency.unit || frequencyUnit);
        if (level.value < -200 || level.value > 50) throw new Error('dBm 电平超出 -200～50 范围');
        if (byFrequency.has(frequencyKHz)) duplicateRows++;
        byFrequency.set(frequencyKHz, Math.max(byFrequency.get(frequencyKHz) ?? -Infinity, level.value));
      } catch (error) { issues.push({line:row.line, message:error.message}); }
    }
    if (issues.length && options.skipInvalidRows !== true) throw new Error(`扫描 CSV 第 ${issues[0].line} 行：${issues[0].message}（共 ${issues.length} 行错误，未导入）`);
    const points = [...byFrequency].map(([frequencyKHz, levelDbm]) => ({frequencyKHz, levelDbm})).sort((a,b) => a.frequencyKHz - b.frequencyKHz);
    if (points.length < 2) throw new Error('CSV 至少需要两个不同频率的有效扫描点');
    return {points, frequencyColumn:headers[frequencyIndex], levelColumn:headers[levelIndex],
      frequencyUnit, levelUnit:'dBm', delimiter, ignoredRows:issues.length, duplicateRows,
      skippedMetadataRows:headerIndex, issues, source:'csv', interpolation:'display-only'};
  }
  global.DatyScanCsv = Object.freeze({parseScanCsv});
})(window);
