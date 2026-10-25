#!/usr/bin/env python3
"""跨品牌文件互转模块（Convert）—— 参考 RFutils shared/formats。

实现舒尔 WWB ↔ 森海 WSM 的文件互转：
- 统一中间 Channel 模型，任何支持格式可互相导出
- 频率归一化：兼容 MHz 小数(470.100)、森海 MHz.kHz(600.768)、逗号小数(600,768)、原始 kHz(600768)
- 自动检测输入格式

工程底线：
- 确定性：同样的输入得到同样的输出
- 频率内部统一为 MHz（浮点），导出时按目标格式规范（WWB 3 位小数 MHz，WSM 整数 kHz）
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

KHZ_THRESHOLD = 3000.0  # >= 此值视为 kHz，需 /1000（UHF 无线麦克风频段 30~6000 MHz）


# ---------- 频率解析（核心） ----------

def parse_frequency_to_mhz(raw: str) -> float:
    """把各种频率表示归一化为 MHz。

    兼容：纯 MHz 小数(470.100)、森海 MHz.kHz(600.768)、逗号小数(600,768)、原始 kHz(600768)。
    """
    text = raw.strip()
    if not text:
        raise ValueError('频率值为空')
    # 逗号作小数点（有逗号无点），否则去掉逗号（千分位）
    if ',' in text and '.' not in text:
        text = text.replace(',', '.')
    else:
        text = text.replace(',', '')
    try:
        value = float(text)
    except ValueError:
        raise ValueError(f'不是数字: {raw}')
    if value != value or value in (float('inf'), float('-inf')):  # NaN/Inf
        raise ValueError(f'不是有限值: {raw}')
    return value / 1000.0 if value >= KHZ_THRESHOLD else value


def format_mhz(value_mhz: float) -> str:
    """WWB 频率列表：3 位小数 MHz。"""
    return f'{value_mhz:.3f}'


def format_khz(value_mhz: float) -> str:
    """WSM：整数 kHz。"""
    return str(round(value_mhz * 1000))


# ---------- 统一 Channel 模型 ----------

@dataclass
class Channel:
    name: str = ''
    frequency_mhz: Optional[float] = None
    group: Optional[str] = None
    channel: Optional[str] = None
    device_type: Optional[str] = None
    manufacturer: Optional[str] = None
    notes: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'name': self.name,
            'frequency_mhz': self.frequency_mhz,
            'group': self.group,
            'channel': self.channel,
            'device_type': self.device_type,
            'manufacturer': self.manufacturer,
            'notes': self.notes,
        }


@dataclass
class CoordinationList:
    channels: List[Channel] = field(default_factory=list)
    source_format: str = ''

    def to_dict(self) -> Dict[str, Any]:
        return {
            'channels': [c.to_dict() for c in self.channels],
            'source_format': self.source_format,
        }


# ---------- CSV 工具 ----------

def _parse_csv(text: str, delimiter: str = ',') -> List[List[str]]:
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    return [row for row in reader]


def _write_csv(rows: List[List[Any]], delimiter: str = ',') -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=delimiter, lineterminator='\n')
    for row in rows:
        writer.writerow([str(c) if c is not None else '' for c in row])
    return buf.getvalue()


def _detect_delimiter(text: str) -> str:
    """检测分隔符：优先分号（WSM 默认），否则试制表符/竖线/冒号/逗号。"""
    first_line = text.split('\n', 1)[0] if text else ''
    for delim in [';', '\t', '|', ':', ',']:
        if delim in first_line:
            return delim
    return ','


# ---------- WWB 格式 ----------

def write_wwb_frequency_list(channels: List[Channel]) -> str:
    """WWB「从文件导入频率」：纯 MHz 值列表（<=3 位小数），WWB 确定接受的格式。"""
    lines = [format_mhz(c.frequency_mhz) for c in channels if c.frequency_mhz is not None]
    return '\n'.join(lines) + '\n'


def write_wwb_inventory_csv(channels: List[Channel]) -> str:
    """WWB 库存 CSV（列名在真实 WWB 中用户可配置，此为通用形态）。"""
    rows = [['Name', 'Frequency', 'Group', 'Channel', 'Type', 'Manufacturer', 'Notes']]
    for c in channels:
        rows.append([
            c.name,
            format_mhz(c.frequency_mhz) if c.frequency_mhz is not None else '',
            c.group or '',
            c.channel or '',
            c.device_type or '',
            c.manufacturer or '',
            c.notes or '',
        ])
    return _write_csv(rows)


def _looks_like_bare_frequency_list(rows: List[List[str]]) -> bool:
    """判断是否为「裸频率列表」（每格都是可解析的频率）。"""
    checked = 0
    for row in rows[:5]:
        for cell in row:
            cell = cell.strip()
            if not cell:
                continue
            try:
                parse_frequency_to_mhz(cell)
                checked += 1
            except ValueError:
                return False
    return checked > 0


def read_wwb_frequency_list(text: str) -> List[Channel]:
    """读取 WWB 频率列表（纯 MHz 值，每行一个或 CSV 单元格）。"""
    channels = []
    n = 1
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        for cell in line.replace('\t', ',').split(','):
            cell = cell.strip()
            if not cell:
                continue
            try:
                freq = parse_frequency_to_mhz(cell)
            except ValueError:
                continue
            channels.append(Channel(name=f'CH {n}', frequency_mhz=freq))
            n += 1
    return channels


# ---------- WSM 格式 ----------

WSM_HEADER = ['name', 'type', 'frequency', 'tolerance',
              'minfrequency', 'maxfrequency', 'priority', 'squelchlevel']
DEFAULT_WSM_TYPE = '0'  # 离散频率（已对真实 WSM 导出确认）


def read_wsm_csv(text: str) -> List[Channel]:
    """读取 WSM「Frequencies/Bands」CSV（分号分隔，频率 kHz）。"""
    delimiter = _detect_delimiter(text)
    rows = [r for r in _parse_csv(text, delimiter) if any(c.strip() for c in r)]
    if rows and rows[0] and rows[0][0].strip().lower() == 'name':
        rows = rows[1:]  # 跳表头
    channels = []
    for row in rows:
        if len(row) < 3:
            continue
        name = row[0].strip() or f'CH {len(channels) + 1}'
        type_code = row[1].strip() or None
        try:
            freq_mhz = parse_frequency_to_mhz(row[2])
        except ValueError:
            continue
        channels.append(Channel(name=name, frequency_mhz=freq_mhz, device_type=type_code))
    return channels


def write_wsm_csv(channels: List[Channel]) -> str:
    """写出 WSM「Frequencies/Bands」CSV（分号分隔，频率 kHz，type=0 离散）。"""
    rows = [list(WSM_HEADER)]
    for c in channels:
        freq_khz = format_khz(c.frequency_mhz) if c.frequency_mhz is not None else ''
        rows.append([
            c.name,
            c.device_type if c.device_type is not None else DEFAULT_WSM_TYPE,
            freq_khz,
            '0',
            freq_khz,  # min == max == frequency：零宽「离散」范围
            freq_khz,
            '',
            '',
        ])
    return _write_csv(rows, ';')


# ---------- 格式检测 ----------

def detect_format(text: str) -> str:
    """猜测文件格式：wsm / wwb-frequency-list / wwb-csv / generic。"""
    stripped = text.strip()
    if not stripped:
        return 'empty'
    first_line = stripped.split('\n', 1)[0]
    # WSM：分号分隔 + 首列 name + 至少 6 列
    delim = _detect_delimiter(text)
    if delim == ';':
        header = _parse_csv(first_line, ';')
        if header and header[0] and header[0][0].strip().lower() == 'name' and len(header[0]) >= 6:
            return 'wsm'
    # 裸频率列表
    rows = _parse_csv(text, delim)
    if _looks_like_bare_frequency_list(rows):
        return 'wwb-frequency-list'
    # 有表头的 CSV
    if rows and rows[0] and any(h.strip().lower() in ('name', 'frequency', 'freq') for h in rows[0]):
        return 'wwb-csv'
    return 'generic'


# ---------- 转换主入口 ----------

def parse_file(text: str) -> CoordinationList:
    """自动检测格式并解析为统一 Channel 模型。"""
    fmt = detect_format(text)
    if fmt == 'wsm':
        return CoordinationList(channels=read_wsm_csv(text), source_format='wsm-csv')
    if fmt == 'wwb-frequency-list':
        return CoordinationList(channels=read_wwb_frequency_list(text), source_format='wwb-frequency-list')
    if fmt == 'wwb-csv':
        # 通用 CSV：按列名嗅探（简化：找 frequency/freq 列，name 列）
        return _read_generic_csv(text)
    # generic：尝试按裸频率列表
    channels = read_wwb_frequency_list(text)
    if channels:
        return CoordinationList(channels=channels, source_format='generic')
    raise ValueError('无法识别的文件格式')


def _read_generic_csv(text: str) -> CoordinationList:
    """通用 CSV：按表头嗅探频率列和名称列。"""
    delim = _detect_delimiter(text)
    rows = _parse_csv(text, delim)
    if not rows:
        return CoordinationList(source_format='generic')
    header = [h.strip().lower() for h in rows[0]]
    freq_col = next((i for i, h in enumerate(header) if h in ('frequency', 'freq', 'frequencymhz', 'freqmhz')), None)
    name_col = next((i for i, h in enumerate(header) if h in ('name', 'label', 'channel')), None)
    if freq_col is None:
        # 无频率表头，回退到裸频率列表
        channels = read_wwb_frequency_list(text)
        return CoordinationList(channels=channels, source_format='generic')
    channels = []
    for row in rows[1:]:
        if freq_col >= len(row):
            continue
        try:
            freq = parse_frequency_to_mhz(row[freq_col])
        except ValueError:
            continue
        name = row[name_col].strip() if name_col is not None and name_col < len(row) else ''
        channels.append(Channel(name=name or f'CH {len(channels) + 1}', frequency_mhz=freq))
    return CoordinationList(channels=channels, source_format='wwb-csv')


def convert(text: str, target: str) -> str:
    """格式转换主入口：读入任意格式，导出目标格式。

    target: 'wwb-frequency-list' | 'wwb-inventory-csv' | 'wsm-csv'
    """
    parsed = parse_file(text)
    if target == 'wwb-frequency-list':
        return write_wwb_frequency_list(parsed.channels)
    if target == 'wwb-inventory-csv':
        return write_wwb_inventory_csv(parsed.channels)
    if target == 'wsm-csv':
        return write_wsm_csv(parsed.channels)
    raise ValueError(f'未知目标格式: {target}')


if __name__ == '__main__':
    # 演示：WSM → WWB
    wsm = 'name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\n' \
          'Lead Vocal;0;470125;0;470125;470125;;\n' \
          'Guitar;0;606700;0;606700;606700;;\n'
    print('=== 输入 WSM ===')
    print(wsm)
    print('=== 检测格式:', detect_format(wsm))
    print('=== 转 WWB 频率列表 ===')
    print(convert(wsm, 'wwb-frequency-list'))
    print('=== 转 WWB 库存 CSV ===')
    print(convert(wsm, 'wwb-inventory-csv'))
