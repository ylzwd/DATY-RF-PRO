"""Fixed candidate domain tests: in-memory SQLite only, no live devices/data."""
import copy
import json
from pathlib import Path
import sqlite3
import unittest

from unified_domains import (DomainError, KINDS, TABLES, project_document,
                             schema_statements, validate_document)


def profile():
    value = json.loads((Path(__file__).resolve().parents[1] / 'profiles' / 'equipment-profile.template.json').read_text(encoding='utf-8'))
    value['id'] = 'test-daty'
    value['manufacturer'] = 'DATYaudio'
    value['coordinationGrid'] = {'stepKHz': 250, 'originKHz': 0}
    return value


def record(identifier='r1', project='p1'):
    constraints = {'excludedRanges': [{'id': 'e1', 'startKHz': 645000, 'endKHz': 646000, 'reason': '电视'}],
        'lockedAssignments': [{'deviceId': 1, 'frequencyKHz': 641000, 'reason': '主持人'}],
        'knownCarriers': [{'id': 'k1', 'frequencyKHz': 650000, 'guardKHz': 250, 'reason': '对讲'}], 'backupCount': 2}
    return {'id': identifier, 'type': 'daty_rf_planning', 'version': '1.0.3', 'projectId': project,
        'projectName': '测试项目', 'timestamp': 1000, 'channels': 2, 'name': '原格式规划',
        'constraints': constraints, 'options': copy.deepcopy(constraints),
        'constraintFields': {'plannerLockedAssignments': 'CH1=641.000 主持人'},
        'coordination': {'assignments': [{'deviceId': 1, 'brand': 'DATYaudio', 'frequencyKHz': 641000,
            'minimumChannelSpacingKHz': 250, 'channelSpacingKHz': 250, 'intermodSpacingKHz': 150,
            'candidateStepKHz': 250, 'coordinationGrid': {'stepKHz': 250, 'originKHz': 0},
            'backupFrequenciesKHz': [651000, 652000]}]},
        'devices': [{'id': 1, '_fasheId': 'fixture_ch1', 'receiver_id': 'fixture', 'channel_number': 1,
            'brand': 'DATYaudio', 'freq': 641000, 'planned': 641000, '_source': 'fashe-fixture'},
            {'id': 2, 'brand': 'Shure', 'freq': None, 'planned': None}], 'futureMetadata': {'a': 1}}


