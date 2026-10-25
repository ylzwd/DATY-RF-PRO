#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DATY RF PRO — MQTT 数据桥接服务 v2.0（内嵌 Broker）
=====================================================
v2.0 变更：内嵌 MQTT Broker，不再依赖外部 EMQX。

架构：
  FAshe（模拟器） ──MQTT WebSocket──> 本程序(:8083) ──SSE──> unirf-app.html
                                     ↕ 内嵌 Broker
                                     内部直接处理消息

端口分配：
  8802  HTTP API 端口（unirf-app.html 获取实时数据，SSE 推送）
  8083  MQTT WebSocket Broker 端口（FAshe 连接此处）

Topics:
  订阅  daty/rf/devices/up       ← FAshe 设备状态更新
  订阅  daty/rf/devices/register ← FAshe 设备列表注册
  发布  daty/rf/devices/down     → 向 FAshe 下发指令
  订阅  daty/rf/devices/down     → FAshe 也订阅此主题接收指令
  发布  daty/rf/clock/sync       → 服务器主时钟校时
  订阅  daty/rf/clock/ack        ← FAshe 校时回执

API 接口（HTTP，端口 8802）：
  GET  /api/devices          - 当前全部设备数据（JSON）
  GET  /api/updates          - SSE 实时推送（EventSource）
  GET  /api/stats            - 服务统计信息
  GET/POST /api/projects     - SQLite 项目快照
  GET  /api/timeline         - Timeline 审计事件
  POST /api/coordination-runs - 保存协调运行
  GET  /api/capabilities     - 设备适配器能力矩阵
  GET  /api/clock            - 服务器主时钟及 FAshe 校时状态
  POST /api/command          - 向设备下发指令（通过内嵌 Broker）
  GET  /health               - 健康检查
"""

import asyncio
import atexit
import json
import math
import os
import platform
import socket
import subprocess
import struct
import sys
import threading
import time
import queue
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer

# Absolute sibling import also works in isolated/native-host importlib loaders.
_service_dir = os.path.dirname(os.path.abspath(__file__))
if _service_dir not in sys.path:
    sys.path.insert(0, _service_dir)
from http_transport import HttpTransportMixin, HttpRequestError, PROTOCOL as HTTP_PROTOCOL
from project_store import migrate_projects
from project_api import handle_get as project_api_get, handle_save as project_api_save
import unified_database as business_db
import unified_api as business_api
import unified_bootstrap as business_bootstrap
import server_storage_api
from server_archive import ArchiveService
from unified_runtime import UnifiedRuntime, PROTOCOL as UNIFIED_RUNTIME_PROTOCOL
from shure_active_discovery import configured_discovery, PROTOCOL as SHURE_DISCOVERY_PROTOCOL
from shure_protocol import telemetry_view as shure_telemetry_view
from shure_hardware import capabilities as shure_capabilities
from shure_control_contract import control_readiness as shure_control_readiness
from receiver_pairing import (ReceiverPairingPolicy, PairingError, MqttPacketBuffer,
                              mqtt_body, mqtt_utf, parse_connect, SUBSCRIBE_TOPICS,
                              PROTOCOL as PAIRING_PROTOCOL)
_pairing_policy = ReceiverPairingPolicy()
from receiver_enrollment import ReceiverEnrollment, EnrollmentError, AUTO_PROTOCOL, ORIGINS as ENROLLMENT_ORIGINS
_receiver_enrollment = ReceiverEnrollment(_pairing_policy)

# 产品版本与组件版本分开管理；对外 version 始终表示服务器产品版本。
APP_VERSION = '1.0.3'
BRIDGE_VERSION = '2.0'

# ── MQTT 配置 ─────────────────────────────────────────────────────────
_config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mqtt-config.json')
_mqtt_config = {}
if os.path.exists(_config_path):
    try:
        with open(_config_path, 'r', encoding='utf-8') as _f:
            _mqtt_config = json.load(_f)
    except Exception:
        pass

# Broker 监听配置
WS_HOST = '0.0.0.0'
WS_PORT = int(os.environ.get('MQTT_WS_PORT', _mqtt_config.get('ws_port', 8083)))

MQTT_TOPIC_UP       = 'daty/rf/devices/up'
MQTT_TOPIC_REGISTER = 'daty/rf/devices/register'
MQTT_TOPIC_DOWN     = 'daty/rf/devices/down'
# 服务器是唯一主时钟。FAshe 订阅同步主题并回传 ACK，设备数据主题保持不变。
MQTT_TOPIC_CLOCK_SYNC = 'daty/rf/clock/sync'
MQTT_TOPIC_CLOCK_ACK  = 'daty/rf/clock/ack'
CLOCK_PROTOCOL_VERSION = 'daty-clock-v1'

# ── HTTP 配置 ─────────────────────────────────────────────────────────
HTTP_PORT = 8802
CLIENT_TTL_SECONDS = 30
DEVICE_ONLINE_SECONDS = 15
DEVICE_RETENTION_SECONDS = 60
CLEANUP_INTERVAL_SECONDS = 5
COMMAND_ACK_TIMEOUT_SECONDS = 8
COMMAND_RETENTION_SECONDS = 300
CLOCK_SYNC_INTERVAL_SECONDS = 5
CLOCK_SYNC_MAX_AGE_SECONDS = 20
CLOCK_CLIENT_RETENTION_SECONDS = 60
MQTT_CONNECT_TIMEOUT_SECONDS = 10
_receiver_diagnostic_times = []  # Bound unauthenticated diagnostic writes per minute.

# ── 全局状态 ──────────────────────────────────────────────────────────
_state = {
    'devices':    {},
    'clients':    {},
    'receivers':  {},  # 稳定业务 client_id -> 当前有效 MQTT 会话 source_key
    # 每个 MQTT 会话第一次被处理时分配单调递增的 epoch。接收机身份相同
    # 时只接受 epoch 更新的一方，旧页面/旧连接的迟到注册包不能把通道数
    # 再次改回去（例如 1CH 页面被旧的 4CH 页面覆盖）。
    'source_epochs': {},
    'source_epoch_seq': 0,
    # 已见过的接收机最高 epoch（墓碑）。即使当前会话断线，旧页面也
    # 不能在新会话退出后重新夺回同一接收机。
    'receiver_epoch_fences': {},
    # 接收机身份别名表。MAC 是首选稳定身份，IP/client_id 作为可变别名，
    # 这样同一台机器换 IP 或报文缺少某个字段时不会生成第二台接收机。
    'receiver_aliases': {},  # alias (mac:/ip:/id:) -> canonical receiver id
    'commands':   {},  # command_id -> 可追踪命令事务
    'stats': {
        'connected_clients': 0,
        'total_messages':    0,
        'last_update':       None,
        'server_start':      datetime.now().isoformat(),
        'mqtt_connected':    True,  # 内嵌 Broker 永远在线
        'mqtt_broker':       'embedded',
    },
    'sse_queues': [],
}

# 时钟同步状态只用于诊断和健康检查，不参与设备身份或在线判定。
_clock_lock = threading.RLock()
_clock_state = {
    'source': 'fuwuqi',
    'protocol': CLOCK_PROTOCOL_VERSION,
    'server_id': uuid.uuid4().hex,
    'sequence': 0,
    'last_broadcast_ms': None,
    'clients': {},  # MQTT 会话 client_id -> 最近一次 clock_sync_ack
    'pending': {},  # (MQTT client_id, connection_token, sequence) -> 实际发送时刻
}


def _finite_metric(value):
    """将遥测值解析为有限浮点数；缺失/非法值统一返回 None。

    桥接器不能用演示占位值替代真实遥测。None 会被 JSON 编码为 null，
    前端因此可以明确区分“设备报告了 0”与“设备没有报告该指标”。
    """
    # bool 是 int 的子类，不能把 True/False 当作 1/0 的真实遥测。
    if isinstance(value, bool) or value is None or value == '':
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _strict_bool(value, default=False):
    """把协议中的静音状态规范为真正的 bool。

    不能直接使用 ``bool(value)``：旧设备可能发送字符串 ``"false"``，
    该字符串在 Python 中为真值，会把取消静音错误显示为静音。
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value == 1:
            return True
        if value == 0:
            return False
    text = str(value or '').strip().lower()
    if text in ('true', '1', 'yes', 'on', 'muted'):
        return True
    if text in ('false', '0', 'no', 'off', 'unmuted', 'normal'):
        return False
    return None if default is None else bool(default)


def _clock_sync_payload():
    """生成服务器主时钟校时包；每次广播递增 sequence，便于客户端去重。"""
    now_ms = int(time.time() * 1000)
    with _clock_lock:
        _clock_state['sequence'] += 1
        sequence = _clock_state['sequence']
        server_id = _clock_state['server_id']
        _clock_state['last_broadcast_ms'] = now_ms
    return {
        'type': 'clock_sync',
        'protocol': CLOCK_PROTOCOL_VERSION,
        'clock_source': 'fuwuqi',
        'server_id': server_id,
        'server_epoch_ms': now_ms,
        'server_iso': datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
        'sequence': sequence,
        'max_age_ms': int(CLOCK_SYNC_MAX_AGE_SECONDS * 1000),
    }


def _clock_status_snapshot():
    """返回主时钟及各 FAshe 最近校时状态（不暴露内部锁/对象）。"""
    now_ms = int(time.time() * 1000)
    now_mono = time.monotonic()
    with _clock_lock:
        _prune_clock_pending_locked(now_mono)
        clients = []
        for client_id, ack in list(_clock_state['clients'].items()):
            item = {key: value for key, value in ack.items() if not key.startswith('_')}
            item['age_ms'] = round(max(0, now_mono - ack['_received_monotonic']) * 1000, 1)
            if item['age_ms'] is not None and item['age_ms'] > int(CLOCK_CLIENT_RETENTION_SECONDS * 1000):
                _clock_state['clients'].pop(client_id, None)
                continue
            item['status'] = 'synced' if item['age_ms'] <= int(CLOCK_SYNC_MAX_AGE_SECONDS * 1000) else 'stale'
            if item['status'] == 'stale':
                item['rtt_ms'] = None
            clients.append(item)
        return {
            'source': _clock_state['source'],
            'protocol': _clock_state['protocol'],
            'server_id': _clock_state['server_id'],
            'server_epoch_ms': now_ms,
            'server_iso': datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
            'sequence': _clock_state['sequence'],
            'last_broadcast_ms': _clock_state['last_broadcast_ms'],
            'sync_interval_s': CLOCK_SYNC_INTERVAL_SECONDS,
            'max_age_s': CLOCK_SYNC_MAX_AGE_SECONDS,
            'client_retention_s': CLOCK_CLIENT_RETENTION_SECONDS,
            'rtt_method': 'server_monotonic_send_ack',
            'clients': clients,
        }


def _prune_clock_pending_locked(now_mono):
    for key, sent in list(_clock_state['pending'].items()):
        if now_mono - sent['monotonic'] > CLOCK_SYNC_MAX_AGE_SECONDS:
            _clock_state['pending'].pop(key, None)
    # 重复订阅也会触发校时；限制诊断缓存，不让它随消息数无界增长。
    while len(_clock_state['pending']) > 4096:
        _clock_state['pending'].pop(next(iter(_clock_state['pending'])))


def _forget_clock_session(client_id, connection_token):
    with _clock_lock:
        source = _mqtt_source_key(client_id, connection_token)
        if _clock_state['clients'].get(client_id, {}).get('_source') == source:
            _clock_state['clients'].pop(client_id, None)
        for key in list(_clock_state['pending']):
            if key[:2] == (client_id, connection_token):
                _clock_state['pending'].pop(key, None)


def _record_clock_ack(payload, sender_client_id, connection_token=None, *, log_receipt=True, received_monotonic=None):
    """只接受本服务器发给当前 MQTT 会话的序号，计量应用层往返 RTT。

    不使用设备时间、时钟偏移或报文自带 IP/client_id 来计算/归属延迟。
    """
    received_mono = time.monotonic() if received_monotonic is None else received_monotonic
    if not isinstance(payload, dict) or payload.get('protocol') != CLOCK_PROTOCOL_VERSION:
        return False
    sequence = payload.get('sequence')
    if isinstance(sequence, str) and sequence.isascii() and sequence.isdigit():
        sequence = int(sequence)
    if type(sequence) is not int or sequence <= 0 or not sender_client_id or not connection_token:
        return False
    with _broker_lock:
        session = _broker_clients.get(sender_client_id)
        if not session or session.get('connection_token') != connection_token:
            return False
    client_id = sender_client_id
    source = _mqtt_source_key(client_id, connection_token)
    key = (client_id, connection_token, sequence)
    received_ms = int(time.time() * 1000)
    offset_ms = _finite_metric(payload.get('offset_ms'))
    with _clock_lock:
        _prune_clock_pending_locked(received_mono)
        if payload.get('server_id') != _clock_state['server_id']:
            return False
        sent = _clock_state['pending'].pop(key, None)
        if not sent or sent['server_id'] != payload['server_id']:
            return False
        previous = _clock_state['clients'].get(client_id, {})
        if previous.get('_source') == source and sequence <= previous.get('sequence', 0):
            return False
        elapsed = received_mono - sent['monotonic']
        if elapsed < 0 or elapsed > CLOCK_SYNC_MAX_AGE_SECONDS:
            return False
        _clock_state['clients'][client_id] = {
            'client_id': client_id,
            'receiver_ip': payload.get('receiver_ip') or payload.get('ip'),
            'server_id': payload.get('server_id'),
            'sequence': sequence,
            'offset_ms': offset_ms,
            'client_epoch_ms': payload.get('client_epoch_ms'),
            'master_epoch_ms': payload.get('master_epoch_ms'),
            'last_ack_ms': received_ms,
            'rtt_ms': round(elapsed * 1000, 1),
            'sent_at_ms': sent['epoch_ms'],
            # 仅作客户端版本/处理耗时诊断，绝不从原始 RTT 中扣除。
            'client_version': str(payload.get('client_version') or '')[:64] or None,
            'client_ack_prepare_ms': _finite_metric(payload.get('client_ack_prepare_ms')),
            '_source': source,
            '_received_monotonic': received_mono,
        }
    if log_receipt:
        _log('CLOCK', f"校时 ACK <- {client_id} seq={sequence} RTT={elapsed * 1000:.1f}ms")
    return True


def _receiver_heartbeat_snapshot(device, online, now_mono=None):
    """按设备当前 MQTT 会话归属 RTT；同一接收机各 CH 共享同一个样本。"""
    now_mono = time.monotonic() if now_mono is None else now_mono
    source = device.get('_source')
    result = {'source': 'server_clock_ack', 'status': 'unmeasured' if online else 'offline',
              'rtt_ms': None, 'age_ms': None, 'max_age_ms': int(CLOCK_SYNC_MAX_AGE_SECONDS * 1000)}
    if not online or not source:
        return result
    with _clock_lock:
        ack = _clock_state['clients'].get(_mqtt_client_id_from_source(source))
        if not ack or ack.get('_source') != source:
            return result
        age_ms = max(0, now_mono - ack['_received_monotonic']) * 1000
        fresh = age_ms <= result['max_age_ms']
        result.update(status='measured' if fresh else 'stale', age_ms=round(age_ms, 1),
                      rtt_ms=ack['rtt_ms'] if fresh else None, measured_at_ms=ack['last_ack_ms'],
                      server_id=ack['server_id'], sequence=ack['sequence'])
    return result



def _metric_from_payload(data, *keys):
    """读取第一个有效字段，并返回 (value, present)。

    present=True 且 value=None 表示消息明确带了空/非法值，调用方应清除旧值；
    present=False 表示增量包没有携带该指标，调用方可以保留上一笔已知值。
    """
    present = False
    for key in keys:
        if key not in data:
            continue
        present = True
        value = _finite_metric(data.get(key))
        if value is not None:
            return value, True
    return None, present


def _normalize_af_dbfs(value, fallback=None):
    """规范化 FAshe AF 电平。协议单位固定为 dBFS，合法范围 -40～0。

    没有可用值时返回 None；只有调用方明确提供 fallback 时才沿用旧值。
    """
    numeric = _finite_metric(value)
    if numeric is None:
        numeric = _finite_metric(fallback)
    if numeric is None or numeric < -40.0 or numeric > 0.0:
        # 越界值不是可安全饱和的“满量程”；保留未知状态，避免把坏包当成 0 dBFS 告警。
        return None
    return round(numeric, 2)


def _normalize_rf_dbm(value, fallback=None):
    """规范化 RF 电平（dBm）；无效或超出物理显示范围时返回 None。"""
    numeric = _finite_metric(value)
    if numeric is None:
        numeric = _finite_metric(fallback)
    if numeric is None or numeric < -150.0 or numeric > 20.0:
        return None
    return round(numeric, 2)


def _normalize_battery_percent(value, fallback=None):
    """规范化电池百分比；只接受 0～100 的真实数值。"""
    numeric = _finite_metric(value)
    if numeric is None:
        numeric = _finite_metric(fallback)
    if numeric is None or numeric < 0.0 or numeric > 100.0:
        return None
    return round(numeric, 2)


def _normalize_frequency_khz(value, unit='auto'):
    """将报文频率统一为整数 kHz；缺失、非法或越界时返回 None。"""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    if isinstance(value, str) and not re.fullmatch(r'[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?', value.strip(), re.IGNORECASE):
        return None
    numeric = _finite_metric(value)
    if numeric is None or numeric <= 0:
        return None
    unit = {'auto': 'auto', 'hz': 'Hz', 'khz': 'kHz', 'mhz': 'MHz'}.get(str(unit).strip().lower())
    if unit is None:
        return None
    if unit == 'MHz':
        khz = numeric * 1000.0
    elif unit == 'Hz':
        khz = numeric / 1000.0
    elif unit == 'kHz':
        khz = numeric
    elif numeric >= 30_000_000:
        khz = numeric / 1000.0
    elif numeric >= 30_000:
        khz = numeric
    else:
        khz = numeric * 1000.0
    if not math.isfinite(khz):
        return None
    rounded = int(round(khz))
    if abs(khz - rounded) > 0.000001:
        return None  # 禁止静默丢弃小于 1 kHz 的精度；与浏览器引擎一致。
    return rounded if 30_000 <= rounded <= 3_000_000 else None


