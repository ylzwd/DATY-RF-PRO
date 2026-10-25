"""Removed history surfaces. Live telemetry, command receipts and settings remain.

Enforce before preparing an operation/transaction, including uploaded RPCs.
Database revision metadata for retained resources is NOT an optional history log.
"""
RETIRED_KINDS=frozenset({'scans','scan_current','simulation_settings','planning_records','planning_current','planning_runs','alerts'})
RETIRED_METHODS=frozenset({'database.draft.get','database.draft.save','database.activity.list','database.activity.get',
    'database.business_snapshot','database.import.preview','database.import.commit','planning.run.create',
    'timeline.list','timeline.append','storage.status'})
CODE='DATA_FEATURE_RETIRED'
MESSAGE='扫描资料、频率方案、告警审计和服务器存档已停用；当前操作未保存。'

class RetiredDataError(ValueError):
    code=CODE
    status=410
    def __init__(self):super().__init__(MESSAGE)

def check_resource(kind,value=None,*,external=False):
    if kind in RETIRED_KINDS or (external and kind=='legacy_snapshots'):
        raise RetiredDataError()
    if kind=='profiles' and isinstance(value,dict) and value.get('source')=='planning-snapshot':
        raise RetiredDataError()

def check_request(method,body):
    if method in RETIRED_METHODS or method.startswith(('archives.','exports.','cleanups.')):
        raise RetiredDataError()
    if method=='downloads.open' and body.get('category') in ('archives','exports'):
        raise RetiredDataError()
    if method.startswith('database.'):
        check_resource(body.get('kind'),body.get('value'),external=True)
    if method=='database.batch':
        for write in body.get('writes',[]) if isinstance(body.get('writes'),list) else []:
            if isinstance(write,dict):check_resource(write.get('kind'),write.get('value'),external=True)
    if method=='projects.save':
        # Keep project metadata/device settings; no old-client history backdoor.
        data=body.get('data')
        if isinstance(data,dict) and any(k in data for k in ('planningHistory','currentPlanningRecordId','constraints','constraintFields','scans','alerts','last_coordination_at')):
            raise RetiredDataError()

def capabilities():
    return {'version':'daty-data-retirement-v1','retired':['scans','planning','alerts_audit','archives'],
        'live_telemetry':True,'device_command_receipts':True,'settings_revision_receipts':True,'history_persistence':False}