def alert(ended=False):
    value = {'archiveId': 'a1', 'firstSeen': 1000, 'lastSeen': 1100, 'archiveState': 'active',
             'deviceId': 'fixture_ch1', 'metric': 'rf', 'level': 'warn', 'value': None,
             'threshold': -90, '_source': 'real-fixture'}
    if ended:
        value.update(archiveState='ended', endedAt=1200)
    return value


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('CREATE TABLE projects(id TEXT PRIMARY KEY)')
        self.db.executemany('INSERT INTO projects VALUES(?)', [('p1',), ('p2',), ('other',)])
        for statement in schema_statements():
            self.db.execute(statement)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def put(self, kind, identifier, value, revision=1, deleted=False):
        with self.db:
            self.db.execute('BEGIN')
            return project_document(self.db, kind, identifier, value, revision, deleted)

    def test_schema_is_single_statements_and_complete_table_columns(self):
        for statement in schema_statements():
            self.db.execute(statement)
        names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(names, set(TABLES) | {'projects'})
        for table, required in TABLES.items():
            self.assertEqual(required, {row[1] for row in self.db.execute('PRAGMA table_info(' + table + ')')})
        self.assertTrue(all(name.startswith('biz_') for name in names - {'projects'}))

    def test_requires_caller_transaction_no_implicit_commit(self):
        with self.assertRaisesRegex(DomainError, 'transaction'):
            project_document(self.db, 'settings', 'alert_sound', {'enabled': True}, 1)
        self.db.execute('BEGIN')
        project_document(self.db, 'settings', 'alert_sound', {'enabled': True}, 1)
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_settings').fetchone()[0], 0)

    def test_settings_limits_and_unknown_nonsecret_metadata(self):
        values = {'rfWeakDbm': -90, 'batteryLowPercent': 5, 'afOverloadDbfs': 0, 'future': {'label': '保留'}}
        self.put('settings', 'alert_thresholds', values)
        row = self.db.execute('SELECT rf_weak_dbm,battery_low_percent,af_overload_dbfs,metadata_json FROM biz_settings').fetchone()
        self.assertEqual(row[:3], (-90, 5, 0))
        self.assertEqual(json.loads(row[3]), values)
        for field, bad in [('rfWeakDbm', -91), ('rfWeakDbm', -29), ('batteryLowPercent', 4),
                           ('batteryLowPercent', 51), ('afOverloadDbfs', -41), ('afOverloadDbfs', 1),
                           ('rfWeakDbm', '-50'), ('afOverloadDbfs', False)]:
            with self.subTest(field=field, bad=bad), self.assertRaises(DomainError):
                validate_document('settings', 'alert_thresholds', {**values, field: bad})

    def test_battery_bar_threshold_is_optional_bounded_and_persisted(self):
        values={'rfWeakDbm':-90,'batteryLowPercent':20,'afOverloadDbfs':-3,'batteryLowBars':1}
        self.put('settings','alert_thresholds',values)
        stored=json.loads(self.db.execute('SELECT metadata_json FROM biz_settings').fetchone()[0])
        self.assertEqual(stored['batteryLowBars'],1)
        for valid in (0,5):validate_document('settings','alert_thresholds',{**values,'batteryLowBars':valid})
        for bad in (-1,6,1.5,True,'1'):
            with self.subTest(bad=bad),self.assertRaises(DomainError):
                validate_document('settings','alert_thresholds',{**values,'batteryLowBars':bad})

    def test_boolean_setting_and_legacy_ids(self):
        for key in ('alert_sound', 'auto_frequency', 'daty_alert_sound_v1', 'daty_auto_frequency_v1'):
            self.put('settings', key, {'enabled': False})
        for bad in (0, 1, None, 'true'):
            with self.assertRaises(DomainError):
                validate_document('settings', 'alert_sound', {'enabled': bad})

    def test_profile_complete_normalized_children_and_provenance(self):
        value = profile()
        value['_source'] = {'importFile': 'example.json'}
        self.put('profiles', value['id'], value)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_profile_models').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_profile_bands').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_profile_modes').fetchone()[0], 6)
        row = self.db.execute('SELECT minimum_spacing_khz,coordination_step_khz,metadata_json FROM biz_profiles').fetchone()
        self.assertEqual(row[:2], (250, 250))
        self.assertEqual(json.loads(row[2]), value)

    def test_daty_protocol_precision_not_coordination_grid(self):
        value = profile()
        value['frequencyStepKHz'] = 1
        value.pop('coordinationGrid')
        value.pop('minimumChannelSpacingKHz')
        self.put('profiles', value['id'], value)
        self.assertEqual(self.db.execute('SELECT minimum_spacing_khz,coordination_step_khz FROM biz_profiles').fetchone(), (250, 250))

    def test_daty_compact_zero_imd_is_normalized_and_scoped(self):
        value = profile()
        value['compatibility']['more-frequencies']['intermodSpacingKHz'] = 0
        next(m for m in value['modes'] if m['id'] == 'more-frequencies')['settings']['intermodSpacingKHz'] = 0
        self.put('profiles', value['id'], value)
        rows = self.db.execute("SELECT intermod_spacing_khz FROM biz_profile_modes WHERE mode_id='more-frequencies'").fetchall()
        self.assertEqual(rows, [(0,), (0,)])
        for level in ('standard', 'robust'):
            bad = copy.deepcopy(value)
            bad['compatibility'][level]['intermodSpacingKHz'] = 0
            with self.assertRaises(DomainError): validate_document('profiles', bad['id'], bad)
        for brand in ('Shure', 'Sennheiser'):
            bad = copy.deepcopy(value); bad['manufacturer'] = brand
            with self.assertRaises(DomainError): validate_document('profiles', bad['id'], bad)

    def test_planning_record_preserves_explicit_zero_imd_only_for_daty_compact(self):
        value = record(); value['options']['compatibilityLevel'] = 'more-frequencies'
        value['coordination']['assignments'][0]['intermodSpacingKHz'] = 0
        self.put('planning_records', 'r1', value)
        saved = json.loads(self.db.execute('SELECT metadata_json FROM biz_planning_records WHERE id=?', ('r1',)).fetchone()[0])
        self.assertEqual(saved['coordination']['assignments'][0]['intermodSpacingKHz'], 0)
        for level in ('standard', 'robust'):
            bad = copy.deepcopy(value); bad['options']['compatibilityLevel'] = level
            with self.assertRaises(DomainError): validate_document('planning_records', 'r1', bad)
        bad = copy.deepcopy(value); bad['devices'][0]['brand'] = 'Shure'; bad['coordination']['assignments'][0]['brand'] = 'Shure'
        with self.assertRaises(DomainError): validate_document('planning_records', 'r1', bad)

    def test_daty_minimum_grid_and_mode_cannot_be_weakened(self):
        mutations = [lambda p: p.update(minimumChannelSpacingKHz=249),
                     lambda p: p.update(coordinationGrid={'stepKHz': 25, 'originKHz': 0}),
                     lambda p: p.update(coordinationGrid={'stepKHz': 250, 'originKHz': 1}),
                     lambda p: p['compatibility']['standard'].update(channelSpacingKHz=200),
                     lambda p: p['modes'][0]['settings'].update(channelSpacingKHz=100)]
        for mutate in mutations:
            value = profile()
            mutate(value)
            with self.assertRaises(DomainError):
                self.put('profiles', value['id'], value)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_profiles').fetchone()[0], 0)

    def test_profile_matches_original_full_schema_rejections(self):
        mutations = [lambda p: p.update(models=[]), lambda p: p.update(tuningRangeKHz=[640, 690]),
                     lambda p: p.update(priority=True), lambda p: p.update(defaultBandId='absent'),
                     lambda p: p['bands'][0].update(tuningRangeKHz=[400000, 900000]),
                     lambda p: p['bands'][0].update(verified=1),
                     lambda p: p['provenance'].pop('revision'),
                     lambda p: p.update(imdPolicy={'orders': [7], 'includeThreeTone': True}),
                     lambda p: p['modes'].append(copy.deepcopy(p['modes'][0])),
                     lambda p: p.update(source={})]
        for mutate in mutations:
            value = profile()
            mutate(value)
            with self.assertRaises(DomainError):
                validate_document('profiles', value['id'], value)

    def test_all_validation_precedes_any_profile_write(self):
        good = profile()
        self.put('profiles', good['id'], good)
        value = copy.deepcopy(good)
        value['models'] = ['Changed']
        value['modes'][-1]['settings']['scanThresholdDbm'] = 'invalid'
        self.db.execute('BEGIN')
        before = self.db.total_changes
        with self.assertRaises(DomainError):
            project_document(self.db, 'profiles', value['id'], value, 2)
        self.assertEqual(self.db.total_changes, before)
        self.db.rollback()
        self.assertEqual(self.db.execute('SELECT model FROM biz_profile_models').fetchone()[0], good['models'][0])

    def test_sql_failure_rolls_back_whole_caller_transaction(self):
        self.put('profiles', 'test-daty', profile())
        self.db.execute("CREATE TRIGGER fixture_failure BEFORE INSERT ON biz_profile_modes BEGIN SELECT RAISE(ABORT,'fixture'); END")
        changed = profile()
        changed['models'] = ['must rollback']
        with self.assertRaises(sqlite3.IntegrityError):
            self.put('profiles', 'test-daty', changed, 2)
        self.assertEqual(self.db.execute('SELECT revision FROM biz_profiles').fetchone()[0], 1)
        self.assertNotEqual(self.db.execute('SELECT model FROM biz_profile_models').fetchone()[0], 'must rollback')

    def test_planning_original_format_projection_preserves_units_unknown_and_provenance(self):
        value = record()
        self.put('planning_records', 'r1', value)
        self.assertEqual(self.db.execute('SELECT frequency_khz,planned_khz FROM biz_planning_channels ORDER BY device_key').fetchall(), [(641000, 641000), (None, None)])
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_planning_constraints').fetchone()[0], 8)
        self.assertEqual(self.db.execute('SELECT frequency_khz FROM biz_planning_backups ORDER BY ordinal').fetchall(), [(651000,), (652000,)])
        raw = self.db.execute('SELECT metadata_json FROM biz_planning_records').fetchone()[0]
        self.assertEqual(json.loads(raw), value)
        self.assertEqual(self.db.execute('SELECT receiver_id,channel_number FROM biz_planning_channels WHERE device_key=?', ('n:1',)).fetchone(), ('fixture', 1))

    def test_planning_product_types_and_higher_orders_survive_projection(self):
        for index,products in enumerate(([],['2T7O','2T9O'],['2T3O','2T5O','2T7O','2T9O','3T3O'])):
            identifier='imd-'+str(index);value=record(identifier)
            orders=[order for order in (3,5,7,9) if '2T'+str(order)+'O' in products]
            for field in ('options','constraints'):
                value[field].update(imdProducts=products,imdOrders=orders,includeThreeTone='3T3O' in products,protectCurrentFrequencies=True,lockMonitoringOnly=True)
                value[field]['knownCarriers'][0]['ownerDeviceId']='receiver-current_ch1'
            self.put('planning_records',identifier,value)
            saved=json.loads(self.db.execute('SELECT metadata_json FROM biz_planning_records WHERE id=?',(identifier,)).fetchone()[0])
            self.assertEqual(saved,value)
        # Old records remain valid without a synthetic new field/default.
        legacy=record();self.put('planning_records','r1',legacy)
        saved=json.loads(self.db.execute('SELECT metadata_json FROM biz_planning_records WHERE id=?',('r1',)).fetchone()[0])
        self.assertEqual(saved,legacy)

    def test_planning_product_and_order_validation_rejects_ambiguous_input(self):
        invalid_products=(None,'2T3O',['2T30'],['3T5O'],['2T3O','2T3O'],['3T3O','2T3O'],[3],[True],[[]])
        invalid_orders=(None,'3',[True],[3.0],[11],[3,3],[{}])
        for key,cases in (('imdProducts',invalid_products),('imdOrders',invalid_orders)):
            for invalid in cases:
                value=record();value['options'][key]=invalid
                with self.subTest(key=key,invalid=invalid),self.assertRaises(DomainError):
                    self.put('planning_records','r1',value)
        for key in ('protectCurrentFrequencies','lockMonitoringOnly'):
            for invalid in ('true',1,None):
                value=record();value['options'][key]=invalid
                with self.subTest(key=key,invalid=invalid),self.assertRaises(DomainError):self.put('planning_records','r1',value)
        for invalid in ('',True,0,None,[]):
            value=record();value['constraints']['knownCarriers'][0]['ownerDeviceId']=invalid
            with self.subTest(owner=invalid),self.assertRaises(DomainError):self.put('planning_records','r1',value)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_planning_records').fetchone()[0],0)

    def test_planning_scan_sources_preserve_exact_frequencies_and_expanded_range(self):
        value=record()
        value['options'].update(autoExpandRange=True,requestedRangeStartKHz=640000,
            requestedRangeEndKHz=690000,rangeStartKHz=632450,rangeEndKHz=690000,
            planningGridOriginKHz=640000,scanPeakCarriers=[
                {'frequencyKHz':freq,'levelDbm':-42,'startKHz':freq,'endKHz':freq,
                 'id':'scan-peak:'+str(freq),'source':'scan-peak'}
                for freq in (632450,633790,673790)])
        self.put('planning_records','r1',value)
        saved=json.loads(self.db.execute('SELECT metadata_json FROM biz_planning_records WHERE id=?',('r1',)).fetchone()[0])
        self.assertEqual(saved,value)
        self.assertEqual(saved['options']['scanPeakCarriers'][1]['frequencyKHz'],633790)

    def test_planning_scan_sources_reject_invalid_measurements_and_range(self):
        bad_peaks=[None,'632450',{'frequencyKHz':632.450,'levelDbm':-40},
            {'frequencyKHz':True,'levelDbm':-40},{'frequencyKHz':632450,'levelDbm':None},
            {'frequencyKHz':632450,'levelDbm':float('nan')},
            {'frequencyKHz':632450,'levelDbm':-40,'startKHz':632400},
            {'frequencyKHz':632450,'levelDbm':-40,'startKHz':633000,'endKHz':634000},
            {'frequencyKHz':632450,'levelDbm':-40,'guardKHz':0}]
        for peak in bad_peaks:
            value=record();value['options']['scanPeakCarriers']=[peak]
            with self.subTest(peak=peak),self.assertRaises(DomainError):
                validate_document('planning_records','r1',value)
        for fields in ({'autoExpandRange':1},{'planningGridOriginKHz':640.0},
                       {'requestedRangeStartKHz':690000,'requestedRangeEndKHz':640000}):
            value=record();value['options'].update(fields)
            with self.subTest(fields=fields),self.assertRaises(DomainError):
                validate_document('planning_records','r1',value)

    def test_planning_rejects_fractional_mhz_boolean_and_daty_downgrade(self):
        mutations = [lambda p: p['devices'][0].update(freq=641.25),
                     lambda p: p['devices'][0].update(planned=True),
                     lambda p: p['constraints']['lockedAssignments'][0].update(frequencyKHz=641.25),
                     lambda p: p['constraints']['knownCarriers'][0].update(guardKHz=0),
                     lambda p: p['options'].update(backupCount=5),
                     lambda p: p['coordination']['assignments'][0].update(channelSpacingKHz=249),
                     lambda p: p['coordination']['assignments'][0].update(candidateStepKHz=300),
                     lambda p: p['coordination']['assignments'][0].update(brand='Shure'),
                     lambda p: p['options'].update(scanPoints=[{'frequencyKHz': 641.5, 'levelDbm': -80}])]
        for mutate in mutations:
            value = record()
            mutate(value)
            with self.assertRaises(DomainError):
                self.put('planning_records', 'r1', value)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_planning_records').fetchone()[0], 0)

    def test_current_requires_existing_same_project_record(self):
        self.put('planning_records', 'r1', record())
        with self.assertRaises(DomainError):
            self.put('planning_current', 'other', {'projectId': 'other', 'currentRecordId': 'r1', 'deletedRecordIds': []})
        self.put('planning_current', 'p1', {'projectId': 'p1', 'currentRecordId': 'r1', 'deletedRecordIds': []})
        with self.assertRaises(DomainError):
            self.put('planning_records', 'r1', {}, 2, True)

    def test_tombstones_persist_and_old_records_cannot_resurrect(self):
        self.put('planning_records', 'r1', record())
        current = {'projectId': 'p1', 'currentRecordId': None, 'deletedRecordIds': ['r1']}
        self.put('planning_current', 'p1', current)
        self.assertEqual(self.db.execute('SELECT deleted FROM biz_planning_records').fetchone()[0], 1)
        with self.assertRaises(DomainError) as result:
            self.put('planning_records', 'r1', record(), 2)
        self.assertEqual(result.exception.code, 'PLANNING_RECORD_DELETED')
        with self.assertRaises(DomainError):
            self.put('planning_current', 'p1', {**current, 'deletedRecordIds': []}, 2)
        self.put('planning_current', 'p1', {}, 2, True)
        self.assertEqual(self.db.execute('SELECT count(*) FROM biz_planning_tombstones').fetchone()[0], 1)

    def test_tombstone_cannot_delete_other_project_record(self):
        self.put('planning_records', 'r1', record())
        with self.assertRaises(DomainError):
            self.put('planning_current', 'p2', {'projectId': 'p2', 'currentRecordId': None, 'deletedRecordIds': ['r1']})
        self.assertEqual(self.db.execute('SELECT deleted FROM biz_planning_records').fetchone()[0], 0)

    def test_normalized_project_foreign_keys_and_composite_current_target(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.put('planning_records', 'r1', record(project='missing-project'))
        self.put('planning_records', 'r1', record())
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.db.execute('INSERT INTO biz_planning_current VALUES(?,?,?,?,?)', ('p2', 'r1', 1, 0, '{}'))
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.db.execute('INSERT INTO biz_planning_tombstones VALUES(?,?,?)', ('missing-project', 'future-record', 1))
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_explicit_record_delete_creates_tombstone(self):
        self.put('planning_records', 'r1', record())
        self.put('planning_records', 'r1', {}, 2, True)
        self.assertEqual(self.db.execute('SELECT project_id,record_id FROM biz_planning_tombstones').fetchone(), ('p1', 'r1'))

    def test_history_record_is_immutable_not_last_write_wins(self):
        self.put('planning_records', 'r1', record())
        with self.assertRaises(DomainError) as result:
            self.put('planning_records', 'r1', {**record(), 'name': 'cannot rewrite history'}, 2)
        self.assertEqual(result.exception.code, 'PLANNING_RECORD_IMMUTABLE')
        self.assertEqual(self.db.execute('SELECT revision FROM biz_planning_records').fetchone()[0], 1)

    def test_alert_ended_priority_and_lifecycle_identity(self):
        self.put('alerts', 'a1', alert())
        self.put('alerts', 'a1', alert(True), 2)
        with self.assertRaises(DomainError) as result:
            self.put('alerts', 'a1', {**alert(), 'lastSeen': 10000}, 3)
        self.assertEqual(result.exception.code, 'ALERT_ALREADY_ENDED')
        self.assertEqual(self.db.execute('SELECT archive_state,ended_at_ms,value FROM biz_alerts').fetchone(), ('ended', 1200, None))
        for bad in ({**alert(True), 'lastSeen': 1050}, {**alert(True), 'firstSeen': 900}, {**alert(True), 'endedAt': 1100}):
            with self.assertRaises(DomainError):
                self.put('alerts', 'a1', bad, 3)

    def test_deleted_ended_alert_cannot_be_revived_as_active(self):
        self.put('alerts', 'a1', alert(True))
        self.put('alerts', 'a1', {}, 2, True)
        with self.assertRaises(DomainError):
            self.put('alerts', 'a1', alert(), 3)

    def test_overrides_are_receiver_plus_channel_and_not_live_state(self):
        value = {'receiverId': 'rx1', 'channelNumber': 1, 'alias': '主持人', 'role': 'MC', '_source': 'operator'}
        self.put('device_overrides', 'o1', value)
        for key in ('rf', 'rf_dbm', 'rflevel', 'afDbfs', 'freq', 'frequencyKHz', 'muted', 'online', 'isOnline', '_online', 'group', 'ip', 'capabilities'):
            with self.subTest(key=key), self.assertRaises(DomainError):
                validate_document('device_overrides', 'o1', {**value, key: 1})
        with self.assertRaises(DomainError):
            self.put('device_overrides', 'o1', {**value, 'receiverId': 'rx2'}, 2)

    def test_preferences_queryable_and_no_connection_retarget(self):
        value = {'specStartFreq': '640.000', 'specEndFreq': '690.000', 'channelPage': 2, '_source': 'explicit-import'}
        self.put('preferences', 'workstation', value)
        self.assertEqual(self.db.execute('SELECT number_value FROM biz_preference_values WHERE preference_key=?', ('channelPage',)).fetchone()[0], 2)
        for key in ('daty_fashe_api_url', 'daty_local_ip', 'unknown'):
            with self.assertRaises(DomainError):
                validate_document('preferences', 'workstation', {key: 'https://example.invalid'})
        with self.assertRaises(DomainError):
            validate_document('preferences', 'workstation', {'specStartFreq': '690', 'specEndFreq': '640'})

    def test_plugin_cannot_claim_installation(self):
        self.put('plugins', 'shure', {'status': '开发中', 'source': 'original-ui', 'installed': False})
        for body in ({'status': 'enabled'}, {'status': 'development', 'installed': True}, {'status': '尚未接入', 'ready': 1}):
            with self.assertRaises(DomainError):
                validate_document('plugins', 'shure', body)
        self.assertEqual(self.db.execute('SELECT installed FROM biz_plugins').fetchone()[0], 0)

    def test_credentials_prototype_fields_and_invalid_json_rejected_in_all_kinds(self):
        for kind in KINDS:
            for forbidden in ('password', 'nestedToken', 'privateKey', 'session', '__proto__'):
                with self.subTest(kind=kind, key=forbidden), self.assertRaises(DomainError):
                    validate_document(kind, 'fixture', {'nested': [{forbidden: 'redacted'}]}, True)
        for bad in (float('nan'), float('inf'), 10 ** 1000, '\ud800', {1: 'bad'}, b'bad'):
            with self.assertRaises(DomainError):
                validate_document('settings', 'alert_sound', {'enabled': True, 'metadata': bad})

    def test_deep_copy_and_stale_revision(self):
        value = {'enabled': False, 'unknown': {'a': 1}}
        validated = validate_document('settings', 'alert_sound', value)
        validated['unknown']['a'] = 2
        self.assertEqual(value['unknown']['a'], 1)
        self.put('settings', 'alert_sound', value)
        with self.assertRaises(DomainError) as result:
            self.put('settings', 'alert_sound', {'enabled': True}, 1)
        self.assertEqual(result.exception.code, 'BUSINESS_REVISION_CONFLICT')

    def test_validation_id_unicode_and_boolean_revision(self):
        with self.assertRaises(DomainError):
            validate_document('settings', '\ud800', {})
        with self.assertRaises(DomainError):
            self.put('settings', 'alert_sound', {'enabled': True}, True)


if __name__ == '__main__':
    unittest.main()