def _frequency_from_payload(data, fallback=None):
    """按字段优先级读取频率；字段显式存在但非法时不回退旧值。"""
    fields = [
        ('frequency_khz', 'kHz'), ('frequencyKHz', 'kHz'), ('freq_khz', 'kHz'),
        ('freq_mhz', 'MHz'), ('frequency_mhz', 'MHz'), ('frequencyMHz', 'MHz'),
        ('freq_hz', 'Hz'), ('frequency_hz', 'Hz'), ('frequencyHz', 'Hz'),
        ('frequency', 'auto'), ('freq', 'auto'),
    ]
    for key, unit in fields:
        if key not in data:
            continue
        raw = data.get(key)
        if raw is None or raw == '' or isinstance(raw, bool):
            return None
        declared = next((data[name] for name in ('frequency_unit', 'frequencyUnit', 'freq_unit') if name in data), 'auto')
        return _normalize_frequency_khz(raw, declared if unit == 'auto' else unit)
    return fallback


def _normalize_af_fields(data, fallback=None):
    """把 AF 字段统一为显式 af_dbfs；保留缺失值为 null。"""
    result = dict(data)
    # 新协议字段优先；兼容 camelCase 与已经公开的 af 别名。注意不能用
    # dict.get(a, dict.get(b))，否则 af_level:null 会遮蔽有效的 af_dbfs。
    af_raw, present = _metric_from_payload(
        result, 'af_level', 'af_dbfs', 'afLevel', 'afDbfs', 'af'
    )
    if present:
        # 字段明确存在时，null/非法值代表“本次不可用”，不能回退到旧值。
        af_dbfs = _normalize_af_dbfs(af_raw)
        for key in ('af_level', 'afLevel', 'afDbfs'):
            result.pop(key, None)
        result['af_dbfs'] = af_dbfs
        # af 是兼容旧消费者的别名，数值单位同样为 dBFS，不再表示百分比。
        result['af'] = af_dbfs
    return result
_state_lock = threading.RLock()
_db_lock = threading.RLock()
_db_connection = None
_message_stats_lock = threading.Lock()
_db_path = os.environ.get('DATY_DB_PATH', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'daty-rf.sqlite3'))
_telemetry_last_write = {}
_unified_runtime = None  # Started only after unified schema migration, before listeners.
_wal_checkpointer = None
# 设备从“最近在线”跨过 DEVICE_ONLINE_SECONDS 后，只发送一次离线快照。
# 该集合仅用于 cleanup 线程的边沿检测，不进入公开设备 JSON；设备恢复遥测
# 或被清理后会自动移除对应 ID，下一次超时可再次通知。
_offline_announced = set()


def _db_connect():
    return business_bootstrap.open_database(_db_path, timeout=5)


@contextmanager
def _db_session():
    # 同一连接仅在锁内使用，避免每条遥测创建/删除 WAL 文件并触发关闭时 checkpoint。
    # 保留 SQLite 默认 FULL 同步和逐事务 commit，不降低断电持久化保证。
    global _db_connection
    with _db_lock:
        if _db_connection is None:
            _db_connection = _db_connect()
        try:
            yield _db_connection
            _db_connection.commit()
        except Exception:
            _db_connection.rollback()
            raise


def _close_database():
    global _db_connection
    if _wal_checkpointer is not None:
        _wal_checkpointer.stop()
    with _db_lock:
        if _db_connection is not None:
            _db_connection.close()
            _db_connection = None


atexit.register(_close_database)


def _init_database():
    schema = '''
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_json TEXT NOT NULL DEFAULT '{}',
      created_at REAL NOT NULL, updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_devices (
      project_id TEXT NOT NULL, device_id TEXT NOT NULL, device_json TEXT NOT NULL,
      PRIMARY KEY(project_id, device_id), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS scan_datasets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, points_json TEXT NOT NULL,
      source TEXT NOT NULL, created_at REAL NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS coordination_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL,
      baseline_json TEXT, created_at REAL NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS commands (
      command_id TEXT PRIMARY KEY, device_id TEXT, command TEXT NOT NULL, expected_json TEXT,
      actual_json TEXT, status TEXT NOT NULL, error TEXT, created_at REAL NOT NULL,
      updated_at REAL NOT NULL, acknowledged_at REAL
    );
    CREATE TABLE IF NOT EXISTS telemetry_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, ts REAL NOT NULL,
      frequency_khz INTEGER, rf_dbm REAL, af_dbfs REAL, battery_percent REAL, muted INTEGER, status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry_samples(device_id, ts DESC);
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts REAL NOT NULL, event_type TEXT NOT NULL,
      device_id TEXT, command_id TEXT, summary TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_ts ON timeline_events(ts DESC);
    '''
    now = time.time()
    with _db_lock:
        with _db_session() as connection:
            business_bootstrap.initialize(connection, int(now * 1000))
            from monitoring_rules import ensure as ensure_monitoring_rules
            ensure_monitoring_rules(connection, int(now * 1000))
            from spectrum_settings import ensure as ensure_spectrum_settings
            ensure_spectrum_settings(connection, int(now * 1000))
        # The original session has committed. WAL cannot write a header until
        # the exact existing schema/new exclusive bootstrap was confirmed.
        business_bootstrap.enable_wal(connection)


def _json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _record_timeline(event_type, summary, device_id=None, command_id=None, details=None, project_id='default', ts=None):
    return  # Retired audit history; device command receipts remain independent.
    with _db_lock, _db_session() as connection:
        connection.execute(
            'INSERT INTO timeline_events(project_id,ts,event_type,device_id,command_id,summary,details_json) VALUES(?,?,?,?,?,?,?)',
            (project_id, ts or time.time(), event_type, device_id, command_id, summary, _json_text(details or {})),
        )


def _persist_command(record):
    _queue_unified_command(record)  # Nonblocking observation; accepted is NOT durable.
    with _db_lock, _db_session() as connection:
        connection.execute('''
          INSERT INTO commands(command_id,device_id,command,expected_json,actual_json,status,error,created_at,updated_at,acknowledged_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(command_id) DO UPDATE SET actual_json=excluded.actual_json,status=excluded.status,
            error=excluded.error,updated_at=excluded.updated_at,acknowledged_at=excluded.acknowledged_at
          WHERE excluded.updated_at >= commands.updated_at
            AND (commands.status IN ('prepared','published') OR excluded.status = commands.status)
        ''', (
            record['command_id'], record.get('device_id'), record.get('command'), _json_text(record.get('expected_value')),
            _json_text(record.get('actual_value')), record.get('status'), record.get('error'), record.get('created_at'),
            record.get('updated_at'), record.get('acknowledged_at'),
        ))


def _record_device_state(device_id, previous, current):
    """Capture existing 1 Hz history without disk waits in the MQTT consumer.

    UnifiedRuntime reports enqueue/commit/failure separately. Only device history
    moves to its FIFO writer; command audit and ACK decisions remain unchanged.
    """
    now = time.time()
    sample = None
    if now - _telemetry_last_write.get(device_id, 0) >= 1:
        sample = {key: current.get(key) for key in ('freq', 'rf', 'af_dbfs', 'batt', 'status')}
        sample['muted'] = None if current.get('muted') is None else int(bool(current.get('muted')))
    meaningful = {key: current.get(key) for key in ('freq', 'muted', 'status')}
    before = {key: previous.get(key) for key in ('freq', 'muted', 'status')} if previous else {}
    event = None
    if not previous:
        event = {'event_type': 'device.discovered', 'summary': f"设备上线：{current.get('name', device_id)}", 'details': meaningful}
    elif meaningful != before:
        event = {'event_type': 'device.state_changed', 'summary': f"设备状态变化：{current.get('name', device_id)}", 'details': {'before': before, 'after': meaningful}}
    if sample is None and event is None:
        return
    record = {'device_id': device_id, 'ts': now, 'sample': sample, 'event': event}
    if _unified_runtime is not None:
        accepted = _unified_runtime.device_history(record)['accepted']
    else:
        # Isolated embedders/tests before runtime startup keep synchronous history.
        # Production starts UnifiedRuntime before opening any receiver listeners.
        with _db_session() as connection:
            from unified_live import record_device_history
            record_device_history(connection, record)
        accepted = True
    if sample is not None and accepted:
        _telemetry_last_write[device_id] = now

_init_database()

# MQTT Broker 内部状态（跨线程共享）
_broker_clients = {}      # client_id -> {'ws': websocket, 'subscriptions': set(), 'remote_addr': str}
_broker_lock = threading.Lock()
_broker_loop: asyncio.AbstractEventLoop | None = None  # Broker asyncio 事件循环引用（跨线程发送用）
_mqtt_dispatch_loop = None
_mqtt_dispatch_queue = None
_mqtt_dispatch_task = None
_clock_refresh_queued = False
MQTT_DISPATCH_QUEUE_SIZE = 2048
MQTT_DISPATCH_BATCH_SIZE = 16
_mqtt_dispatch_batches = _mqtt_dispatch_items = _mqtt_dispatch_pauses = 0


def _start_unified_runtime():
    """Fail startup before listeners if the unified business database is unavailable."""
    global _unified_runtime, _wal_checkpointer
    if _unified_runtime is not None:
        return _unified_runtime
    from wal_checkpoint import WalCheckpointer
    checkpointer = WalCheckpointer(_db_path)
    try:
        checkpointer.start()
        # FULL commit sync stays enabled; only automatic checkpoint work moves.
        with _db_session() as connection:
            connection.execute('PRAGMA wal_autocheckpoint=0')
        runtime = UnifiedRuntime(
            _db_session, _clock_state['server_id'],
            on_error=lambda event: _log('DB', '业务持久化未完整确认: ' + event['code']))
        runtime.start()
    except Exception:
        checkpointer.stop()
        with _db_session() as connection:
            connection.execute('PRAGMA wal_autocheckpoint=1000')
        raise
    _wal_checkpointer = checkpointer
    _unified_runtime = runtime
    atexit.register(runtime.stop)
    return runtime


_server_archive_service = None


def get_server_archive_service():
    global _server_archive_service
    with _db_lock:
        if _server_archive_service is None:
            directory = os.environ.get('DATY_ARCHIVE_PATH', os.path.join(os.path.dirname(_service_dir), '数据存档', 'fuwuqi'))
            _server_archive_service = ArchiveService(_db_path, directory)
        return _server_archive_service


def get_unified_runtime_status():
    if _unified_runtime is None:
        return {'protocol': UNIFIED_RUNTIME_PROTOCOL, 'state': 'not-started',
                'started': False, 'accepting': False, 'complete': False}
    status = _unified_runtime.status()
    status['checkpoint'] = _wal_checkpointer.status() if _wal_checkpointer is not None else None
    return status


def _queue_unified_snapshot(devices, full=False, observed_at_ms=None):
    if _unified_runtime is None:
        return {'accepted': False, 'persisted': False, 'code': 'RUNTIME_NOT_STARTED'}
    return _unified_runtime.snapshot(devices, full=full, observed_at_ms=observed_at_ms)


def _queue_unified_inventory():
    # Called outside _state_lock; the existing Bridge remains identity/online authority.
    return _queue_unified_snapshot(_get_devices_snapshot(), full=True)


def _queue_unified_command(record):
    if _unified_runtime is None:
        return {'accepted': False, 'persisted': False, 'code': 'RUNTIME_NOT_STARTED'}
    observed = dict(record)
    # Capture only evidence attached AFTER the existing ACK decision. No new ACK
    # comparison, target inference, command mutation, disk access or queue wait.
    with _state_lock:
        owner = _state['commands'].get(record.get('command_id'), {})
        evidence = owner.get('_persistence_ack_evidence')
        if record.get('status') == 'acknowledged' and evidence:
            observed['ack_evidence'] = dict(evidence)
    return _unified_runtime.command(observed)


def _process_queued_mqtt_message(topic, payload_str, client_id, connection_token):
    # 排队期间可能重连：失效连接的积压消息不能再接管接收机。
    with _broker_lock:
        session = _broker_clients.get(client_id)
        if not session or session.get('connection_token') != connection_token:
            return
    # Revalidate after queueing: revoked or replaced credentials must not mutate
    # state merely because the packet was already accepted by the socket loop.
    try:
        payload = json.loads(payload_str) if isinstance(payload_str, str) else payload_str
        checked = _pairing_policy.validate_payload(session.get('pairing'), topic, payload)
    except (PairingError, ValueError, TypeError):
        return
    # Socket-owned parsed objects stay internal. Legacy string callers retain
    # their interface; no repeated JSON round trips on the production queue.
    checked = json.dumps(checked, ensure_ascii=False) if isinstance(payload_str, str) else checked
    _process_mqtt_message(topic, checked, client_id, connection_token)


def _process_mqtt_batch(items):
    """One worker call per bounded FIFO batch; validate every individual packet."""
    global _clock_refresh_queued
    for item in items:
        try:
            if item is None:
                _clock_refresh_queued = False
                _push_sse_event('device_update', _get_devices_snapshot())
            else:
                _process_queued_mqtt_message(*item[:4])
        except Exception as error:
            _log('MQTT', f'后台消息处理失败: {error}')


