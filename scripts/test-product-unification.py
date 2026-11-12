"""Isolated product/build, ZIP and transactional upgrade regression tests."""
import copy
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'app/server')]
import product_info as info
import product_build as build
import product_distribution as dist
import project_release as release


def write(root,name,value):
    path=root/name;path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')


def installation(root,version='1.1.0'):
    root.mkdir(parents=True)
    product={'schema':'daty-product-v1','product':'DATY RF PRO','version':version}
    write(root,'config/product.json',product)
    output='native/publish/'+version
    write(root,'config/project-development.json',{'native_output':output})
    names={'config/product.json','config/project-development.json'}
    for name in ('DATY.RF.Native.exe','DATY.RF.Native.dll','hostfxr.dll','coreclr.dll','PresentationFramework.dll'):
        path=root/output/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((name+version).encode());names.add(output+'/'+name)
    (root/release.ENTRY).write_bytes(('entry'+version).encode());names.add(release.ENTRY)
    record={'schema':'daty-product-build-v1','product':'DATY RF PRO','version':version,
            'buildId':hashlib.sha256(version.encode()).hexdigest(),'contractSchema':'daty-mqtt6-app-v1','databaseSchema':3,
            'sourceCommit':'fixture','sourceClean':True,'runtimeFiles':{n:info.digest(root/n) for n in names}}
    write(root,info.BUILD_RECORD,record);names.add(info.BUILD_RECORD)
    release.record(root,'fixture',True);names.add(release.RECORD)
    manifest={'schema':'daty-runtime-distribution-v1','product':info.identity(root),'sourceCommit':'fixture','sourceClean':True,
              'databaseSchemaMin':3,'databaseSchemaMax':3,
              'files':{n:{'bytes':(root/n).stat().st_size,'sha256':info.digest(root/n)} for n in names}}
    write(root,dist.MANIFEST,manifest)
    return manifest


class ProductTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-product-');self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.root=self.base/'installed';self.new=self.base/'incoming'
        self.old=installation(self.root);self.latest=installation(self.new,'1.1.1')

    def private_data(self):
        for name in ('data/security/server-key.pem','data/security/receiver-pairings.json','data/plugins/installed.json',
                     'data/scan-backups/session.datyscan','config/project-instance.local.json','config/native.local.json',
                     '.local-instances/other/data/scan-backups/scan.datyscan'):
            path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(('PRIVATE '+name).encode())
        path=self.root/'data/db/daty-rf.sqlite3';path.parent.mkdir(parents=True,exist_ok=True)
        with contextlib.closing(sqlite3.connect(path)) as db, db:
            db.execute('pragma user_version=3');db.execute('create table saved(value text)');db.execute("insert into saved values('keep settings')")
        return {p.relative_to(self.root).as_posix():p.read_bytes() for p in self.root.rglob('*') if p.is_file() and (p.relative_to(self.root).as_posix().startswith(('data/','.local-instances/')) or p.name in ('project-instance.local.json','native.local.json'))}

    def assert_private(self,before):
        self.assertEqual(before,{p.relative_to(self.root).as_posix():p.read_bytes() for p in self.root.rglob('*') if p.is_file() and (p.relative_to(self.root).as_posix().startswith(('data/','.local-instances/')) or p.name in ('project-instance.local.json','native.local.json'))})

    def test_wal_database_check_upgrade_and_rollback_never_modify_private_files(self):
        self.private_data();path=self.root/'data/db/daty-rf.sqlite3'
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.execute('pragma journal_mode=wal')
        # Some read-only clients retain empty WAL/shared-memory files on close.
        path.with_name(path.name+'-wal').write_bytes(b'')
        path.with_name(path.name+'-shm').write_bytes(b'retained shared memory')
        before={p.relative_to(self.root).as_posix():p.read_bytes() for p in self.root.rglob('*') if p.is_file() and (p.relative_to(self.root).as_posix().startswith(('data/','.local-instances/')) or p.name in ('project-instance.local.json','native.local.json'))}
        self.assertEqual(dist.database_schemas(self.root),[3]);self.assert_private(before)
        dist.apply_program(self.root,self.new);self.assert_private(before)
        dist.recover(self.root);self.assert_private(before)

    def test_pending_wal_schema_is_not_silently_ignored(self):
        self.private_data();path=self.root/'data/db/daty-rf.sqlite3'
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.execute('pragma journal_mode=wal');db.execute('pragma user_version=99')
            before={p:p.read_bytes() for p in path.parent.iterdir() if p.is_file()}
            with self.assertRaisesRegex(ValueError,'日志'):dist.apply_program(self.root,self.new)
            self.assertEqual(before,{p:p.read_bytes() for p in path.parent.iterdir() if p.is_file()})
            self.assertFalse((self.root/dist.JOURNAL).exists())

    def test_pending_rollback_journal_is_preserved_and_refused(self):
        self.private_data();path=self.root/'data/db/daty-rf.sqlite3-journal';path.write_bytes(b'pending recovery')
        with self.assertRaisesRegex(ValueError,'日志'):dist.apply_program(self.root,self.new)
        self.assertEqual(path.read_bytes(),b'pending recovery');self.assertFalse((self.root/dist.JOURNAL).exists())

    def test_product_version_rejects_ambiguous_numbers(self):
        for version in ('01.1.0','1.1','1.1.0.4','1.1.0-rc.1','1.65535.0'):
            write(self.root,'config/product.json',{'schema':'daty-product-v1','product':'DATY RF PRO','version':version})
            with self.assertRaises(ValueError):info.read_product(self.root)

    def test_windows_transient_reader_lock_retries(self):
        path=self.base/'receipt.json';original=dist.os.replace;attempts=[]
        def replace(source,target):
            attempts.append(1)
            if len(attempts)<3:raise PermissionError('temporary reader')
            original(source,target)
        with patch.object(dist.os,'replace',replace),patch.object(dist.time,'sleep'):
            dist.atomic_json(path,{'ok':True})
        self.assertEqual(json.loads(path.read_bytes()),{'ok':True});self.assertEqual(len(attempts),3)

    def test_persistent_journal_lock_keeps_original_and_cleans_temp(self):
        path=self.base/'receipt.json';dist.atomic_json(path,{'original':True})
        with patch.object(dist.os,'replace',side_effect=PermissionError('locked')),patch.object(dist.time,'sleep'),self.assertRaises(PermissionError):
            dist.atomic_json(path,{'new':True})
        self.assertEqual(json.loads(path.read_bytes()),{'original':True});self.assertFalse(list(self.base.glob('receipt.json.tmp-*')))

    def test_identical_program_files_are_not_replaced(self):
        same=self.base/'identical';installation(same)
        dist.apply_program(self.root,same)
        self.assertEqual(json.loads((self.root/dist.JOURNAL).read_bytes())['entries'],[])

    def test_export_refuses_clean_but_stale_commit(self):
        with patch('subprocess.check_output',return_value=b'another-commit'),self.assertRaisesRegex(ValueError,'current commit'):
            dist.export_runtime(self.root)

    def test_export_refuses_source_changes_during_packaging(self):
        write(self.root,'config/dependency-inventory.json',{'files':{}})
        with patch('subprocess.check_output',side_effect=[b'fixture',b'',b'fixture',b' M README.md']),self.assertRaisesRegex(ValueError,'during export'):
            dist.export_runtime(self.root)
        self.assertFalse(list((self.root/'delivery').glob('*.zip')))
        self.assertEqual(len(list((self.root/'delivery').glob('*.partial'))),1)

    def test_other_instance_incompatible_database_also_blocks_upgrade(self):
        self.private_data();path=self.root/'.local-instances/other/data/db/daty-rf.sqlite3';path.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(path)) as db:db.execute('pragma user_version=99')
        with self.assertRaisesRegex(ValueError,'数据库结构'):dist.apply_program(self.root,self.new)
        self.assertFalse((self.root/dist.JOURNAL).exists())

    def test_same_version_other_build_rejected(self):
        expected=info.identity(self.root);actual={**expected,'buildId':'e'*64}
        with self.assertRaisesRegex(ValueError,'构建批次'):info.require_identity(actual,expected)

    def test_missing_backend_identity_rejected(self):
        with self.assertRaises(ValueError):info.require_identity(None,info.identity(self.root))

    def test_each_compatibility_field_is_checked(self):
        expected=info.identity(self.root)
        for key in expected:
            with self.subTest(key=key),self.assertRaises(ValueError):info.require_identity({**expected,key:'wrong'},expected)

    def test_tampered_runtime_file_rejected(self):
        (self.root/'config/project-development.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'程序文件'):info.installed_build(self.root,verify_files=True)

    def test_missing_native_runtime_rejected(self):
        (self.root/'native/publish/1.1.0/coreclr.dll').unlink()
        with self.assertRaises(ValueError):dist.verify_directory(self.root)

    def test_single_version_generates_backend_path_readme(self):
        root=self.base/'source';root.mkdir()
        write(root,'config/product.json',{'schema':'daty-product-v1','product':'DATY RF PRO','version':'2.3.4'})
        write(root,'config/project-development.json',{'native_output':'old'})
        write(root,'app/server/version.json',{'version':'old','bridgeVersion':'2.0'})
        (root/'app/server/product_info.py').write_bytes(b'# fixture')
        (root/'README.md').write_text('<!-- product-version:start -->old<!-- product-version:end -->',encoding='utf-8')
        path=root/'app/public/a.js';path.parent.mkdir(parents=True);path.write_bytes(b'known reviewed asset')
        write(root,'app/public/candidate-manifest.json',{'files':{'a.js':'stale'}})
        write(root,'app/package-manifest.json',{'files':{'public/a.js':'stale','public/candidate-manifest.json':'stale'}})
        write(root,'project-layout.json',{})
        build.synchronize(root)
        self.assertEqual(json.loads((root/'app/server/version.json').read_bytes())['version'],'2.3.4')
        self.assertEqual(json.loads((root/'config/project-development.json').read_bytes())['native_output'],'native/publish/2.3.4')
        self.assertIn('V2.3.4',(root/'README.md').read_text('utf-8'))
        candidate=json.loads((root/'app/public/candidate-manifest.json').read_bytes())
        self.assertEqual(candidate['files']['a.js'],info.digest(path))
        package=json.loads((root/'app/package-manifest.json').read_bytes())
        self.assertEqual(package['files']['public/candidate-manifest.json'],info.digest(root/'app/public/candidate-manifest.json'))
        self.assertEqual(json.loads((root/'project-layout.json').read_bytes())['packageManifestSha256'],info.digest(root/'app/package-manifest.json'))

    def zip_package(self,extra=None):
        path=self.base/(str(len(list(self.base.glob('*.zip'))))+'.zip')
        with zipfile.ZipFile(path,'x') as archive:
            for name in self.latest['files']:
                archive.write(self.new/name,dist.PREFIX+name)
            archive.write(self.new/dist.MANIFEST,dist.PREFIX+dist.MANIFEST)
            if extra:archive.writestr(extra[0],extra[1])
        return path

    def test_verified_archive_extraction(self):
        path=self.zip_package();target=self.base/'extract'
        dist.extract_verified(path,target,info.digest(path));dist.verify_directory(target)

    def test_zip_digest_rejected_before_extract(self):
        target=self.base/'extract'
        with self.assertRaisesRegex(ValueError,'SHA256'):dist.extract_verified(self.zip_package(),target,'0'*64)
        self.assertFalse(target.exists())

    def test_archive_traversal_and_private_paths_rejected(self):
        for name in ('../escaped','data/security/key.pem','config/native.local.json','native/publish/../data/key','app/server/C:evil','app/server/NUL.py','app/server/foo. '):
            with self.subTest(name=name),self.assertRaises(ValueError):dist.verify_archive(self.zip_package((dist.PREFIX+name,b'bad')))

    def test_windows_case_collision_rejected(self):
        with self.assertRaises(ValueError):dist.verify_archive(self.zip_package((dist.PREFIX+'daty rf pro.exe',b'bad')))

    def test_upgrade_preserves_all_private_bytes(self):
        before=self.private_data();result=dist.apply_program(self.root,self.new)
        self.assertTrue(result['ok']);self.assert_private(before)
        self.assertEqual(info.identity(self.root)['version'],'1.1.1')
        self.assertFalse((self.root/'native/publish/1.1.0/DATY.RF.Native.dll').exists())
        self.assertEqual(dist.verify_directory(self.root)['product'],self.latest['product'])

    def test_rollback_preserves_all_private_bytes(self):
        before=self.private_data();dist.apply_program(self.root,self.new);dist.recover(self.root)
        self.assert_private(before);self.assertEqual(dist.verify_directory(self.root)['product'],self.old['product'])

    def test_write_failure_restores_old_program(self):
        before=self.private_data()
        def fault(index):
            if index==4:raise OSError('simulated disk failure')
        with self.assertRaisesRegex(OSError,'disk failure'):dist.apply_program(self.root,self.new,fault=fault)
        self.assert_private(before);dist.verify_directory(self.root)
        self.assertEqual(json.loads((self.root/dist.JOURNAL).read_bytes())['state'],'rolled-back')

    def test_partial_file_copy_is_removed_on_recovery(self):
        before=self.private_data();original=dist.durable_copy
        def copy(source,target):
            if Path(source).is_relative_to(self.new):
                Path(target).write_bytes(b'partial program data');raise OSError('partial copy failed')
            original(source,target)
        with patch.object(dist,'durable_copy',copy),self.assertRaisesRegex(OSError,'partial copy'):
            dist.apply_program(self.root,self.new)
        self.assert_private(before);dist.verify_directory(self.root)
        self.assertFalse(list(self.root.rglob('*.tmp-*')))

    def test_interrupted_update_can_be_recovered(self):
        before=self.private_data()
        def fault(index):
            if index==4:raise KeyboardInterrupt('simulated power loss')
        with self.assertRaises(KeyboardInterrupt):dist.apply_program(self.root,self.new,fault=fault)
        self.assertEqual(json.loads((self.root/dist.JOURNAL).read_bytes())['state'],'applying')
        dist.recover(self.root);self.assert_private(before);dist.verify_directory(self.root)

    def test_corrupted_backup_blocks_recovery_before_any_restore(self):
        def fault(index):
            if index==4:raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):dist.apply_program(self.root,self.new,fault=fault)
        journal=json.loads((self.root/dist.JOURNAL).read_bytes());entry=next(e for e in journal['entries'] if e['existed'])
        (Path(journal['backup'])/entry['name']).write_bytes(b'broken')
        before={p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with self.assertRaises(ValueError):dist.recover(self.root)
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_incompatible_database_refuses_upgrade(self):
        self.private_data()
        with contextlib.closing(sqlite3.connect(self.root/'data/db/daty-rf.sqlite3')) as db:db.execute('pragma user_version=99')
        with self.assertRaisesRegex(ValueError,'数据库结构'):dist.apply_program(self.root,self.new)
        self.assertFalse((self.root/dist.JOURNAL).exists());dist.verify_directory(self.root)

    def test_future_database_refuses_program_rollback(self):
        self.private_data();dist.apply_program(self.root,self.new)
        with contextlib.closing(sqlite3.connect(self.root/'data/db/daty-rf.sqlite3')) as db:db.execute('pragma user_version=4')
        with self.assertRaisesRegex(ValueError,'数据库结构'):dist.recover(self.root)
        self.assertEqual(info.identity(self.root)['version'],'1.1.1')

    def test_development_checkout_not_overwritten(self):
        (self.root/'.git').mkdir()
        with self.assertRaisesRegex(ValueError,'开发仓库'):dist.apply_program(self.root,self.new)

    def test_export_excludes_git_sdk_and_private_state(self):
        self.private_data();(self.root/'.git').mkdir();(self.root/'.git/secret-history').write_bytes(b'private')
        write(self.root,'config/dependency-inventory.json',{'files':{}})
        receipt=dist.export_runtime(self.root,require_clean=False)
        self.assertFalse(receipt['includesGit']);self.assertFalse(receipt['includesSDK'])
        manifest=dist.verify_archive(self.root/'delivery'/receipt['file'],receipt['sha256'])
        self.assertFalse(any(n.startswith(('data/','.git/','tools/','.local-instances/')) for n in manifest['files']))

    def test_pending_update_blocks_normal_launch(self):
        spec=importlib.util.spec_from_file_location('isolated_product_local',ROOT/'scripts/project-local.py')
        local=importlib.util.module_from_spec(spec);spec.loader.exec_module(local)
        write(self.root,dist.JOURNAL,{'state':'applying'})
        with patch.object(local,'ROOT',self.root),self.assertRaisesRegex(ValueError,'升级尚未完成'):
            local.profile()

    def test_old_backend_rejected_before_prepare_or_start(self):
        spec=importlib.util.spec_from_file_location('isolated_product_local',ROOT/'scripts/project-local.py')
        local=importlib.util.module_from_spec(spec);spec.loader.exec_module(local)
        with patch.object(local,'ROOT',self.root),patch.object(local,'state',return_value={'state':'running'}),patch.object(local,'prepare') as prepare:
            with self.assertRaisesRegex(ValueError,'构建批次'):local.start()
            prepare.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
