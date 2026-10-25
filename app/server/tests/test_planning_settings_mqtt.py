"""Product selections over isolated real MQTT/TLS/SQLite, never real equipment."""
import copy
import json
import sqlite3
import unittest
import uuid
from contextlib import closing
from pathlib import Path

from test_planning_settings import document
import test_stage6
import unified_database as db


class PlanningSettingsMQTT(unittest.IsolatedAsyncioTestCase):
    # Reuse transport/lifecycle fixtures without rerunning unrelated inherited
    # device control tests when this focused suite is discovered.
    asyncSetUp=test_stage6.Integration.asyncSetUp
    asyncTearDown=test_stage6.Integration.asyncTearDown
    close_peers=test_stage6.Integration.close_peers
    new_ui=test_stage6.Integration.new_ui
    rpc=test_stage6.Integration.rpc

    def body(self,value,revision):
        return dict(operation_id=uuid.uuid4().hex,epoch=self.epoch,kind='settings',
                    id='frequency_planning',expected_revision=revision,value=value)

    async def test_legacy_upgrade_new_selections_reconnect_and_reopen(self):
        legacy=document();body=self.body(legacy,0)
        reply=await self.rpc('database.write',body)
        self.assertEqual(reply['status'],200)
        original=reply['body']['resource']
        self.assertEqual(original['value'],legacy)
        detail=await self.rpc('database.resources.get',dict(kind='settings',id='frequency_planning'))
        self.assertEqual(detail['body']['resource'],original)
        for revision,selection in enumerate(('2T3O,2T5O,2T7O,2T9O,3T3O','','2T7O,3T3O'),1):
            value=copy.deepcopy(legacy);value['fields']['plannerImdProducts']=selection
            body=self.body(value,revision)
            reply=await self.rpc('database.write',body)
            self.assertEqual(reply['status'],200)
            resource=reply['body']['resource']
            self.assertEqual(resource['revision'],revision+1)
            self.assertEqual(resource['value'],value)
            # The same committed operation does not create another revision.
            replay=await self.rpc('database.write',body)
            self.assertEqual(replay['body']['resource'],resource)
            await self.ui.close();self.ui=await self.new_ui()
            detail=await self.rpc('database.resources.get',dict(kind='settings',id='frequency_planning'))
            self.assertEqual(detail['body']['resource'],resource)
        bad=copy.deepcopy(value);bad['fields']['plannerImdProducts']='2T3O,2T3O'
        rejected=await self.rpc('database.write',self.body(bad,resource['revision']))
        self.assertEqual(rejected['status'],400)
        conflict=await self.rpc('database.write',self.body(legacy,1))
        self.assertEqual(conflict['status'],409)
        # Query normalized SQLite and reopen a consistent backup independently
        # of the transport cache; no production database is opened.
        backup=Path(self.temp.name)/'planning-reopened.sqlite3'
        with self.runtime.repo.connection() as connection:
            row=connection.execute("SELECT setting_type,metadata_json FROM biz_settings WHERE id='frequency_planning'").fetchone()
            self.assertEqual(row[0],'frequency_planning')
            self.assertEqual(json.loads(row[1]),value)
            with closing(sqlite3.connect(backup)) as target:connection.backup(target)
        with closing(sqlite3.connect(backup)) as reopened:
            self.assertEqual(db.get_resource(reopened,'settings','frequency_planning'),resource)
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