async def _consume_mqtt_messages(work_queue):
    """Drain already queued packets only; never wait to fill a batch or coalesce."""
    global _mqtt_dispatch_batches, _mqtt_dispatch_items, _mqtt_dispatch_pauses
    while True:
        items = [await work_queue.get()]
        try:
            paused = False
            # Short disk stalls wait in bounded ingress; clock/PING stay live.
            # Sustained overload still closes explicitly at the 1013 boundary.
            while _unified_runtime is not None:
                persistence = _unified_runtime.status()
                if (not persistence['accepting'] or
                        (persistence['queue_count'] < persistence['queue_capacity'] // 2
                         and persistence['queue_bytes'] < persistence['max_queue_bytes'] // 2)):
                    break
                paused = True
                await asyncio.sleep(0.002)
            while len(items) < MQTT_DISPATCH_BATCH_SIZE:
                try:
                    items.append(work_queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            await asyncio.to_thread(_process_mqtt_batch, items)
            with _message_stats_lock:
                _mqtt_dispatch_batches += 1
                _mqtt_dispatch_items += sum(item is not None for item in items)
                _mqtt_dispatch_pauses += int(paused)
        finally:
            for _ in items:
                work_queue.task_done()


def _mqtt_dispatch_status():
    status = _mqtt_dispatch_queue.status() if _mqtt_dispatch_queue is not None else {}
    with _message_stats_lock:
        status.update(protocol='daty-mqtt-dispatch-v2', batches=_mqtt_dispatch_batches,
                      dequeued_items=_mqtt_dispatch_items, persistence_pauses=_mqtt_dispatch_pauses,
                      batch_limit=MQTT_DISPATCH_BATCH_SIZE,
                      consumer_running=bool(_mqtt_dispatch_task and not _mqtt_dispatch_task.done()))
    return status


def _get_mqtt_dispatch_queue():
    global _mqtt_dispatch_loop, _mqtt_dispatch_queue, _mqtt_dispatch_task, _clock_refresh_queued
    loop = asyncio.get_running_loop()
    if _mqtt_dispatch_loop is not loop or _mqtt_dispatch_task is None or _mqtt_dispatch_task.done():
        _mqtt_dispatch_loop = loop
        from mqtt_dispatch import MqttDispatchQueue
        _mqtt_dispatch_queue = MqttDispatchQueue(maxsize=MQTT_DISPATCH_QUEUE_SIZE)
        _clock_refresh_queued = False
        _mqtt_dispatch_task = loop.create_task(_consume_mqtt_messages(_mqtt_dispatch_queue))
    return _mqtt_dispatch_queue


def _defer_clock_snapshot():
    global _clock_refresh_queued
    work_queue = _get_mqtt_dispatch_queue()
    if not _clock_refresh_queued:
        try:
            work_queue.put_nowait(None)
            _clock_refresh_queued = True
        except asyncio.QueueFull:
            # 原始 RTT 已记录；下一个设备快照/ACK 会重试推送，不阻塞 ACK。
            pass


def _log(tag, msg):
    ts = datetime.now().strftime('%H:%M:%S')
    try:
        print(f"[{ts}][{tag}] {msg}", flush=True)
    except UnicodeEncodeError:
        safe = msg.encode('ascii', errors='replace').decode('ascii')
        print(f"[{ts}][{tag}] {safe}", flush=True)


# ════════════════════════════════════════════════════════════════════
#  设备数据管理
# ════════════════════════════════════════════════════════════════════

def _is_valid_ipv4(value):
    parts = str(value or '').strip().split('.')
    return len(parts) == 4 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts)


def _normalize_mac(value):
    """返回统一的 ``AA:BB:CC:DD:EE:FF`` MAC；模拟占位字符串不当作 MAC。"""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text:
        return None
    # 旧版 FAshe 使用 MAC-192-169-0-102 伪造标识；它不是硬件 MAC，
    # 必须退回 IP 身份，避免把同一台接收机的模拟/真实标识混成两台。
    if re.fullmatch(r'(?i)mac[-_]?(?:\d{1,3}[-_.]){3}\d{1,3}', text):
        return None
    compact = re.sub(r'[^0-9A-Fa-f]', '', text)
    if len(compact) != 12 or not re.fullmatch(r'[0-9A-Fa-f]{12}', compact):
        return None
    compact = compact.upper()
    return ':'.join(compact[index:index + 2] for index in range(0, 12, 2))


def _receiver_mac_from_payload(payload):
    if not isinstance(payload, dict):
        return None
    for key in ('receiver_mac', 'receiver_mac_address', 'mac_address', 'mac', 'hardware_mac'):
        if key in payload:
            mac = _normalize_mac(payload.get(key))
            if mac:
                return mac
    return None


def _receiver_ip_from_payload(payload):
    if not isinstance(payload, dict):
        return None
    for key in ('receiver_ip', 'ip', 'ip_address', 'ipAddress'):
        value = str(payload.get(key) or '').strip()
        if _is_valid_ipv4(value):
            return value
    return None


def _receiver_id_candidate(value):
    """清理 receiver/client id，去除通道后缀和随机 MQTT 会话后缀。"""
    raw = str(value or '').strip()
    if not raw:
        return None
    if any(marker in raw.lower() for marker in ('手动输入', '检测中', 'manual', 'unknown')):
        return None
    # Group 是编组元数据，不是接收机身份。没有 IP/MAC/合法 client_id
    # 的 Group-only 报文必须被拒绝，避免 Group1/Group2 形成“虚拟接收机”。
    if re.fullmatch(r'(?i)group\s*[-_:#/ ]*\d+', raw):
        return None
    # 稳定公开 ID 的通道后缀不能成为接收机身份的一部分。
    raw = re.sub(r'(?i)_ch\d+$', '', raw)
    match = re.fullmatch(r'(?i)(FAshe-(?:\d{1,3}\.){3}\d{1,3})(?:_[A-Za-z0-9-]+)?', raw)
    if match:
        candidate_ip = match.group(1).split('-', 1)[1]
        return f'FAshe-{candidate_ip}' if _is_valid_ipv4(candidate_ip) else None
    return raw


def _receiver_aliases_from_payload(payload, sender_client_id=None):
    """构造不含通道号的身份别名集合。"""
    aliases = []
    mac = _receiver_mac_from_payload(payload)
    ip = _receiver_ip_from_payload(payload)
    explicit = _receiver_id_candidate((payload or {}).get('receiver_id') or (payload or {}).get('receiverId'))
    client = _receiver_id_candidate((payload or {}).get('client_id') or sender_client_id)
    if mac:
        aliases.append(f'mac:{mac.lower()}')
    if ip:
        aliases.append(f'ip:{ip}')
    if explicit:
        aliases.append(f'id:{explicit.lower()}')
    if client:
        aliases.append(f'id:{client.lower()}')
    return aliases


def _canonical_fashe_id(payload, sender_client_id):
    """返回接收机级稳定身份（绝不包含 CH 或 Group）。

    优先级：真实 MAC → 已登记的身份别名 → 显式 receiver_id → IP → client_id。
    MAC/IP 别名在 ``_bind_receiver_aliases`` 中绑定，防止报文字段不完整时
    同一接收机被拆成多个对象。
    """
    payload = payload if isinstance(payload, dict) else {}
    aliases = _receiver_aliases_from_payload(payload, sender_client_id)
    mac = _receiver_mac_from_payload(payload)
    ip = _receiver_ip_from_payload(payload)
    explicit = _receiver_id_candidate(payload.get('receiver_id') or payload.get('receiverId'))
    client = _receiver_id_candidate(payload.get('client_id') or sender_client_id)
    with _state_lock:
        alias_map = _state.get('receiver_aliases', {})
        # MAC 是最可靠身份；若该 MAC 已绑定，始终沿用绑定结果。
        if mac:
            return alias_map.get(f'mac:{mac.lower()}') or f'FAshe-MAC-{mac.replace(":", "")}'
        for alias in aliases:
            known = alias_map.get(alias)
            if known:
                return known
    if explicit:
        return explicit
    if ip:
        return f'FAshe-{ip}'
    return client


def _bind_receiver_aliases(receiver_id, payload, sender_client_id=None, expected_source=None):
    """把本次报文携带的 MAC/IP/client_id 绑定到 canonical receiver_id。

    ``expected_source`` 用于 claim 后的并发保护：若另一个会话已经接管
    receiver，迟到报文不得把别名表回写到旧身份。
    """
    if not receiver_id:
        return False
    aliases = _receiver_aliases_from_payload(payload, sender_client_id)
    with _state_lock:
        if expected_source is not None and _state['receivers'].get(receiver_id) != expected_source:
            return False
        alias_map = _state.setdefault('receiver_aliases', {})
        for alias in aliases:
            alias_map[alias] = receiver_id
    return True


def _source_epoch_locked(source_key):
    """返回 MQTT 会话的单调 epoch；调用方必须持有 ``_state_lock``。"""
    if not source_key:
        return 0
    epochs = _state.setdefault('source_epochs', {})
    epoch = epochs.get(source_key)
    if epoch is None:
        _state['source_epoch_seq'] = int(_state.get('source_epoch_seq', 0)) + 1
        epoch = _state['source_epoch_seq']
        epochs[source_key] = epoch
    return epoch


def _claim_receiver_source(receiver_id, source_key):
    """把接收机绑定到最新会话，阻断旧会话的迟到报文。

    返回 ``False`` 表示当前报文来自已被更新会话取代的旧连接。该规则
    同时适用于 register/up/down，保证同一 IP/MAC 只有一个权威通道快照。
    """
    if not receiver_id or not source_key:
        return False
    with _state_lock:
        incoming_epoch = _source_epoch_locked(source_key)
        receiver_fences = _state.setdefault('receiver_epoch_fences', {})
        highest_epoch = int(receiver_fences.get(receiver_id, 0) or 0)
        if incoming_epoch < highest_epoch:
            return False
        current_source = _state['receivers'].get(receiver_id)
        if current_source == source_key:
            receiver_fences[receiver_id] = max(highest_epoch, incoming_epoch)
            return True
        if current_source:
            current_epoch = _source_epoch_locked(current_source)
            if incoming_epoch < current_epoch:
                return False
            # 新会话接管时，旧会话的客户端心跳不能继续维持在线状态。
            _state['clients'].pop(current_source, None)
        _state['receivers'][receiver_id] = source_key
        receiver_fences[receiver_id] = max(highest_epoch, incoming_epoch)
        return True


def _device_belongs_to_receiver(device_id, device, receiver_id):
    if device.get('_receiver_id') == receiver_id:
        return True
    # 兼容旧快照：比较设备记录中的 receiver_id/别名，而不是从 Group 或
    # device_id 的任意数字猜测通道。
    for value in (device.get('receiver_id'), device.get('receiverId')):
        candidate = _receiver_id_candidate(value)
        if candidate == receiver_id:
            return True
        with _state_lock:
            if candidate and _state.get('receiver_aliases', {}).get(f'id:{candidate.lower()}') == receiver_id:
                return True
    escaped = re.escape(str(receiver_id))
    return re.fullmatch(escaped + r'(?:_[A-Za-z0-9-]+)?_ch\d+', str(device_id), re.IGNORECASE) is not None


def _channel_number(value, default=None):
    """解析显式 CH/channel 号；Group 数字永远不会被当作通道号。

    ``Group1/CH2`` → 2；``Group1``（没有 CH 标记）→ ``default``。
    返回 ``None`` 表示报文缺少可验证的通道号，调用方应拒绝猜测。
    """
    if value is None or isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        try:
            number = int(value)
            return max(1, number) if number == value and number > 0 else default
        except (TypeError, ValueError, OverflowError):
            return default
    text = str(value).strip()
    if not text:
        return default
    if re.fullmatch(r'\d+', text):
        number = int(text)
        return number if number > 0 else default
    # 必须优先匹配 CH/CHANNEL 标记；允许 CH-F01 这类旧标签，但不读取
    # Group1、IP 地址或设备名称中的第一个数字。
    marked = re.search(r'(?i)(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)', text)
    if marked:
        number = int(marked.group(1))
        return number if number > 0 else default
    if re.search(r'(?i)\bgroup\s*[-_:#\s]*\d+', text):
        return default
    # 兼容稳定 ID 的明确 _chN 后缀。
    suffix = re.search(r'(?i)_ch\s*(\d+)\s*$', text)
    if suffix:
        number = int(suffix.group(1))
        return number if number > 0 else default
    return default


def _channel_from_payload(payload, default=None):
    """从报文中按协议字段优先级读取 CH 号。"""
    if not isinstance(payload, dict):
        return default
    fields = ('channel_number', 'channel_no', 'channel', 'ch', 'channel_key')
    for key in fields:
        if key not in payload:
            continue
        parsed = _channel_number(payload.get(key), None)
        if parsed is not None:
            return parsed
        # 某些旧包同时带有无效的 channel 和有效的 ch；继续检查
        # 其它明确通道字段，但绝不回退到 Group/名称中的普通数字。
    return default


def _channel_key(channel):
    return f'CH{int(channel)}' if channel is not None else ''


def _normalize_group(value):
    """保留 Group 元数据原样（只做安全的标量归一化），不参与路由。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return int(value)
        except (TypeError, ValueError, OverflowError):
            return None
    text = str(value).strip()
    return text or None


def _resolve_command_targets_locked(payload):
    """解析命令目标。

    目标键严格为 ``(receiver_id, channel_number)``。只有 channel 而没有
    接收机身份时一律拒绝，避免两台接收机都有 CH1 时误发命令。
    调用方必须持有 ``_state_lock``。
    """
    payload = payload if isinstance(payload, dict) else {}
    explicit_id = str(payload.get('device_id') or payload.get('id') or '').strip()
    receiver_id = _canonical_fashe_id(payload, None) if any(
        payload.get(key) for key in ('receiver_id', 'receiverId', 'receiver_mac',
                                     'receiver_mac_address', 'mac_address', 'mac',
                                     'hardware_mac', 'receiver_ip', 'ip', 'client_id')
    ) else None
    channel = _channel_from_payload(payload, None)
    if channel is None and explicit_id:
        channel = _channel_number(explicit_id, None)

    candidate = _state['devices'].get(explicit_id) if explicit_id else None
    if candidate is not None:
        device_channel = candidate.get('channel_number')
        if device_channel is None:
            device_channel = _channel_from_payload(candidate, None)
        if channel is not None and device_channel != channel:
            return []
        if receiver_id and not _device_belongs_to_receiver(explicit_id, candidate, receiver_id):
            return []
        return [explicit_id]

    # 没有 device_id 时必须同时提供接收机身份和显式 CH 号。
    if not receiver_id or channel is None:
        return []
    candidates = []
    for did, device in _state['devices'].items():
        if not _device_belongs_to_receiver(did, device, receiver_id):
            continue
        device_channel = device.get('channel_number')
        if device_channel is None:
            device_channel = _channel_from_payload(device, None)
        if device_channel == channel:
            candidates.append(did)
    return candidates if len(candidates) == 1 else []


def _normalize_device_brand(value):
    """品牌身份键；与前端别名规则一致，不把客户端品牌当作设备权威信息。"""
    if not isinstance(value, str):
        return ''
    token = re.sub(r'[\s_-]+', '', value).lower()
    return {
        'daty': 'DATYaudio', 'datyaudio': 'DATYaudio',
        'ams': 'AMSaudio', 'amsaudio': 'AMSaudio',
        'senn': 'Sennheiser', 'sennheiser': 'Sennheiser', 'shure': 'Shure',
    }.get(token, token)


def _command_public_view(record):
    return {key: value for key, value in record.items() if not key.startswith('_')}


def _create_command_record(payload, target_ids, sent_count):
    now = time.time()
    command_id = str(payload.get('command_id') or uuid.uuid4().hex)
    command_name = payload.get('command')
    expected_value = payload.get('value')
    if command_name in ('mute', 'unmute'):
        # 命令名是权威目标状态；即使旧客户端把 value 编成字符串，
        # 记录和 ACK 也统一保存为真正的 bool。
        expected_value = command_name == 'mute'
    record = {
        'command_id': command_id,
        'client_request_id': payload.get('client_request_id'),
        'command': command_name,
        'device_id': target_ids[0] if len(target_ids) == 1 else None,
        'target_device_ids': list(target_ids),
        'channel': _channel_from_payload(payload, None),
        'channel_number': _channel_from_payload(payload, None),
        'receiver_id': payload.get('receiver_id') or payload.get('receiverId'),
        'receiver_ip': payload.get('receiver_ip') or payload.get('ip'),
        'receiver_mac': payload.get('receiver_mac') or payload.get('receiver_mac_address') or payload.get('mac_address') or payload.get('mac'),
        'ip': payload.get('ip') or payload.get('receiver_ip'),
        'expected_value': expected_value,
        'status': 'prepared' if sent_count is None else ('published' if sent_count > 0 else 'failed'),
        'published_subscribers': sent_count,
        'created_at': now,
        'updated_at': now,
        'acknowledged_at': None,
        'actual_value': None,
        'error': None if sent_count is None or sent_count > 0 else '没有在线设备订阅命令主题',
    }
    if command_name == 'set_freq':
        record['brand'] = _normalize_device_brand(payload.get('brand'))
        if 'expected_brand' in payload:
            record['expected_brand'] = _normalize_device_brand(payload['expected_brand'])
    # HTTP supplies the observed network peer, never a claimed user identity. Keep it
    # in the transaction/audit only, not in the receiver protocol payload.
    actor = payload.pop('_request_actor', None)
    if actor:
        record['actor'] = dict(actor)
    with _state_lock:
        _state['commands'][command_id] = record
    _persist_command(record)
    _record_timeline('command.' + record['status'],
                     f"命令 {record['command']}：{record['status']}", record.get('device_id'), command_id,
                     {'expected': record.get('expected_value'), 'subscribers': sent_count, 'error': record.get('error'), 'actor': actor})
    return record


def _publish_tracked_command(payload, target_ids):
    """先登记事务再发送，防止快速设备的 ACK 先到、HTTP 记录却尚不存在。"""
    record = _create_command_record(payload, target_ids, None)
    with _state_lock:
        record['_require_ack_id'] = all(
            _state['devices'].get(did, {}).get('control_protocol') == 'fashe-realtime-v1'
            for did in target_ids)
        record['status'] = 'published'
        record['updated_at'] = published_at = time.time()
        record['_sent_monotonic'] = time.monotonic()
    try:
        sent_count = _broker_publish_command(payload, target_ids)
    except Exception as error:
        sent_count = 0
        record['error'] = str(error)
    with _state_lock:
        record['published_subscribers'] = sent_count
        if sent_count <= 0:
            record.update(status='failed', error=record['error'] or '没有在线设备订阅命令主题', updated_at=time.time())
        # 快速回执已标记 acknowledged 时，不能倒退回 published。
        public = _command_public_view(record)
    _persist_command(public)
    _record_timeline('command.published' if sent_count > 0 else 'command.failed',
                     f"命令 {record['command']}：{'published' if sent_count > 0 else 'failed'}",
                     record.get('device_id'), record['command_id'],
                     {'expected': record['expected_value'], 'subscribers': sent_count, 'error': record['error']}, ts=published_at)
    return sent_count, record


def _command_actual_value(command, device):
    if command == 'set_freq':
        khz = _normalize_frequency_khz(device.get('freq'), 'kHz')
        return khz / 1000.0 if khz is not None else None
    if command in ('mute', 'unmute'):
        return _strict_bool(device.get('muted'), None)
    return None


def _command_value_matches(record, actual):
    if record.get('command') == 'set_freq':
        actual_khz = _normalize_frequency_khz(actual, 'MHz')
        expected_khz = _normalize_frequency_khz(record.get('expected_value'), 'MHz')
        return actual_khz is not None and actual_khz == expected_khz
    if record.get('command') in ('mute', 'unmute'):
        # 静音状态必须按协议布尔值比较；不能让字符串 "false" 在
        # Python 中被 bool("false") 解释成 True，导致取消静音命令
        # 永远无法得到正确 ACK。
        return (actual is not None and _strict_bool(actual, None) is not None
                and _strict_bool(actual, False)
                == _strict_bool(record.get('expected_value'),
                                record.get('command') == 'mute'))
    return False


def _reconcile_commands_for_device(device_id, device, command_id=None, push=False):
    """用设备真实状态确认命令；返回需要推送的公开命令记录。"""
    acknowledged = []
    now = time.time()
    with _state_lock:
        for record in _state['commands'].values():
            if record.get('status') != 'published' or device_id not in record.get('target_device_ids', []):
                continue
            if command_id is not None and str(command_id) != record['command_id']:
                continue
            if record.get('_require_ack_id') and str(command_id or '') != record['command_id']:
                continue
            if record.get('command') == 'set_freq' and 'expected_brand' in record:
                # 状态包可能只包含频率，品牌必须读已登记的目标，不能由 ACK 自报覆盖。
                current_brand = _normalize_device_brand(_state['devices'].get(device_id, {}).get('brand'))
                if not record['expected_brand'] or current_brand != record['expected_brand']:
                    continue
            actual = _command_actual_value(record.get('command'), device)
            if _command_value_matches(record, actual):
                record['status'] = 'acknowledged'
                record['actual_value'] = actual
                record['acknowledged_at'] = now
                record['updated_at'] = now
                if record.get('_sent_monotonic') is not None:
                    record['ack_round_trip_ms'] = round((time.monotonic() - record['_sent_monotonic']) * 1000, 3)
                origin = _state['devices'].get(device_id, {})
                record['_persistence_ack_evidence'] = {
                    'origin': 'bridge.existing-ack-decision', 'device_id': device_id,
                    'reported_command_id': command_id, 'source_key': origin.get('_source'),
                    'receiver_id': origin.get('_receiver_id') or origin.get('receiver_id'),
                    'receiver_mac': origin.get('receiver_mac'), 'receiver_ip': origin.get('receiver_ip'),
                    'channel_number': origin.get('channel_number'), 'brand': origin.get('brand'),
                    'requires_command_id': record.get('_require_ack_id') is True,
                }
                acknowledged.append(_command_public_view(record))
    # 真实执行状态先送达页面，SQLite / Timeline 在状态锁外写入，仍然逐条保留审计。
    for record in acknowledged:
        if push:
            _push_sse_event('command_update', record)
        _persist_command(record)
        _record_timeline('command.acknowledged', f"设备已确认 {record['command']}", device_id,
                         record.get('command_id'), {'expected': record.get('expected_value'), 'actual': record['actual_value']},
                         ts=record['acknowledged_at'])
    return acknowledged


def _apply_mute_command(payload, sender_client_id=None, touch_source=False, connection_token=None):
    """按明确的目标状态更新一个通道；不做 toggle，也不改写在线状态。"""
    command = payload.get('command')
    if command not in ('mute', 'unmute'):
        return []

    target_muted = command == 'mute'
    receiver_id = _canonical_fashe_id(payload, sender_client_id)
    source_key = _mqtt_source_key(sender_client_id, connection_token) if touch_source else None
    if receiver_id:
        if not _bind_receiver_aliases(
            receiver_id, payload, sender_client_id,
            expected_source=source_key if touch_source else None,
        ):
            return []

    now = time.time()
    with _state_lock:
        if touch_source and receiver_id:
            current_source = _state['receivers'].get(receiver_id)
            if current_source and current_source != source_key:
                return []

        # 与 HTTP 命令使用同一套严格目标解析，禁止 channel-only/toggle 猜测。
        target_ids = _resolve_command_targets_locked(payload)

        for did in target_ids:
            device = _state['devices'][did]
            device['muted'] = target_muted
            if touch_source:
                device['_last_seen'] = now
                # 静音指令来自当前有效会话，也代表设备仍在线；允许下一次
                # 真正跨过在线 TTL 时重新发出一次离线边沿事件。
                _offline_announced.discard(did)

        if touch_source and receiver_id:
            if source_key in _state['clients']:
                _state['clients'][source_key]['_last_seen'] = now

    return target_ids


def _cleanup_stale_state_locked(now=None):
    """清理过期会话和设备。调用方必须持有 _state_lock。"""
    now = time.time() if now is None else now
    expired_clients = [
        key for key, info in _state['clients'].items()
        if now - info.get('_last_seen', 0) >= CLIENT_TTL_SECONDS
    ]
    for key in expired_clients:
        _state['clients'].pop(key, None)

    expired_devices = [
        did for did, device in _state['devices'].items()
        if now - device.get('_last_seen', 0) >= DEVICE_RETENTION_SECONDS
    ]
    for did in expired_devices:
        _state['devices'].pop(did, None)

    for receiver_id, source_key in list(_state['receivers'].items()):
        if source_key not in _state['clients']:
            _state['receivers'].pop(receiver_id, None)

    _state['stats']['connected_clients'] = len(_state['clients'])
    return expired_clients, expired_devices


def _detect_device_timeout_transitions_locked(now=None):
    """检测设备首次跨过在线 TTL 的边沿（调用方必须持有 _state_lock）。

    ``_get_devices_snapshot`` 会按年龄计算 ``_online``，但仅靠它无法把状态
    变化主动推送给 SSE 客户端。这里由固定 cleanup 线程维护一个轻量集合：
    每个设备只在 online→offline 的第一次跨越时返回一次；设备恢复（年龄重新
    小于 TTL）后移除标记，下一次超时仍可再次通知。设备保留到 retention TTL，
    因而前端能够先看到“离线”再在更长时间后看到设备从列表移除。
    """
    now = time.time() if now is None else now
    transitioned = []
    current_ids = set(_state['devices'])
    # 避免已被 retention 清理的设备在集合中留下无界增长。
    _offline_announced.intersection_update(current_ids)
    for did, device in _state['devices'].items():
        try:
            last_seen = float(device.get('_last_seen', 0) or 0)
            age = now - last_seen if math.isfinite(last_seen) else float('inf')
        except (TypeError, ValueError, OverflowError):
            age = float('inf')
        if age >= DEVICE_ONLINE_SECONDS:
            if did not in _offline_announced:
                _offline_announced.add(did)
                transitioned.append(did)
        else:
            _offline_announced.discard(did)
    return transitioned


def _expire_commands_locked(now=None):
    now = time.time() if now is None else now
    timed_out = []
    for record in _state['commands'].values():
        if record.get('status') == 'published' and now - record.get('created_at', now) >= COMMAND_ACK_TIMEOUT_SECONDS:
            record['status'] = 'timeout'
            record['error'] = f"设备在 {COMMAND_ACK_TIMEOUT_SECONDS} 秒内未确认目标状态"
            record['updated_at'] = now
            timed_out.append(_command_public_view(record))
            _persist_command(record)
            _record_timeline('command.timeout', f"设备未在时限内确认 {record['command']}", record.get('device_id'),
                             record.get('command_id'), {'expected': record.get('expected_value')})
    expired_ids = [
        command_id for command_id, record in _state['commands'].items()
        if now - record.get('created_at', now) >= COMMAND_RETENTION_SECONDS
    ]
    for command_id in expired_ids:
        _state['commands'].pop(command_id, None)
    return timed_out


def _cleanup_loop():
    while True:
        time.sleep(CLEANUP_INTERVAL_SECONDS)
        with _state_lock:
            now = time.time()
            _, removed_devices = _cleanup_stale_state_locked(now)
            timed_out_devices = _detect_device_timeout_transitions_locked(now)
            timed_out_commands = _expire_commands_locked()
        # 设备首次超过在线 TTL 时立即推送一次；不要每个 cleanup 周期重复推送。
        if removed_devices or timed_out_devices:
            _push_sse_event('device_list', _get_devices_snapshot())
        else:
            _queue_unified_inventory()  # Covers prior GET-triggered pruning, without changing SSE.
        for command in timed_out_commands:
            _push_sse_event('command_update', command)


def _get_devices_snapshot(device_ids=None):
    server_groups = (_pairing_policy._load() or {}).get('receiver_groups', {})
    with _state_lock:
        now = time.time()
        now_mono = time.monotonic()
        server_time_ms = int(now * 1000)
        if device_ids is None:
            _cleanup_stale_state_locked(now)
        result = []
        items = _state['devices'].items() if device_ids is None else (
            (did, _state['devices'][did]) for did in device_ids if did in _state['devices'])
        for did, dev in items:
            last_seen = dev.get('_last_seen', 0)
            age = now - last_seen
            d = {k: v for k, v in dev.items() if not k.startswith('_') or k == '_source'}
            # _receiver_id 是 bridge 内部索引，但前端必须拿到稳定的公开 ID，
            # 才能把同一接收机的多个通道按一台设备统计。
            if dev.get('_receiver_id'):
                d['receiver_id'] = dev['_receiver_id']
            # 对外明确区分接收机身份、IP/MAC 别名和通道号；Group 只作为
            # 编组元数据透传，前端/命令路由不得从中推导 CH。
            receiver_id = dev.get('_receiver_id') or d.get('receiver_id')
            if receiver_id:
                d['receiver_id'] = receiver_id
            receiver_ip = dev.get('receiver_ip') or d.get('receiver_ip') or dev.get('ip')
            if receiver_ip:
                d['receiver_ip'] = receiver_ip
            receiver_mac = dev.get('receiver_mac') or d.get('receiver_mac')
            if receiver_mac:
                d['receiver_mac'] = receiver_mac
                number = server_groups.get(receiver_mac)
                if number:
                    d.update(group=number, group_number=number, group_source='server-fifo-v1')
            channel_number = dev.get('channel_number')
            if channel_number is None:
                channel_number = _channel_from_payload(dev, None)
            if channel_number is not None:
                d['channel_number'] = channel_number
                d['channel_key'] = _channel_key(channel_number)
                d['channel'] = channel_number
                d['ch'] = _channel_key(channel_number)
            d['_online'] = age < DEVICE_ONLINE_SECONDS
            # 覆盖设备自报的 heartbeat，只信服务器按会话实测的往返值。
            d['heartbeat'] = _receiver_heartbeat_snapshot(dev, d['_online'], now_mono)
            d['server_time_ms'] = server_time_ms
            # 对外快照同时反映离线 status，避免只读取 status 而忽略
            # `_online` 的客户端把超时设备误显示为在线。
            if not d['_online']:
                d['status'] = 'offline'
            d['_age_s']  = round(age, 1)
            d['capabilities'] = _device_capabilities(d, dev)
            result.append(d)
        return result


def _device_capabilities(public_device, raw_device=None):
    raw_device = raw_device or public_device
    brand = _normalize_device_brand(public_device.get('brand'))
    source = str(raw_device.get('_source', ''))
    if brand == 'Shure' or source.startswith('shure-scp'):
        telemetry = public_device.get('shure')
        if not isinstance(telemetry, dict):
            telemetry = {}
        return {
            'discover': True, 'read_frequency': public_device.get('freq') is not None if source == 'shure-scp' else True, 'write_frequency': False,
            'read_rf': public_device.get('rf') is not None if source == 'shure-scp' else True,
            'read_af': telemetry.get('audio_dbfs') is not None if source == 'shure-scp' else True,
            'read_battery': public_device.get('model') in ('ULXD4','ULXD4D','ULXD4Q','AD4D','AD4Q'),
            'battery_available': any(telemetry.get(k) is not None and k not in telemetry.get('stale_fields',[]) for k in ('battery_percent','battery_bars','battery_minutes')),
            'read_mute': public_device.get('muted') is not None,
            'mute': False, 'scan': False,
            'control_preparation': shure_control_readiness(public_device.get('model')),
            'adapter': 'shure-scp-readonly', 'read_only': True,
            **shure_capabilities(raw_device),
        }
    # 来源在会话隔离后为 client:mqtt:token；公开视图已移除 _receiver_id。
    # 必须读取内部接收机索引，不能因新会话后缀把真实 MQTT 设备误标只读。
    if re.search(r':mqtt(?::[^:]+)?$', source) or raw_device.get('_receiver_id'):
        return {
            'discover': True, 'read_frequency': True, 'write_frequency': True,
            'read_rf': True, 'read_af': True, 'mute': True, 'scan': False,
            'adapter': 'fashe-mqtt', 'read_only': False,
            'frequency_control': {
                'scope': 'fashe-protocol', 'min_khz': 400000, 'max_khz': 900000,
                'step_khz': 1, 'origin_khz': 0,
                'brand_binding': 'expected-brand-v1',
                'ack_mode': 'command-id' if raw_device.get('control_protocol') == 'fashe-realtime-v1' else 'telemetry',
                'note': 'FAshe 控制协议范围；不是实体接收机硬件频段认证',
            },
        }
    return {
        'discover': False, 'read_frequency': False, 'write_frequency': False,
        'read_rf': False, 'read_af': False, 'mute': False, 'scan': False,
        'adapter': 'unknown-readonly', 'read_only': True,
    }


def _accept_shure_observation(receiver):
    """Server-owned GET and SAMPLE observations enter the durable device/MQTT path.

    Verified adapters share runtime GROUPs without MQTT sessions, pairing or ACKs.
    The user-editable Shure DEVICE_ID is a label, never our receiver identity.
    """
    rid, ip, model = receiver['receiver_id'], receiver['receiver_ip'], receiver['model']
    # Allocate once per receiver before publishing any channel. Legacy standalone
    # bridges without a boot allocator retain unknown groups, never local guesses.
    allocate_group = getattr(_pairing_policy, 'ensure_adapter_group', None)
    group = allocate_group('shure-scp', rid) if allocate_group else None
    now, updates = time.time(), []
    with _state_lock:
        for item in receiver['channels'].values():
            ch = item['channel_number']
            did = f'{rid}_ch{ch}'
            previous = _state['devices'].get(did)
            if previous and previous.get('_source') != 'shure-scp':
                continue
            dev = dict(previous) if previous else {'id': did, 'name': f'{model} CH{ch}',
                'freq': None, 'rf': None, 'af_dbfs': None, 'af': None, 'batt': None, 'muted': None}
            dev.update(brand='Shure', model=model, receiver_ip=ip, ip=ip, receiver_id=rid,
                _receiver_id=rid, _source='shure-scp', _last_seen=now, status='online',
                channel=ch, channel_number=ch, channel_key=f'CH{ch}', ch=f'CH{ch}',
                identity_basis=receiver.get('identity_basis','model-ip-endpoint'), group=group, group_number=group,
                group_source='server-fifo-v1' if group is not None else None,
                receiver_name=receiver.get('device_name'), protocol_verified=receiver['protocol_verified'],
                hardware_verified=False, control_protocol='shure-scp',
                receiver_mac=receiver.get('settings',{}).get('receiver_mac'))
            if not receiver.get('observation_received', True):
                dev['_last_seen'] = previous.get('_last_seen', 0) if previous else 0
            if 'name' in item:
                dev['name'] = item['name'] or f'{model} CH{ch}'
            if 'frequency_khz' in item:
                dev['freq'] = item['frequency_khz']
            if 'rf_dbm' in item:
                dev['rf_source_dbm'] = item['rf_dbm']
                dev['rf'] = _normalize_rf_dbm(item['rf_dbm'])
            if 'rf_antennas_dbm' in item:
                dev['rf_antennas_dbm'] = item['rf_antennas_dbm']
            if 'audio_dbfs' in item:
                dev['af_source_dbfs'] = item['audio_dbfs']
                dev['af'] = dev['af_dbfs'] = _normalize_af_dbfs(item['audio_dbfs'])
            if 'battery_percent' in item:
                dev['batt'] = _normalize_battery_percent(item['battery_percent'])
            for key in ('battery_bars', 'battery_minutes', 'muted'):
                if key in item:
                    dev[key] = item[key]
            dev['shure'] = shure_telemetry_view(receiver, item, dev.get('shure'))
            _state['devices'][did] = dev
            _offline_announced.discard(did)
            updates.append((did, previous, dict(dev)))
    for did, previous, dev in updates:
        _record_device_state(did, previous, dev)
    if updates:
        _push_sse_event('device_update', _get_devices_snapshot([did for did, _, _ in updates]))
    elif not receiver.get('channels'):
        # A model-only response is discovery evidence, not a fabricated CH1.
        old = _shure_discovery.receivers.get(ip)
        if not old or old.get('receiver_id') != rid:
            _record_timeline('receiver.discovered', f'发现舒尔接收机：{model}', details={
                'receiver_id': rid, 'receiver_ip': ip, 'model': model, 'channels_observed': 0,
                'identity_basis': 'model-ip-endpoint', 'adapter': 'shure-scp-readonly'})


_shure_discovery = configured_discovery(_accept_shure_observation)


def _push_sse_event(event_type, data):
    server_time_ms = int(time.time() * 1000)
    if event_type in ('device_list', 'device_update') and isinstance(data, list):
        _queue_unified_snapshot(data, full=event_type == 'device_list', observed_at_ms=server_time_ms)
    payload = json.dumps({
        'type': event_type,
        'devices': data if isinstance(data, list) else [],
        'data': data if not isinstance(data, list) else None,
        'clock_source': 'fuwuqi',
        'server_time_ms': server_time_ms,
        'ts': time.time(),
    }, ensure_ascii=False)

    dead = []
    with _state_lock:
        for q in _state['sse_queues']:
            try:
                q.put_nowait(payload)
            except queue.Full:
                # 不能静默移除订阅后留下永远不再更新的连接。
                # 清空积压，通知 SSE 线程关闭；EventSource 重连后重新获取全量。
                while True:
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        break
                q.put_nowait(None)
                dead.append(q)
        for q in dead:
            try:
                _state['sse_queues'].remove(q)
            except ValueError:
                pass


def _mqtt_source_key(sender_client_id, connection_token=None):
    """构造可区分 MQTT 重连的内部来源键。"""
    base = str(sender_client_id or 'unknown')
    token = str(connection_token or '').strip()
    return f"{base}:mqtt:{token}" if token else f"{base}:mqtt"


def _count_mqtt_message():
    # 独立短锁：ACK 统计不能等待业务状态锁中的 SQLite / Timeline 操作。
    with _message_stats_lock:
        _state['stats']['total_messages'] += 1
        _state['stats']['last_update'] = datetime.now().isoformat()


def _process_mqtt_message(topic, payload_str, sender_client_id, connection_token=None):
    """处理 MQTT 消息（从 Broker 线程或 HTTP 线程调用）"""
    try:
        payload = json.loads(payload_str) if isinstance(payload_str, str) else payload_str
        msg_type = payload.get('type', '')
        source = payload.get('source', 'unknown')
        client_id = payload.get('receiver_ip', sender_client_id)
        source_key = _mqtt_source_key(sender_client_id, connection_token)

        # 仅统计，不登记 receiver session；身份/显式 CH 验证通过后才 claim。
        _count_mqtt_message()

        # FAshe 校时回执使用独立主题，不能落入设备 up 分支，避免误创建 CH1。
        if topic == MQTT_TOPIC_CLOCK_ACK and msg_type == 'clock_sync_ack':
            if _record_clock_ack(payload, sender_client_id, connection_token):
                _push_sse_event('device_update', _get_devices_snapshot())
            return

        # FAshe 本机点击静音/取消静音时发布到 down；bridge 必须同步缓存并推送 SSE。
        # 使用 command 的目标状态赋值，禁止 toggle，因此重复消息也是幂等的。
        if topic == MQTT_TOPIC_DOWN and msg_type == 'device_command' and payload.get('command') in ('mute', 'unmute'):
            receiver_id = _canonical_fashe_id(payload, sender_client_id)
            source_key = _mqtt_source_key(sender_client_id, connection_token)
            # 先解析并确认唯一的 (receiver, CH) 目标，再允许该会话接管
            # receiver。无 CH、Group-only、或目标不唯一的命令不能驱逐
            # 当前有效会话，也不能改变任何缓存状态。
            with _state_lock:
                preflight_targets = _resolve_command_targets_locked(payload)
            if len(preflight_targets) != 1:
                _log("MQTT", "忽略未通过目标校验的静音指令（不记录原始载荷）")
                return
            if not _claim_receiver_source(receiver_id, source_key):
                _log("MQTT", f"忽略旧会话静音指令: receiver={receiver_id}, source={source_key}")
                return
            if not _bind_receiver_aliases(receiver_id, payload, sender_client_id, expected_source=source_key):
                _log("MQTT", f"忽略已失效静音会话别名更新: receiver={receiver_id}, source={source_key}")
                return

            updated_ids = _apply_mute_command(
                payload,
                sender_client_id,
                touch_source=True,
                connection_token=connection_token,
            )
            if updated_ids:
                _push_sse_event('device_update', _get_devices_snapshot(updated_ids))
                _log("MQTT", f"[down] {payload.get('command')} -> {', '.join(updated_ids)}")
            else:
                _log("MQTT", "[down] 未找到唯一目标通道（不记录原始载荷）")
            return

        # ── FAshe 格式：带稳定接收机身份的消息 ──
        if topic in (MQTT_TOPIC_REGISTER, MQTT_TOPIC_UP) and any(
            payload.get(key) for key in ('client_id', 'receiver_id', 'receiverId',
                                         'receiver_ip', 'ip', 'receiver_mac',
                                         'receiver_mac_address', 'mac_address', 'mac')
        ):
            fashe_id = _canonical_fashe_id(payload, sender_client_id)
            source_key = _mqtt_source_key(sender_client_id, connection_token)
            if not fashe_id:
                _log("MQTT", f"忽略无效 FAshe 身份: client_id={payload.get('client_id')!r}, ip={payload.get('ip')!r}")
                return
            # register 格式：{"client_id":..., "devices":[{name, channel, freq_mhz, brand}, ...]}
            # up 格式：{"client_id":..., "channel":1, "rf_level":..., "battery":..., ...}
            raw_devices = payload.get('devices')

            if (topic == MQTT_TOPIC_UP and msg_type in ('device_status_update', 'device_update')
                    and isinstance(raw_devices, list)):
                # Typed UP batches are sparse deltas, never registration
                # snapshots. Reuse the single-CH explicit-field ACK path so
                # omitted telemetry stays unchanged and siblings stay present.
                shared = {key: payload[key] for key in (
                    'receiver_id', 'receiver_mac', 'receiver_ip', 'client_id',
                    'brand', 'control_protocol', 'group', 'type') if key in payload}
                for raw_update in raw_devices:
                    if not isinstance(raw_update, dict) or 'devices' in raw_update or 'updates' in raw_update:
                        continue
                    single = {**shared, **raw_update}
                    if len(raw_devices) == 1 and 'command_id' not in single and 'command_id' in payload:
                        single['command_id'] = payload['command_id']
                    _process_mqtt_message(topic, json.dumps(single, ensure_ascii=False),
                                          sender_client_id, connection_token)
                return

            if isinstance(raw_devices, list):
                # ── register：注册包是该接收机当前通道的完整快照 ──
                # 顶层角色也必须是接收机/通道快照；干扰角色不能先占用
                # receiver session。设备项角色在下方逐项过滤。
                top_role = str(payload.get('device_role') or payload.get('role') or '').strip().lower()
                if top_role in ('interference', 'noise', 'test_noise') or payload.get('is_interference') is True:
                    _log("MQTT", f"忽略干扰源注册包，不得抢占接收机会话: receiver={fashe_id}")
                    return
                updated = []
                register_devices = []
                seen_channels = set()
                for raw_device in raw_devices:
                    if not isinstance(raw_device, dict):
                        continue
                    if str(raw_device.get('device_role') or raw_device.get('role') or '').lower() in ('interference', 'noise', 'test_noise'):
                        _log("MQTT", f"忽略干扰源注册项，不计入接收机通道: {raw_device.get('name')}")
                        continue
                    raw_channel = _channel_from_payload(raw_device, None)
                    if raw_channel is None:
                        _log("MQTT", "忽略没有显式 CH 号的注册项（Group 不可作为 CH）")
                        continue
                    # 一个物理接收机的 CH 号必须唯一；不同 Group 不能把同一
                    # 个 CH 扩展成多张卡。重复项不参与本次快照，避免最后一
                    # 项静默覆盖前一项造成状态抖动。
                    if raw_channel in seen_channels:
                        _log("MQTT", f"忽略重复 CH 注册项（Group 仅为元数据）: CH{raw_channel}")
                        continue
                    seen_channels.add(raw_channel)
                    register_devices.append((raw_device, raw_channel))
                # 非空但全部缺少 CH 的包视为 malformed，不得用默认 CH1
                # 覆盖/清除上一份可信快照；真正的空列表仍表示该接收机无通道。
                if raw_devices and not register_devices:
                    _log("MQTT", f"忽略无有效通道的注册包: receiver={fashe_id}")
                    return
                now = time.time()
                prepared_devices = []
                for d, ch in register_devices:
                    did = f"{fashe_id}_ch{ch}"
                    # 注册包是全量快照；没有上报的指标必须保留为 None，
                    # 不能用 -40/-70/100 等演示值伪造遥测。
                    af_raw, _af_present = _metric_from_payload(
                        d, 'af_level', 'af_dbfs', 'afLevel', 'afDbfs', 'af'
                    )
                    af_dbfs = _normalize_af_dbfs(af_raw)
                    rf_raw, _rf_present = _metric_from_payload(
                        d, 'rf_level', 'rfLevel', 'rf'
                    )
                    rf_value = _normalize_rf_dbm(rf_raw)
                    battery_raw, _battery_present = _metric_from_payload(
                        d, 'battery', 'battery_percent', 'batt'
                    )
                    battery_value = _normalize_battery_percent(battery_raw)
                    frequency_khz = _frequency_from_payload(d)
                    # 接收机身份优先取注册包顶层字段。设备项里的 ``ip``/``mac``
                    # 可能是发射机或通道级地址，不能覆盖整台接收机的身份；
                    # 只有顶层缺失时才允许从设备项补充。
                    receiver_ip = (_receiver_ip_from_payload(payload)
                                   or _receiver_ip_from_payload(d))
                    receiver_mac = (_receiver_mac_from_payload(payload)
                                    or _receiver_mac_from_payload(d))
                    group = _normalize_group(d.get('group', payload.get('group')))
                    dev = {
                        'id':         did,
                        'name':       d.get('name') or f"CH-{ch:02d}",
                        'brand':      d.get('brand', 'AMSaudio'),
                        'ch':         _channel_key(ch),
                        'channel':    ch,
                        'channel_number': ch,
                        'channel_key': _channel_key(ch),
                        'model':      d.get('model', 'FAshe'),
                        'ip':         receiver_ip or d.get('ip', payload.get('ip', '')),
                        'receiver_ip': receiver_ip,
                        'receiver_mac': receiver_mac,
                        'group':      group,
                        'control_protocol': payload.get('control_protocol', d.get('control_protocol')),
                        'freq':       frequency_khz,
                        'rf':         rf_value,
                        'af_dbfs':    af_dbfs,
                        'af':         af_dbfs,
                        'batt':       battery_value,
                        'muted':      _strict_bool(d.get('muted', False)),
                        'status':     d.get('status', 'online'),
                        '_last_seen': now,
                        '_source':    source_key,
                        '_receiver_id': fashe_id,
                    }
                    prepared_devices.append((did, dev))

                # 只有完整快照通过 CH/角色校验后，才允许新会话接管接收机。
                # 这一步必须位于所有 early-return 之后；否则一个空 CH 或
                # 干扰包会把有效旧会话踢掉，随后造成通道卡消失/静音错乱。
                if not _claim_receiver_source(fashe_id, source_key):
                    _log("MQTT", f"忽略旧会话注册批次: receiver={fashe_id}, source={source_key}")
                    return
                if not _bind_receiver_aliases(fashe_id, payload, sender_client_id, expected_source=source_key):
                    _log("MQTT", f"忽略已失效注册会话别名更新: receiver={fashe_id}, source={source_key}")
                    return

                desired_ids = {did for did, _ in prepared_devices}
                # 删除旧通道、写入新通道、登记当前 MQTT 客户端必须在同一把
                # 锁内完成，避免新旧会话在批量注册过程中交错造成“幽灵 CH”。
                previous_devices = {}
                with _state_lock:
                    if _state['receivers'].get(fashe_id) != source_key:
                        _log("MQTT", f"忽略已失效注册批次: receiver={fashe_id}, source={source_key}")
                        return
                    removed = [
                        did for did, device in _state['devices'].items()
                        if _device_belongs_to_receiver(did, device, fashe_id) and did not in desired_ids
                    ]
                    for did in removed:
                        _state['devices'].pop(did, None)
                        _offline_announced.discard(did)
                    for did, dev in prepared_devices:
                        previous_devices[did] = dict(_state['devices'].get(did, {}))
                        _state['devices'][did] = dev
                        _offline_announced.discard(did)
                    _state['clients'][source_key] = {
                        'addr': source_key, 'connected_at': datetime.now().isoformat(),
                        'receiver_id': fashe_id,
                        'receiver_ip': _receiver_ip_from_payload(payload),
                        'receiver_mac': _receiver_mac_from_payload(payload),
                        'protocol': 'MQTT', '_last_seen': now,
                    }
                    _state['stats']['connected_clients'] = len(_state['clients'])
                    updated = [did for did, _ in prepared_devices]
                for did, dev in prepared_devices:
                    _record_device_state(did, previous_devices.get(did, {}), dev)
                _push_sse_event('device_list', _get_devices_snapshot())
                for did in updated:
                    with _state_lock:
                        current_device = dict(_state['devices'].get(did, {}))
                    for command in _reconcile_commands_for_device(did, current_device):
                        _push_sse_event('command_update', command)
                _log("MQTT", f"[register] {fashe_id} 同步 {len(updated)} 个通道，移除旧记录 {len(removed)} 个: {', '.join(updated)}")

            else:
                # ── up：单设备状态更新 ──
                if str(payload.get('device_role') or payload.get('role') or '').lower() in ('interference', 'noise', 'test_noise'):
                    _log("MQTT", f"忽略干扰源状态，不创建真实通道卡: receiver={fashe_id}")
                    return
                ch = _channel_from_payload(payload, None)
                if ch is None:
                    _log("MQTT", f"忽略没有显式 CH 号的状态包（Group 不可作为 CH）: receiver={fashe_id}")
                    return
                did = f"{fashe_id}_ch{ch}"
                if not _claim_receiver_source(fashe_id, source_key):
                    _log("MQTT", f"忽略旧会话状态包: receiver={fashe_id}, source={source_key}")
                    return
                # claim 成功后再绑定本次上报携带的 IP/MAC/client 别名，
                # 并用 expected_source 防止并发新会话把别名写回旧会话。
                if not _bind_receiver_aliases(fashe_id, payload, sender_client_id,
                                               expected_source=source_key):
                    _log("MQTT", f"忽略已失效状态会话别名更新: receiver={fashe_id}, source={source_key}")
                    return
                with _state_lock:
                    if _state['receivers'].get(fashe_id) != source_key:
                        _log("MQTT", f"忽略已失效状态包: receiver={fashe_id}, source={source_key}")
                        return
                    existing = _state['devices'].get(did, {})
                    af_raw, af_present = _metric_from_payload(
                        payload, 'af_level', 'af_dbfs', 'afLevel', 'afDbfs', 'af'
                    )
                    # 增量包没有 AF 字段时沿用上一笔；明确 null/非法值时清空。
                    af_dbfs = (_normalize_af_dbfs(af_raw)
                               if af_present else existing.get('af_dbfs'))
                    rf_raw, rf_present = _metric_from_payload(
                        payload, 'rf_level', 'rfLevel', 'rf'
                    )
                    rf_value = _normalize_rf_dbm(rf_raw) if rf_present else existing.get('rf')
                    battery_raw, battery_present = _metric_from_payload(
                        payload, 'battery', 'battery_percent', 'batt'
                    )
                    battery_value = _normalize_battery_percent(battery_raw) if battery_present else existing.get('batt')
                    frequency_khz = _frequency_from_payload(payload, existing.get('freq'))
                    receiver_ip = _receiver_ip_from_payload(payload) or existing.get('receiver_ip') or existing.get('ip')
                    receiver_mac = _receiver_mac_from_payload(payload) or existing.get('receiver_mac')
                    group = _normalize_group(payload.get('group')) if 'group' in payload else existing.get('group')
                    dev = {
                        **existing,
                        'id':         did,
                        'name':       existing.get('name') or f"CH-{ch:02d}",
                        'brand':      existing.get('brand', payload.get('brand', 'AMSaudio')),
                        'ch':         _channel_key(ch),
                        'channel':    ch,
                        'channel_number': ch,
                        'channel_key': _channel_key(ch),
                        'model':      existing.get('model', payload.get('model', 'FAshe')),
                        'ip':         receiver_ip or payload.get('ip', existing.get('ip', '')),
                        'receiver_ip': receiver_ip,
                        'receiver_mac': receiver_mac,
                        'group':      group,
                        'freq':       frequency_khz,
                        'rf':         rf_value,
                        'af_dbfs':    af_dbfs,
                        'af':         af_dbfs,
                        'batt':       battery_value,
                        'muted':      _strict_bool(payload.get('muted', existing.get('muted', False))),
                        'control_protocol': payload.get('control_protocol', existing.get('control_protocol')),
                        'status':     payload.get('status', 'online'),
                        '_last_seen': time.time(),
                        '_source':    source_key,
                        '_receiver_id': fashe_id,
                    }
                    _state['devices'][did] = dev
                    _offline_announced.discard(did)
                    if source_key not in _state['clients']:
                        _state['clients'][source_key] = {
                            'addr': source_key, 'connected_at': datetime.now().isoformat(),
                            'receiver_id': fashe_id,
                            'receiver_ip': receiver_ip,
                            'receiver_mac': receiver_mac,
                            'protocol': 'MQTT', '_last_seen': time.time(),
                        }
                    else:
                        _state['clients'][source_key]['_last_seen'] = time.time()
                        _state['clients'][source_key].update({
                            'receiver_id': fashe_id,
                            'receiver_ip': receiver_ip,
                            'receiver_mac': receiver_mac,
                        })
                    _state['stats']['connected_clients'] = len(_state['clients'])
                _push_sse_event('device_update', _get_devices_snapshot([did]))
                # ACK 只使用本报文明示的执行状态，不以缓存中的 muted/freq 补齐。
                reported = {}
                if 'muted' in payload:
                    reported['muted'] = payload['muted']
                if any(key in payload for key in ('freq', 'frequency', 'freq_mhz', 'freq_khz', 'frequency_khz', 'frequencyKHz', 'frequency_mhz', 'frequencyMHz', 'freq_hz', 'frequency_hz', 'frequencyHz')):
                    reported['freq'] = frequency_khz
                _reconcile_commands_for_device(did, reported, payload.get('command_id'), push=True)
                _record_device_state(did, existing, dev)

            return

        # ── 旧格式：带 type 字段的批量消息 ──
        if msg_type in ('register_devices', 'device_list'):
            devices = payload.get('devices', [])
            legacy_receiver_id = _canonical_fashe_id(payload, sender_client_id)
            if not isinstance(devices, list) or not legacy_receiver_id:
                _log("MQTT", f"忽略无效旧格式注册（需要接收机身份和 devices 数组）: receiver={legacy_receiver_id}")
                return
            legacy_ip = _receiver_ip_from_payload(payload)
            legacy_mac = _receiver_mac_from_payload(payload)
            # 先构造并校验完整快照，再 claim 接收机会话。Group-only、干扰项
            # 和重复 CH 不得驱逐当前有效会话；空列表仍表示合法清空。
            prepared_devices = []
            seen_channels = set()
            for raw_device in devices:
                if not isinstance(raw_device, dict):
                    continue
                role = str(raw_device.get('device_role') or raw_device.get('role') or '').strip().lower()
                if role in ('interference', 'noise', 'test_noise') or raw_device.get('is_interference') is True:
                    continue
                ch = _channel_from_payload(raw_device, None)
                if ch is None:
                    _log("MQTT", "忽略没有显式 CH 号的旧格式注册项（Group 不可作为 CH）")
                    continue
                if ch in seen_channels:
                    _log("MQTT", f"忽略重复 CH 的旧格式注册项: CH{ch}")
                    continue
                seen_channels.add(ch)
                # 批次顶层的 IP/MAC 是接收机身份；设备项字段只作缺省补充，
                # 避免把通道/发射机地址误当成另一台接收机。
                receiver_ip = _receiver_ip_from_payload(payload) or _receiver_ip_from_payload(raw_device) or legacy_ip
                receiver_mac = _receiver_mac_from_payload(payload) or _receiver_mac_from_payload(raw_device) or legacy_mac
                normalized = _normalize_af_fields(raw_device)
                rf_raw, rf_present = _metric_from_payload(raw_device, 'rf_dbm', 'rf_level', 'rfLevel', 'rf')
                batt_raw, batt_present = _metric_from_payload(raw_device, 'battery_percent', 'battery', 'batteryLevel', 'batt')
                normalized.update({
                    'id': f"{legacy_receiver_id}_ch{ch}",
                    'channel': ch,
                    'channel_number': ch,
                    'channel_key': _channel_key(ch),
                    'ch': _channel_key(ch),
                    'receiver_id': legacy_receiver_id,
                    'receiver_ip': receiver_ip,
                    'receiver_mac': receiver_mac,
                    'ip': receiver_ip or normalized.get('ip', ''),
                    'group': _normalize_group(raw_device.get('group', payload.get('group'))),
                    'rf': _normalize_rf_dbm(rf_raw) if rf_present else None,
                    'batt': _normalize_battery_percent(batt_raw) if batt_present else None,
                    'muted': _strict_bool(raw_device.get('muted', False)),
                    '_receiver_id': legacy_receiver_id,
                })
                prepared_devices.append((f"{legacy_receiver_id}_ch{ch}", normalized))
            if devices and not prepared_devices:
                _log("MQTT", f"忽略无有效 CH 的旧格式注册，不改变当前会话: receiver={legacy_receiver_id}")
                return
            if not _claim_receiver_source(legacy_receiver_id, source_key):
                _log("MQTT", f"忽略旧会话旧格式注册: receiver={legacy_receiver_id}, source={source_key}")
                return
            if not _bind_receiver_aliases(legacy_receiver_id, payload, sender_client_id, expected_source=source_key):
                _log("MQTT", f"忽略已失效旧格式注册别名更新: receiver={legacy_receiver_id}, source={source_key}")
                return
            now = time.time()
            previous_devices = {}
            with _state_lock:
                if _state['receivers'].get(legacy_receiver_id) != source_key:
                    return
                desired_ids = {did for did, _ in prepared_devices}
                removed = [
                    did for did, device in _state['devices'].items()
                    if _device_belongs_to_receiver(did, device, legacy_receiver_id) and did not in desired_ids
                ]
                for did in removed:
                    _state['devices'].pop(did, None)
                    _offline_announced.discard(did)
                for did, normalized in prepared_devices:
                    previous_devices[did] = dict(_state['devices'].get(did, {}))
                    _state['devices'][did] = {
                        **normalized,
                        '_last_seen': now,
                        '_source': source_key,
                    }
                    _offline_announced.discard(did)
                _state['clients'][source_key] = {
                    'addr': source_key, 'connected_at': datetime.now().isoformat(),
                    'receiver_id': legacy_receiver_id,
                    'receiver_ip': legacy_ip,
                    'receiver_mac': legacy_mac,
                    'protocol': 'MQTT', '_last_seen': time.time(),
                }
                _state['stats']['connected_clients'] = len(_state['clients'])
            for did, normalized in prepared_devices:
                _record_device_state(did, previous_devices.get(did, {}), normalized)
            _push_sse_event('device_list', _get_devices_snapshot())
            _log("MQTT", f"收到 {msg_type}：同步 {len(prepared_devices)} 个通道，移除旧记录 {len(removed)} 个 <- {source_key}")

        elif msg_type in ('device_status_update', 'device_update'):
            updates = payload.get('devices', [])
            legacy_receiver_id = _canonical_fashe_id(payload, sender_client_id)
            if not isinstance(updates, list) or not legacy_receiver_id:
                _log("MQTT", f"忽略无效旧格式状态（需要接收机身份和 updates 数组）: receiver={legacy_receiver_id}")
                return
            legacy_ip = _receiver_ip_from_payload(payload)
            legacy_mac = _receiver_mac_from_payload(payload)
            prepared_updates = []
            seen_channels = set()
            for raw_update in updates:
                if not isinstance(raw_update, dict):
                    continue
                role = str(raw_update.get('device_role') or raw_update.get('role') or '').strip().lower()
                if role in ('interference', 'noise', 'test_noise') or raw_update.get('is_interference') is True:
                    continue
                ch = _channel_from_payload(raw_update, None)
                if ch is None:
                    _log("MQTT", "忽略没有显式 CH 号的旧格式状态项（Group 不可作为 CH）")
                    continue
                if ch in seen_channels:
                    _log("MQTT", f"忽略重复 CH 的旧格式状态项: CH{ch}")
                    continue
                seen_channels.add(ch)
                receiver_ip = _receiver_ip_from_payload(payload) or _receiver_ip_from_payload(raw_update) or legacy_ip
                receiver_mac = _receiver_mac_from_payload(payload) or _receiver_mac_from_payload(raw_update) or legacy_mac
                normalized = _normalize_af_fields(raw_update)
                rf_raw, rf_present = _metric_from_payload(raw_update, 'rf_dbm', 'rf_level', 'rfLevel', 'rf')
                batt_raw, batt_present = _metric_from_payload(raw_update, 'battery_percent', 'battery', 'batteryLevel', 'batt')
                canonical = {
                    'id': f"{legacy_receiver_id}_ch{ch}",
                    'channel': ch,
                    'channel_number': ch,
                    'channel_key': _channel_key(ch),
                    'ch': _channel_key(ch),
                    'receiver_id': legacy_receiver_id,
                    'receiver_ip': receiver_ip,
                    'receiver_mac': receiver_mac,
                    'ip': receiver_ip or normalized.get('ip', ''),
                    'group': _normalize_group(raw_update.get('group', payload.get('group'))),
                    '_receiver_id': legacy_receiver_id,
                }
                if rf_present:
                    canonical['rf'] = _normalize_rf_dbm(rf_raw)
                if batt_present:
                    canonical['batt'] = _normalize_battery_percent(batt_raw)
                if 'muted' in raw_update:
                    canonical['muted'] = _strict_bool(raw_update.get('muted'))
                if 'status' in raw_update:
                    canonical['status'] = raw_update.get('status')
                if any(key in raw_update for key in ('frequency_khz', 'frequencyKHz', 'freq_khz', 'freq_mhz', 'frequency_mhz', 'frequencyMHz', 'freq_hz', 'frequency_hz', 'frequencyHz', 'frequency', 'freq')):
                    canonical['freq'] = _frequency_from_payload(raw_update)
                canonical.update({key: value for key, value in normalized.items()
                                  if key not in ('id', 'channel', 'channel_number', 'channel_key', 'ch', 'receiver_id', 'receiver_ip', 'receiver_mac', 'ip', 'group', 'rf', 'batt', 'muted', 'status', 'freq', '_receiver_id')})
                prepared_updates.append((f"{legacy_receiver_id}_ch{ch}", canonical))
            # 状态批次必须至少含一个可验证 CH；空批次不应夺取会话。
            if not prepared_updates:
                _log("MQTT", f"忽略无有效 CH 的旧格式状态，不改变当前会话: receiver={legacy_receiver_id}")
                return
            if not _claim_receiver_source(legacy_receiver_id, source_key):
                _log("MQTT", f"忽略旧会话旧格式状态: receiver={legacy_receiver_id}, source={source_key}")
                return
            if not _bind_receiver_aliases(legacy_receiver_id, payload, sender_client_id, expected_source=source_key):
                _log("MQTT", f"忽略已失效旧格式状态别名更新: receiver={legacy_receiver_id}, source={source_key}")
                return
            now = time.time()
            previous_updates = {}
            with _state_lock:
                if _state['receivers'].get(legacy_receiver_id) != source_key:
                    return
                if source_key not in _state['clients']:
                    _state['clients'][source_key] = {
                        'addr': source_key, 'connected_at': datetime.now().isoformat(),
                        'receiver_id': legacy_receiver_id,
                        'receiver_ip': legacy_ip,
                        'receiver_mac': legacy_mac,
                        'protocol': 'MQTT',
                    }
                _state['clients'][source_key].update({
                    '_last_seen': now,
                    'receiver_id': legacy_receiver_id,
                    'receiver_ip': legacy_ip,
                    'receiver_mac': legacy_mac,
                })
                for did, canonical in prepared_updates:
                    existing = dict(_state['devices'].get(did, {}))
                    previous_updates[did] = existing
                    merged = {**existing, **canonical, '_last_seen': now, '_source': source_key}
                    _state['devices'][did] = merged
                    _offline_announced.discard(did)
                _state['stats']['connected_clients'] = len(_state['clients'])
            for did, canonical in prepared_updates:
                with _state_lock:
                    current_device = dict(_state['devices'].get(did, {}))
                _record_device_state(did, previous_updates.get(did, {}), current_device)
            _push_sse_event('device_update', _get_devices_snapshot())
            _log("MQTT", f"收到 {msg_type}：{len(prepared_updates)} 个通道更新 <- {source_key}")

        else:
            _log("MQTT", f"未知消息类型 [{topic}]: type={msg_type!r}")

    except json.JSONDecodeError as e:
        _log("MQTT", "JSON 解析错误（不记录原始载荷）")
    except Exception as e:
        _log("MQTT", f"消息处理错误: {e}")


# ════════════════════════════════════════════════════════════════════
#  内嵌 MQTT Broker（基于 asyncio + websockets）
# ════════════════════════════════════════════════════════════════════
#
#  支持 MQTT v3.1.1 over WebSocket（MQTT.js 使用的协议）
#  实现最小子集：CONNECT, PUBLISH, SUBSCRIBE, DISCONNECT, PINGREQ
#

def _mqtt_encode_remaining_length(length):
    """编码 MQTT Remaining Length（可变长度编码）"""
    result = bytearray()
    while True:
        byte = length % 128
        length //= 128
        if length > 0:
            byte |= 0x80
        result.append(byte)
        if length == 0:
            break
    return bytes(result)


def _mqtt_decode_remaining_length(data, offset):
    """解码 MQTT Remaining Length，返回 (length, new_offset)"""
    multiplier = 1
    value = 0
    index = offset
    while True:
        encoded_byte = data[index]
        value += (encoded_byte & 127) * multiplier
        if (encoded_byte & 128) == 0:
            return value, index + 1
        multiplier *= 128
        index += 1


def _build_connack(session_present=False, return_code=0):
    """构建 CONNACK 报文"""
    flags = 0x01 if session_present else 0x00
    return bytes([0x20, 0x02, flags, return_code])


def _build_suback(packet_id, return_codes):
    """构建 SUBACK 报文"""
    payload = struct.pack('>H', packet_id) + bytes(return_codes)
    return bytes([0x90]) + _mqtt_encode_remaining_length(len(payload)) + payload


def _build_pingresp():
    """构建 PINGRESP 报文"""
    return bytes([0xD0, 0x00])


def _extract_utf_string(data, offset):
    """从 MQTT 报文中提取 UTF-8 字符串，返回 (string, new_offset)"""
    str_len = struct.unpack('>H', data[offset:offset+2])[0]
    s = data[offset+2:offset+2+str_len].decode('utf-8', errors='replace')
    return s, offset + 2 + str_len


async def _watch_pairing(websocket, principal):
    while True:
        await asyncio.sleep(1)
        if not _pairing_policy.is_active(principal):
            await websocket.close(code=4003, reason='receiver pairing revoked or expired')
            return


async def _record_receiver_connection(reason, peer_ip, receiver_id=None, **details):
    """Small allowlisted diagnostic; never persist CONNECT bytes or credentials."""
    if receiver_id is None:
        now = time.monotonic()
        _receiver_diagnostic_times[:] = [t for t in _receiver_diagnostic_times if now - t < 60]
        if len(_receiver_diagnostic_times) >= 30:
            return
        _receiver_diagnostic_times.append(now)
    payload = {'reason': reason, 'receiver_ip': peer_ip, 'receiver_id': receiver_id}
    for key in ('session_id', 'connected_at_ms', 'last_packet_at_ms', 'last_telemetry_at_ms',
                'last_clock_ack_at_ms', 'keepalive_s', 'close_received_code', 'close_sent_code'):
        value = details.get(key)
        if value is not None:
            payload[key] = value
    try:
        await asyncio.to_thread(_record_timeline, 'receiver.connection',
                                '接收机连接：' + reason, details=payload)
    except Exception:
        _log('Broker', '接收机连接诊断保存失败；通信清理继续执行')


async def _handle_mqtt_websocket(websocket):
    """Authenticated MQTT3.1.1 receiver session; all production sockets use TLS."""
    path = getattr(getattr(websocket, 'request', None), 'path', None) or getattr(websocket, 'path', '/mqtt')
    client_id, principal, watcher = None, None, None
    connection_token = uuid.uuid4().hex
    remote = websocket.remote_address
    peer_ip = remote[0] if isinstance(remote, tuple) else None
    decoder = MqttPacketBuffer()
    reason = 'transport-closed'
    timing = {'session_id': connection_token}
    try:
        if path != '/mqtt' or getattr(websocket, 'subprotocol', None) != 'mqtt':
            reason = 'endpoint-rejected'
            await websocket.close(code=1008, reason='MQTT endpoint required')
            return
        pending = []
        async def receive_connect():
            while not pending:
                pending.extend(decoder.feed(await websocket.recv()))
            return pending.pop(0)
        try:
            packet = await asyncio.wait_for(receive_connect(), timeout=MQTT_CONNECT_TIMEOUT_SECONDS)
            client_id, username, password, keepalive = parse_connect(packet)
            principal = _pairing_policy.authenticate(username, password, client_id, peer_ip)
            principal['group_number'] = await asyncio.to_thread(_pairing_policy.ensure_group, principal)
            password = None  # Do not store raw CONNECT bytes or credentials in logs/session.
            packet = None
        except asyncio.TimeoutError:
            reason = 'handshake-timeout'
            # MQTT 3.1.1 has no handshake-timeout CONNACK. Do not falsely claim
            # credentials were rejected: server-unavailable + explicit WS reason.
            await websocket.send(_build_connack(return_code=3))
            await websocket.close(code=4008, reason='MQTT CONNECT timeout')
            return
        except PairingError:
            reason = 'pairing-rejected'
            await websocket.send(_build_connack(return_code=5))
            await websocket.close(code=1008, reason='receiver pairing required')
            return

        replaced = []
        with _broker_lock:
            # A credential owns one receiver, regardless of randomized MQTT clientId.
            for cid, prior in list(_broker_clients.items()):
                if cid == client_id or (prior.get('pairing') or {}).get('receiver_id') == principal['receiver_id']:
                    replaced.append(prior['ws'])
                    del _broker_clients[cid]
            _broker_clients[client_id] = {
                'ws': websocket, 'subscriptions': set(), 'remote_addr': str(remote),
                'connected_at': datetime.now().isoformat(), 'connected_at_ms': int(time.time()*1000),
                'connection_token': connection_token, 'pairing': principal,
            }
        for old_socket in replaced:
            await old_socket.close(code=4001, reason='receiver session replaced')
        await websocket.send(_build_connack(return_code=0))
        watcher = asyncio.create_task(_watch_pairing(websocket, principal))
        _log('Broker', f"配对接收机已连接: {principal['credential_id']} receiver={principal['receiver_id']}")
        timing.update(connected_at_ms=int(time.time()*1000), last_packet_at_ms=int(time.time()*1000), keepalive_s=keepalive)
        await _record_receiver_connection('connected', peer_ip, principal['receiver_id'], **timing)

        while True:
            if not pending:
                # MQTT keepalive is activity based; stale sessions cannot sit forever.
                pending.extend(decoder.feed(await asyncio.wait_for(websocket.recv(), timeout=keepalive * 1.5)))
                if not pending:
                    continue
            data = pending.pop(0)
            received_monotonic = time.monotonic()
            timing['last_packet_at_ms'] = int(time.time()*1000)
            with _broker_lock:
                current = _broker_clients.get(client_id)
                if not current or current.get('connection_token') != connection_token:
                    reason = 'session-replaced'
                    return
            kind, flags = data[0] >> 4, data[0] & 15
            # PUBLISH validates active pairing and payload together below. Other
            # packet types still require a fresh active-pairing check here.
            if kind != 3 and not _pairing_policy.is_active(principal):
                raise PairingError('Pairing no longer active')
            body = mqtt_body(data)
            if kind == 3:
                qos = (flags >> 1) & 3
                if flags & 1 or qos > 1 or (qos == 0 and flags & 8):
                    raise PairingError('Retained/unsupported publication denied')
                topic, offset = mqtt_utf(body, 0)
                packet_id = None
                if qos == 1:
                    if offset + 2 > len(body):
                        raise PairingError('Missing MQTT packet id')
                    packet_id = struct.unpack_from('>H', body, offset)[0]; offset += 2
                    if not packet_id:
                        raise PairingError('Invalid MQTT packet id')
                try:
                    payload = json.loads(body[offset:].decode('utf-8'))
                except (UnicodeError, ValueError):
                    raise PairingError('Invalid receiver JSON') from None
                checked = _pairing_policy.validate_payload(principal, topic, payload)
                if topic == MQTT_TOPIC_CLOCK_ACK:
                    # Preserve early monotonic RTT capture before SQLite and UI work.
                    if _record_clock_ack(checked, client_id, connection_token, log_receipt=False, received_monotonic=received_monotonic):
                        timing['last_clock_ack_at_ms'] = timing['last_packet_at_ms']
                        _defer_clock_snapshot()
                    _count_mqtt_message()
                else:
                    timing['last_telemetry_at_ms'] = timing['last_packet_at_ms']
                    try:
                        # Raw packet plus conservative normalization overhead per
                        # channel bounds memory even for maximum-sized batches.
                        size = len(data) + 512 * (1 + len(checked.get('devices', [])))
                        _get_mqtt_dispatch_queue().put_nowait((topic, checked, client_id, connection_token, size))
                    except asyncio.QueueFull:
                        reason = 'telemetry-backlog'
                        await websocket.close(code=1013, reason='telemetry backlog; reconnect and register')
                        return
                if packet_id is not None:
                    await websocket.send(bytes([0x40, 2]) + struct.pack('>H', packet_id))
                # Receiver data never broadcasts to other receivers. Only server-owned
                # clock and uniquely targeted control use the outbound delivery path.
            elif kind == 8:
                if flags != 2 or len(body) < 5:
                    raise PairingError('Invalid subscription packet')
                packet_id = struct.unpack_from('>H', body, 0)[0]
                if not packet_id:
                    raise PairingError('Invalid subscription id')
                offset, return_codes, requested = 2, [], []
                while offset < len(body):
                    topic, offset = mqtt_utf(body, offset)
                    if offset >= len(body):
                        raise PairingError('Truncated subscription')
                    qos = body[offset]; offset += 1
                    permitted = topic in SUBSCRIBE_TOPICS and qos in (0, 1)
                    return_codes.append(0 if permitted else 0x80)
                    if permitted:
                        requested.append(topic)
                with _broker_lock:
                    session = _broker_clients.get(client_id)
                    if not session or session['connection_token'] != connection_token:
                        return
                    session['subscriptions'].update(requested)
                await websocket.send(_build_suback(packet_id, return_codes))
                if MQTT_TOPIC_CLOCK_SYNC in requested:
                    await _send_clock_payload(client_id, session, _clock_sync_payload())
            elif kind == 12 and flags == 0 and not body:
                await websocket.send(_build_pingresp())
            elif kind == 14 and flags == 0 and not body:
                reason = 'client-disconnect'
                return
            else:
                raise PairingError('Unsupported MQTT control packet')
    except PairingError:
        reason = 'receiver-policy-denied'
        # Do not log raw packets, payloads or exception values containing credentials.
        _log('Broker', '拒绝未配对、越权或格式错误的 MQTT 会话')
        await websocket.close(code=1008, reason='receiver policy denied')
    except asyncio.TimeoutError:
        reason = 'keepalive-timeout'
        await websocket.close(code=1008, reason='MQTT keepalive expired')
    except Exception as error:
        received = getattr(getattr(error, 'rcvd', None), 'code', None)
        sent = getattr(getattr(error, 'sent', None), 'code', None)
        timing.update(close_received_code=received, close_sent_code=sent)
        if sent == 4001:
            reason = 'session-replaced'
        elif sent == 4003:
            reason = 'pairing-revoked-or-expired'
        _log('Broker', f'MQTT 连接结束: {type(error).__name__}')
    finally:
        if watcher:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        removed = False
        with _broker_lock:
            current = _broker_clients.get(client_id) if client_id else None
            if current and current.get('connection_token') == connection_token:
                del _broker_clients[client_id]
                removed = True
        _forget_clock_session(client_id, connection_token)
        if removed and principal:
            source = _mqtt_source_key(client_id, connection_token)
            with _state_lock:
                for device in _state['devices'].values():
                    if device.get('_source') == source:
                        device['_last_seen'] = 0
            _queue_unified_inventory()  # Full absence is persisted; wire event stays unchanged.
            _push_sse_event('device_update', _get_devices_snapshot())
        # Run after cleanup, off the event loop; slow/damaged storage cannot keep
        # stale channels online or block the other receiver's clock processing.
        if timing.get('close_sent_code') is None:
            timing['close_sent_code'] = getattr(websocket, 'close_code', None)
        await _record_receiver_connection(reason, peer_ip,
            principal.get('receiver_id') if principal else None, **timing)


def self_topic_match(topic, subscriptions):
    """检查主题是否匹配任何订阅（支持 # 通配符）"""
    for sub in subscriptions:
        if sub == topic:
            return True
        if sub.endswith('#'):
            prefix = sub[:-1]  # 去掉 #，保留 /
            if topic.startswith(prefix):
                return True
        if '+' in sub:
            parts_sub = sub.split('/')
            parts_topic = topic.split('/')
            if len(parts_sub) == len(parts_topic):
                match = True
                for ps, pt in zip(parts_sub, parts_topic):
                    if ps != '+' and ps != pt:
                        match = False
                        break
                if match:
                    return True
    return False


def _should_forward_client_publish(topic):
    """判断客户端发布的消息是否允许转发给其它 MQTT 客户端。

    ``devices/down`` 是服务端控制入口，不是接收机之间的广播总线。
    FAshe 本机点击静音/频率控制时也会向该主题发布消息；桥接器已经
    按接收机身份和 CH 处理，必须阻止它继续流向其它接收机。
    """
    return topic != MQTT_TOPIC_DOWN


def _build_mqtt_publish_packet(topic, payload_str):
    """构造 QoS 0 MQTT PUBLISH 报文，供命令和校时复用。"""
    topic_bytes = topic.encode('utf-8')
    payload_bytes = payload_str.encode('utf-8')
    remaining = len(topic_bytes) + 2 + len(payload_bytes)
    packet = bytearray([0x30])  # PUBLISH, QoS 0, no retain
    packet.extend(_mqtt_encode_remaining_length(remaining))
    packet.extend(struct.pack('>H', len(topic_bytes)))
    packet.extend(topic_bytes)
    packet.extend(payload_bytes)
    return bytes(packet)


async def _send_clock_payload(client_id, session, payload):
    """在 Broker 协程真正发送前计时，排除后台线程到事件循环的排队时间。"""
    principal = session.get('pairing') or {}
    number = principal.get('group_number')
    if number:
        payload = {**payload, 'receiver_assignment': {
            'receiver_mac': principal['receiver_mac'], 'receiver_ip': principal['_peer_ip'],
            'group_number': number, 'group_source': 'server-fifo-v1', 'ip_source': 'socket-peer'}}
    packet = _build_mqtt_publish_packet(MQTT_TOPIC_CLOCK_SYNC, json.dumps(payload, ensure_ascii=False))
    token = session.get('connection_token')
    key = (client_id, token, payload['sequence'])
    with _broker_lock:
        current = _broker_clients.get(client_id)
        if not token or current is not session or not _pairing_policy.is_active(session.get('pairing')):
            return False
        with _clock_lock:
            now_mono = time.monotonic()
            _prune_clock_pending_locked(now_mono)
            _clock_state['pending'][key] = {'monotonic': now_mono, 'epoch_ms': int(time.time() * 1000),
                                           'server_id': payload['server_id']}
    try:
        await session['ws'].send(packet)
        return True
    except Exception as error:
        with _clock_lock:
            _clock_state['pending'].pop(key, None)
        _log('CLOCK', f'校时发送失败 {client_id}: {error}')
        return False


async def _send_paired_packet(client_id, session, packet):
    with _broker_lock:
        if _broker_clients.get(client_id) is not session or not _pairing_policy.is_active(session.get('pairing')):
            return False
    await session['ws'].send(packet)
    return True


def _broker_publish_topic(topic, payload_str, client_ids=None, expected_sessions=None):
    """从 HTTP/后台线程向 MQTT 客户端发布消息。

    ``client_ids`` 为空时保持主题广播语义（用于主时钟）；传入集合时
    只向指定的 MQTT 会话发送。设备控制命令必须走定向路径，否则两台
    接收机都订阅同一个 ``down`` 主题时，客户端端过滤稍有差异就会出现
    串台或静音状态互相覆盖。
    """
    packet = _build_mqtt_publish_packet(topic, payload_str)
    clock_payload = json.loads(payload_str) if topic == MQTT_TOPIC_CLOCK_SYNC else None
    sent = 0
    loop = _broker_loop
    targets = None if client_ids is None else {str(cid) for cid in client_ids if cid}
    if topic not in SUBSCRIBE_TOPICS or (topic == MQTT_TOPIC_DOWN and not targets):
        return 0
    with _broker_lock:
        for cid, info in _broker_clients.items():
            if targets is not None and cid not in targets:
                continue
            # Preserve the exact preflight session across thread/loop handoff.
            # A replacement with the same MQTT client ID is not the same target.
            if expected_sessions is not None and expected_sessions.get(cid) is not info:
                continue
            if topic not in info['subscriptions'] and not self_topic_match(topic, info['subscriptions']):
                continue
            if not _pairing_policy.is_active(info.get('pairing')):
                continue
            try:
                if loop and loop.is_running():
                    delivery = _send_clock_payload(cid, info, clock_payload) if clock_payload else _send_paired_packet(cid, info, packet)
                    asyncio.run_coroutine_threadsafe(delivery, loop)
                    sent += 1
                else:
                    _log('Broker', f'警告: broker 事件循环未运行，无法发送到 {cid}')
            except Exception as e:
                _log('Broker', f'发送主题 {topic} 到 {cid} 失败: {e}')
    return sent


def _broker_publish_to_all(topic, payload_str):
    """从 HTTP 线程向所有订阅者发布消息（用于 /api/command）"""
    _broker_publish_topic(topic, payload_str)


async def _start_broker():
    """启动内嵌 MQTT Broker（WebSocket）"""
    global _broker_loop
    import websockets
    from tls_support import server_context
    context = server_context()

    # 保存事件循环引用，供 HTTP 线程跨线程调用
    _broker_loop = asyncio.get_event_loop()

    _log("Broker", f"内嵌 MQTT Broker 正在启动...")
    _log("Broker", f"  安全 WebSocket 端口: {WS_PORT} (FAshe 连接 wss://[本机IP]:{WS_PORT}/mqtt，必须配对)")

    # 启动 WebSocket 服务
    async with websockets.serve(
        _handle_mqtt_websocket,
        WS_HOST, WS_PORT,
        ssl=context,
        ssl_handshake_timeout=10,
        max_size=1024*1024,  # 1MB
        ping_interval=None,  # 由 MQTT PINGREQ 处理
        subprotocols=["mqtt"],  # 声明 MQTT 子协议
        compression=None,  # 心跳/遥测为短报文，避免小包 deflate 的 CPU 与排队开销
    ):
        _log("Broker", f"✓ 已配对 MQTT TLS Broker 已启动: wss://0.0.0.0:{WS_PORT}/mqtt")
        await asyncio.Future()  # 永不返回


def _mqtt_client_id_from_source(source_key):
    """从内部 ``<mqtt client id>:mqtt[:connection token]`` 还原 client id。"""
    text = str(source_key or '')
    marker = ':mqtt'
    index = text.rfind(marker)
    if index >= 0 and (index + len(marker) == len(text) or text[index + len(marker)] == ':'):
        return text[:index]
    return text or None


def _broker_publish_command(cmd, target_ids=None):
    """通过内嵌 Broker 向目标 FAshe 会话定向下发指令。"""
    payload_str = json.dumps(cmd, ensure_ascii=False)
    # 目标设备的 ``_source`` 是 bridge 在注册/状态包中确认过的会话，
    # 它比 payload 中可伪造的 IP、Group 或名称可靠。没有已确认会话时
    # 返回 0，让 HTTP 层明确报告“目标未在线”，不广播给其它接收机。
    target_ids = list(target_ids or [])
    client_ids = set()
    target_devices = []
    expected_sessions = {}
    with _state_lock:
        for device_id in target_ids:
            device = _state['devices'].get(device_id)
            if not device:
                continue
            if cmd.get('command') == 'set_freq' and 'expected_brand' in cmd:
                expected_brand = _normalize_device_brand(cmd['expected_brand'])
                if not expected_brand or expected_brand != _normalize_device_brand(device.get('brand')):
                    _log("CMD", "拒绝下发: 规划品牌与当前目标接收机品牌不一致")
                    return 0
            client_id = _mqtt_client_id_from_source(device.get('_source'))
            if client_id:
                target_devices.append((client_id, dict(device)))
    for client_id, device in target_devices:
        with _broker_lock:
            session = _broker_clients.get(client_id)
            principal = session.get('pairing') if session else None
            token = session.get('connection_token') if session else None
        channel = _channel_from_payload(device, None)
        if (not _pairing_policy.is_active(principal)
                or device.get('_source') != _mqtt_source_key(client_id, token)
                or device.get('_receiver_id', device.get('receiver_id')) != principal['receiver_id']
                or device.get('receiver_mac') != principal['receiver_mac']
                or _normalize_device_brand(device.get('brand')) != _normalize_device_brand(principal['brand'])
                or channel is None or not 1 <= channel <= principal['max_channels']):
            _log('CMD', '拒绝下发：目标快照与当前配对会话/品牌/CH 不一致')
            return 0
        client_ids.add(client_id)
        expected_sessions[client_id] = session
    if not client_ids:
        _log("CMD", "警告: 目标设备没有已确认的 MQTT 会话")
        return 0
    sent = _broker_publish_topic(MQTT_TOPIC_DOWN, payload_str, client_ids, expected_sessions)

    if sent > 0:
        _log("CMD", f"指令已定向发送给 {sent} 个目标客户端: {', '.join(sorted(client_ids))}")
    else:
        _log("CMD", f"警告: 没有订阅 {MQTT_TOPIC_DOWN} 的在线客户端")
    return sent


def _clock_sync_loop():
    """周期广播服务器主时钟；Broker 尚未就绪时静默等待下一周期。"""
    # 让 Broker 有时间完成监听，同时避免启动瞬间产生无订阅日志。
    time.sleep(1)
    while True:
        try:
            payload = _clock_sync_payload()
            sent = _broker_publish_topic(
                MQTT_TOPIC_CLOCK_SYNC,
                json.dumps(payload, ensure_ascii=False),
            )
            if sent:
                _log('CLOCK', f"主时钟广播 seq={payload['sequence']} → {sent} 个 FAshe")
        except Exception as error:
            _log('CLOCK', f'主时钟广播失败: {error}')
        time.sleep(CLOCK_SYNC_INTERVAL_SECONDS)


# ════════════════════════════════════════════════════════════════════
#  HTTP API 服务器（端口 8802）
# ════════════════════════════════════════════════════════════════════

class DatyAPIHandler(HttpTransportMixin, BaseHTTPRequestHandler):


    # SSE / 控制是短报文；禁用 Nagle 聚包等待。
    disable_nagle_algorithm = True

    def log_message(self, fmt, *args):
        path = urlparse(self.path).path
        if path != '/api/updates':
            _log("HTTP", f"{self.address_string()} → {self.command} {path}")

    def _cors_headers(self):
        if getattr(self, '_enrollment_request', False):
            origin = self.headers.get('Origin')
            if origin in ENROLLMENT_ORIGINS:
                self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('X-Content-Type-Options', 'nosniff')
            return
        self._http_headers()

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        # 设备状态和命令 ACK 是实时数据；禁止浏览器/代理复用旧响应，
        # 否则前端轮询同一个 command_id 可能永远看到 published。
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if urlparse(self.path).path in ('/api/receivers/challenge', '/api/receivers/enroll'):
            self._handle_enrollment(options=True)
            return
        self._http_options()

    def _handle_enrollment(self, options=False):
        # Separate receiver proof boundary; direct HTTP control cannot register MQTT identities.
        # A file:// / localhost FAshe may use this route, not /api/command.
        self._enrollment_request = True
        self.close_connection = True
        origins = self.headers.get_all('Origin', [])
        try:
            if getattr(self.server, 'transport_security', None) != 'tls-v1':
                raise EnrollmentError(503, 'TLS_REQUIRED', '自动接入仅支持 HTTPS')
            if len(origins) > 1 or (origins and origins[0] not in ENROLLMENT_ORIGINS):
                raise EnrollmentError(403, 'ORIGIN_FORBIDDEN', '不允许的模拟接收机页面来源')
            if options:
                method = self.headers.get('Access-Control-Request-Method', 'POST')
                headers = {v.strip().lower() for v in self.headers.get('Access-Control-Request-Headers', '').split(',') if v.strip()}
                if method != 'POST' or headers - {'content-type'}:
                    raise EnrollmentError(403, 'CORS_FORBIDDEN', '不支持的自动接入请求')
                self.send_response(204)
                self.send_header('Content-Length', '0')
                self._cors_headers()
                self.end_headers()
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,5}', lengths[0]) or int(lengths[0]) > 8192:
                raise EnrollmentError(413, 'BODY_TOO_LARGE', '接入请求不能超过 8 KiB')
            body = self._read_json_body()
            enrollment = getattr(self.server, 'receiver_enrollment', None) or _receiver_enrollment
            method = enrollment.challenge if urlparse(self.path).path.endswith('/challenge') else enrollment.complete
            self._json(method(body, self.client_address[0]))
        except EnrollmentError as error:
            self._json(dict(success=False, code=error.code, error=str(error)), status=error.status)
        except HttpRequestError as error:
            self._json(dict(success=False, code=error.code, error=str(error)), status=error.status)
        except (ValueError, OSError, RuntimeError):
            self._json(dict(success=False, code='ENROLLMENT_UNAVAILABLE', error='接入登记暂不可用，请检查服务器配置后重试'), status=503)

    def do_GET(self):
        if not self._check_origin():
            return
        parsed = urlparse(self.path)
        path   = parsed.path
        if path.startswith('/api/database/') and server_storage_api.handle(self, 'GET', self.path, db_session=_db_session,
                read_json=business_api.read_json, actor=business_api.network_actor(self), archive=get_server_archive_service()):
            return
        if business_api.handle(self, 'GET', self.path, db_session=_db_session, actor=business_api.network_actor(self),
                live_reader=business_api.live_reader(_clock_state['server_id']), runtime_status=get_unified_runtime_status):
            return

        if path == '/api/devices':
            with _state_lock:
                snapshot = _get_devices_snapshot()
            self._json({
                'success': True,
                'devices': snapshot,
                'count':   len(snapshot),
                'clock_source': 'fuwuqi',
                'server_time_ms': int(time.time() * 1000),
                'ts':      time.time(),
            })

        elif path.startswith('/api/commands/'):
            command_id = path.rsplit('/', 1)[-1]
            with _state_lock:
                record = _state['commands'].get(command_id)
                command = _command_public_view(record) if record else None
            if command:
                self._json({'success': True, 'command': command})
            else:
                self._json({'success': False, 'error': '命令不存在或已过期'}, status=404)

        elif path == '/api/commands':
            with _state_lock:
                commands = [_command_public_view(record) for record in _state['commands'].values()]
            commands.sort(key=lambda item: item.get('created_at', 0), reverse=True)
            self._json({'success': True, 'commands': commands, 'count': len(commands)})

        elif path == '/api/projects' or path.startswith('/api/projects/'):
            project_api_get(self, path, db_session=_db_session)

        elif path == '/api/timeline':
            query = parse_qs(parsed.query)
            limit = max(1, min(1000, int(query.get('limit', ['200'])[0])))
            clauses, values = [], []
            for field, column in [('project_id', 'project_id'), ('device_id', 'device_id'), ('event_type', 'event_type')]:
                if query.get(field): clauses.append(f'{column}=?'); values.append(query[field][0])
            sql = 'SELECT * FROM timeline_events' + ((' WHERE ' + ' AND '.join(clauses)) if clauses else '') + ' ORDER BY ts DESC LIMIT ?'
            values.append(limit)
            with _db_lock, _db_session() as connection:
                rows = connection.execute(sql, values).fetchall()
            events = []
            for row in rows:
                event = dict(row); event['details'] = json.loads(event.pop('details_json') or '{}'); events.append(event)
            self._json({'success': True, 'events': events, 'count': len(events)})

        elif path == '/api/discovery/shure/status':
            self._json({'success': True, **_shure_discovery.snapshot()})

        elif path == '/api/capabilities':
            self._json({'success': True, 'adapters': {
                'fashe-mqtt': {'discover': True, 'read_frequency': True, 'write_frequency': True, 'read_rf': True, 'read_af': True, 'mute': True, 'scan': False, 'read_only': False},
                'shure-scp': {'discover': True, 'read_frequency': True, 'write_frequency': True, 'read_rf': True, 'read_af': True, 'mute': True, 'scan': False, 'read_only': False, 'confirmation':'post-write-readback', 'frequency_requires_verified_band':True},
                'unknown-readonly': {'discover': False, 'read_frequency': False, 'write_frequency': False, 'read_rf': False, 'read_af': False, 'mute': False, 'scan': False, 'read_only': True},
            }})

        elif path == '/api/stats':
            with _state_lock:
                snapshot = _get_devices_snapshot()
                stats = dict(_state['stats'])
                # 过滤出活跃 clients（30 秒内有消息），并清理过期的
                now = time.time()
                active_clients = []
                expired_keys = []
                for key, info in _state['clients'].items():
                    last_seen = info.get('_last_seen', 0)
                    if now - last_seen < CLIENT_TTL_SECONDS:
                        c = {k: v for k, v in info.items() if not k.startswith('_')}
                        c['_online'] = True
                        c['_age_s'] = round(now - last_seen, 1)
                        active_clients.append(c)
                    else:
                        expired_keys.append(key)
                # 清理过期 clients
                for key in expired_keys:
                    del _state['clients'][key]
                    # 同时清理该 client 对应的离线设备
                    _state['devices'] = {
                        did: d for did, d in _state['devices'].items()
                        if d.get('_source') != key or (now - d.get('_last_seen', 0)) < 60
                    }
                stats['connected_clients'] = len(active_clients)
            with _broker_lock:
                broker_info = {
                    'ws_clients': len(_broker_clients),
                    'client_list': [
                        {'client_id': cid, 'addr': info['remote_addr'], 'subscriptions': list(info['subscriptions'])}
                        for cid, info in _broker_clients.items()
                    ],
                }
            self._json({
                'success':          True,
                'stats':            stats,
                'device_count':     len(snapshot),
                'online_count':     sum(1 for d in snapshot if d.get('_online')),
                'sse_client_count': len(_state['sse_queues']),
                'clients':          active_clients,
                'broker':           broker_info,
                'mqtt_dispatch':    _mqtt_dispatch_status(),
                'external_receivers': _shure_discovery.snapshot()['receivers'],
                'clock':            _clock_status_snapshot(),
                'clock_source':     'fuwuqi',
                'server_time_ms':   int(time.time() * 1000),
                'ts':               time.time(),
            })

        elif path == '/health':
            with _broker_lock:
                ws_clients = len(_broker_clients)
            self._json({
                'status':          'ok',
                'service':         f'DATY RF PRO MQTT Bridge v{BRIDGE_VERSION} (Embedded Broker)',
                'version':         APP_VERSION,
                'app_version':     APP_VERSION,
                'bridge_version':  BRIDGE_VERSION,
                'frequency_validation': 'integer-khz-p0-2026-09-10',
                'mqtt_broker':     'embedded',
                'mqtt_connected':  True,
                'ws_port':         WS_PORT,
                'ws_clients':      ws_clients,
                'http_port':       HTTP_PORT,
                'clock_source':    'fuwuqi',
                'clock_protocol':  CLOCK_PROTOCOL_VERSION,
                'heartbeat_rtt_supported': True,
                'heartbeat_optimization': 'fast-ack-v1',
                'realtime_optimization': 'fashe-realtime-v1',
                'shure_discovery': SHURE_DISCOVERY_PROTOCOL,
                'shure_discovery_enabled': _shure_discovery.enabled,
                'mute_request_tracking': 'request-ack-v2',
                'control_access': HTTP_PROTOCOL,
                'control_auth_required': False,
                'mqtt_pairing': PAIRING_PROTOCOL,
                'pairing_configured': _pairing_policy.configured(),
                'auto_pairing': AUTO_PROTOCOL,
                'auto_pairing_enabled': _receiver_enrollment.enabled(),
                'group_assignment': 'server-fifo-v1',
                'transport_security': getattr(self.server, 'transport_security', 'isolated-handler'),
                'clock_server_id': _clock_state['server_id'],
                'server_time_ms':  int(time.time() * 1000),
                'ts':              time.time(),
            })

        elif path == '/api/clock':
            self._json({'success': True, 'clock': _clock_status_snapshot()})

        elif path == '/api/updates':
            self._handle_sse()

        else:
            self._json({'success': False, 'error': 'Not Found'}, status=404)

    def do_POST(self):
        if urlparse(self.path).path in ('/api/receivers/challenge', '/api/receivers/enroll'):
            self._handle_enrollment()
            return
        if not self._check_origin():
            return
        parsed = urlparse(self.path)
        path   = parsed.path
        if path.startswith('/api/database/') and server_storage_api.handle(self, 'POST', self.path, db_session=_db_session,
                read_json=business_api.read_json, actor=business_api.network_actor(self), archive=get_server_archive_service()):
            return
        if business_api.handle(self, 'POST', self.path, db_session=_db_session, actor=business_api.network_actor(self),
                runtime_status=get_unified_runtime_status):
            return
        routes = {'/api/command', '/api/projects', '/api/coordination-runs', '/api/timeline/events',
                  '/api/discovery/shure/scan', '/api/discovery/shure/cancel'}
        if path not in routes:
            self.close_connection = True
            self._json({'success': False, 'error': 'Not Found'}, status=404)
            return
        try:
            request_body = self._read_json_body()
        except HttpRequestError as error:
            self._http_failure(error)
            return

        if path in ('/api/discovery/shure/scan', '/api/discovery/shure/cancel'):
            if request_body:
                self._json({'success': False, 'error': '扫描请求仅接受空对象；目标由服务器网卡配置决定'}, status=400)
                return
            result = (_shure_discovery.request_scan() if path.endswith('/scan') else _shure_discovery.cancel_scan())
            self._json({'success': True, **result})

        elif path == '/api/projects':
            project_api_save(self, request_body, business_api.network_actor(self), db_session=_db_session,
                             now=time.time, new_id=lambda: uuid.uuid4().hex)

        elif path == '/api/timeline/events':
            try:
                body = request_body
                event_type = str(body.get('event_type') or '').strip()
                summary = str(body.get('summary') or '').strip()
                if not event_type or not summary:
                    self._json({'success': False, 'error': 'event_type 和 summary 必填'}, status=400); return
                if event_type.startswith(('command.', 'access.', 'project.', 'coordination.')):
                    self._json({'success': False, 'error': '此事件类型仅允许服务器产生'}, status=400); return
                details = {'client_details': body.get('details'), 'actor': self._request_actor()}
                _record_timeline(event_type, summary, body.get('device_id'), body.get('command_id'), details, body.get('project_id') or 'default')
                self._json({'success': True})
            except Exception as error:
                self._json({'success': False, 'error': str(error)}, status=400)

        elif path == '/api/coordination-runs':
            try:
                body = request_body
                run_id, project_id, now = uuid.uuid4().hex, str(body.get('project_id') or 'default'), time.time()
                with _db_lock, _db_session() as connection:
                    connection.execute('INSERT INTO coordination_runs(id,project_id,input_json,result_json,baseline_json,created_at) VALUES(?,?,?,?,?,?)',
                      (run_id, project_id, _json_text(body.get('input') or {}), _json_text(body.get('result') or {}), _json_text(body.get('baseline')) if body.get('baseline') is not None else None, now))
                _record_timeline('coordination.completed', '频率协调计算完成', details={'run_id': run_id, 'actor': self._request_actor()}, project_id=project_id)
                self._json({'success': True, 'run_id': run_id})
            except Exception as error:
                self._json({'success': False, 'error': str(error)}, status=400)

        elif path == '/api/command':
            try:
                cmd = request_body
                # Never accept a caller-supplied actor or forward credentials.
                cmd.pop('actor', None)
                cmd.pop('_authorized_actor', None)
                cmd.pop('authorization', None)
                cmd.pop('token', None)
                cmd['_request_actor'] = dict(self._request_actor())
                _log("CMD", f"控制请求来源: {self.client_address[0]}")

                try:
                    client_request_id = cmd.get('client_request_id')
                    if client_request_id is not None and (not isinstance(client_request_id, str)
                            or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', client_request_id)):
                        self._json({'success': False, 'error': '无效的请求关联编号'}, status=400)
                        return
                    command_name = cmd.get('command')
                    if command_name not in ('mute', 'unmute', 'set_freq'):
                        self._json({'success': False, 'error': '不支持的命令'}, status=400)
                        return
                    if command_name == 'set_freq':
                        if 'expected_brand' in cmd:
                            expected_brand = _normalize_device_brand(cmd['expected_brand'])
                            if not expected_brand:
                                self._json({'success': False, 'error': '规划目标品牌 expected_brand 必须为非空品牌字符串，未下发'}, status=400)
                                return
                            cmd['expected_brand'] = expected_brand
                        target_khz = _normalize_frequency_khz(cmd.get('value'), 'MHz')
                        if target_khz is None:
                            self._json({'success': False, 'error': '频率值无效或精度小于 1 kHz，未下发'}, status=400)
                            return
                        target_mhz = target_khz / 1000.0
                        if not 400 <= target_mhz <= 900:
                            self._json({'success': False, 'error': '频率必须位于 400～900 MHz'}, status=400)
                            return
                        cmd['value'] = target_mhz
                    else:
                        cmd['value'] = command_name == 'mute'

                    with _state_lock:
                        target_ids = _resolve_command_targets_locked(cmd)
                        target_device = dict(_state['devices'].get(target_ids[0], {})) if len(target_ids) == 1 else {}
                    if len(target_ids) != 1:
                        self._json({'success': False, 'error': '无法唯一定位目标设备；必须提供稳定 device_id、IP 和通道'}, status=409)
                        return
                    if command_name == 'set_freq':
                        target_brand = _normalize_device_brand(target_device.get('brand'))
                        if 'expected_brand' in cmd and cmd['expected_brand'] != target_brand:
                            self._json({'success': False, 'error': '规划品牌与目标接收机品牌不一致，未下发',
                                        'expected_brand': cmd['expected_brand'], 'target_brand': target_brand}, status=409)
                            return
                        # 不信任请求中的 brand；转发和 ACK 记录均使用登记的真实目标品牌。
                        cmd['brand'] = target_brand
                    capabilities = _device_capabilities(target_device, target_device)
                    required_capability = 'write_frequency' if command_name == 'set_freq' else 'mute'
                    if not capabilities.get(required_capability, False):
                        self._json({'success': False, 'error': f"设备适配器 {capabilities.get('adapter')} 不允许 {command_name}", 'capabilities': capabilities}, status=403)
                        return

                    cmd['type'] = 'device_command'
                    # 事务编号由服务器生成，避免客户端复用旧编号命中历史 ACK。
                    cmd['command_id'] = uuid.uuid4().hex
                    cmd['device_id'] = target_ids[0]
                    device_channel = target_device.get('channel_number')
                    if device_channel is None:
                        device_channel = _channel_from_payload(target_device, None)
                    if device_channel is None:
                        self._json({'success': False, 'error': '目标设备缺少有效 CH 通道号'}, status=409)
                        return
                    cmd['channel'] = device_channel
                    cmd['channel_number'] = device_channel
                    cmd['channel_key'] = _channel_key(device_channel)
                    cmd['receiver_id'] = target_device.get('_receiver_id') or target_device.get('receiver_id')
                    cmd['receiver_ip'] = target_device.get('receiver_ip') or target_device.get('ip')
                    cmd['receiver_mac'] = target_device.get('receiver_mac')
                    # ip/mac 仍保留为兼容别名，但不再单独承担目标定位。
                    cmd['ip'] = cmd.get('ip') or cmd.get('receiver_ip')
                    if cmd.get('receiver_mac'):
                        cmd['mac_address'] = cmd['receiver_mac']
                    if target_device.get('group') is not None:
                        cmd['group'] = target_device.get('group')
                    sent_count, record = _publish_tracked_command(cmd, target_ids)

                    if sent_count <= 0:
                        _push_sse_event('command_update', _command_public_view(record))
                        self._json({
                            'success': False,
                            'accepted': False,
                            'error': record['error'],
                            'command': _command_public_view(record),
                        }, status=503)
                        return

                    # 静音/取消静音必须以 FAshe 的真实 up 状态作为唯一确认。
                    # 这里不能先改 _state['devices']：HTTP 200 只说明命令已
                    # 定向写入 MQTT，会话可能随后断线、拒绝目标或执行失败。
                    # 设备回报后，_process_mqtt_message() 才会更新 muted，
                    # 并由 _reconcile_commands_for_device() 标记 ACK。
                    if command_name in ('mute', 'unmute'):
                        updated_ids = []
                        _log("CMD", f"静音指令已发布，等待设备真实状态回报: {cmd.get('device_id')} CH{cmd.get('channel_number')}")

                    _push_sse_event('command_update', _command_public_view(record))
                    self._json({
                        'success': True,
                        'accepted': True,
                        'message': '指令已发布，等待设备状态确认',
                        'cmd': cmd,
                        'command_id': record['command_id'],
                        'status': record['status'],
                        'command_record': _command_public_view(record),
                        'updated_device_ids': updated_ids if cmd.get('command') in ('mute', 'unmute') else [],
                    })
                except Exception as e:
                    self._json({'success': False, 'error': f'发送失败: {e}'}, status=500)
            except Exception as e:
                self._json({'success': False, 'error': str(e)}, status=400)
        else:
            self._json({'success': False, 'error': 'Not Found'}, status=404)

    def _handle_sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self._cors_headers()
        self.end_headers()

        q = queue.Queue(maxsize=50)
        try:
            # 登记队列与读取快照原子执行，消除首个快照到订阅之间的漏包窗口。
            with _state_lock:
                _state['sse_queues'].append(q)
                snapshot = _get_devices_snapshot()
            self._sse_write('device_list', {'devices': snapshot, 'server_time_ms': int(time.time() * 1000), 'ts': time.time()})
            while True:
                try:
                    payload = q.get(timeout=20)
                    if payload is None:
                        self.close_connection = True
                        return
                    data = json.loads(payload)
                    self._sse_write(data.get('type', 'update'), data)
                except queue.Empty:
                    self.wfile.write(b': heartbeat\n\n')
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            _log("SSE", f"连接断开: {type(e).__name__}")
        finally:
            with _state_lock:
                try:
                    _state['sse_queues'].remove(q)
                except ValueError:
                    pass

    def _sse_write(self, event, data):
        try:
            payload = json.dumps(data, ensure_ascii=False)
            msg = f"event: {event}\ndata: {payload}\n\n"
            self.wfile.write(msg.encode('utf-8'))
            self.wfile.flush()
        except Exception:
            raise


# ════════════════════════════════════════════════════════════════════
#  防火墙
# ════════════════════════════════════════════════════════════════════

def _ensure_firewall_rules():
    if platform.system() != 'Windows':
        return

    rules = [
        ('DATY_RF_PRO_MQTT_Bridge', HTTP_PORT, 'DATY RF PRO MQTT Bridge HTTP API'),
        ('DATY_RF_PRO_MQTT_WS_Broker', WS_PORT, 'DATY RF PRO MQTT WebSocket Broker'),
    ]

    for rule_name, port, desc in rules:
        cmd = (
            f'netsh advfirewall firewall show rule name="{rule_name}" >nul 2>&1 '
            f'|| netsh advfirewall firewall add rule name="{rule_name}" '
            f'dir=in action=allow protocol=tcp localport={port} '
            f'profile=any description="{desc}"'
        )
        try:
            subprocess.run(
                cmd, shell=True, capture_output=True, timeout=10,
                text=True, encoding='gbk', errors='replace'
            )
            _log("FW", f"防火墙规则已就绪（端口 {port} 已放行）")
        except Exception as e:
            _log("FW", f"防火墙检查跳过(端口 {port}): {e}")


# ════════════════════════════════════════════════════════════════════
#  启动入口
# ════════════════════════════════════════════════════════════════════

def main():
    from tls_support import server_context, bind_https
    # Validate certificates before database work or starting ANY listener.
    tls_context = server_context()
    _init_database()
    # 启动器会按 requirements.txt 安装依赖；直接运行时仅给出明确错误。
    try:
        import websockets
    except ImportError:
        print("=" * 60)
        print("  [ERROR] 缺少 websockets，请先执行：")
        print("  python -m pip install -r requirements.txt")
        print("=" * 60)
        sys.exit(1)

    # Unified schema is migrated by _init_database(); a failed bootstrap is fatal.
    _start_unified_runtime()

    # 获取本机 IP
    local_ip = '127.0.0.1'
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    print("=" * 60)
    print("  DATY RF PRO — MQTT 数据桥接服务 v2.0")
    print("  (内嵌 MQTT Broker，无需外部 EMQX)")
    print("=" * 60)
    print(f"  本机 IP:         {local_ip}")
    print(f"  MQTT Broker:     内嵌 (embedded)")
    print(f"  WebSocket 端口:  {WS_PORT}  ← FAshe 连接此处")
    print(f"  订阅主题:        {MQTT_TOPIC_REGISTER}")
    print(f"                   {MQTT_TOPIC_UP}")
    print(f"  主时钟广播:       {MQTT_TOPIC_CLOCK_SYNC} (每 {CLOCK_SYNC_INTERVAL_SECONDS} 秒)")
    print(f"  校时回执:         {MQTT_TOPIC_CLOCK_ACK}")
    print(f"  发布主题:        {MQTT_TOPIC_DOWN}")
    print(f"  HTTPS API:       https://127.0.0.1:{HTTP_PORT}")
    print(f"  设备数据:        https://127.0.0.1:{HTTP_PORT}/api/devices")
    print(f"  实时推送:        https://127.0.0.1:{HTTP_PORT}/api/updates (SSE)")
    print(f"  健康检查:        https://127.0.0.1:{HTTP_PORT}/health")
    print()
    print(f"  ★ FAshe 连接地址: wss://{local_ip}:{WS_PORT}/mqtt（独立接收机配对凭据）")
    print("  按 Ctrl+C 停止服务")
    print("=" * 60)

    # Network policy is an explicit administrator deployment step. Starting a
    # service must not silently create or widen Windows inbound firewall rules.

    # 后台清理离线会话和设备，不再依赖前端访问 /api/stats 才触发。
    cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
    cleanup_thread.start()

    # 服务器主时钟：周期向所有已订阅的 FAshe 广播校时包。
    clock_thread = threading.Thread(target=_clock_sync_loop, daemon=True)
    clock_thread.start()

    # 在独立线程启动 MQTT Broker（asyncio）
    broker_thread = threading.Thread(
        target=lambda: asyncio.run(_start_broker()),
        daemon=True
    )
    broker_thread.start()

    # 等待 Broker 启动
    time.sleep(1)

    # 在主线程启动 HTTP API 服务器（阻塞）
    try:
        http_server = bind_https(ThreadingHTTPServer, ('0.0.0.0', HTTP_PORT), DatyAPIHandler, tls_context)
        _shure_discovery.start()
        http_server.serve_forever()
    except KeyboardInterrupt:
        print("\n[服务] 已停止")
        http_server.server_close()
    finally:
        _shure_discovery.stop()


if __name__ == '__main__':
    main()
