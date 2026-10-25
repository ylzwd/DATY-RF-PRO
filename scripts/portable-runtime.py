"""Relocatable migration bootstrap. Does not create/replace business identities."""
from pathlib import Path
import argparse, hashlib, importlib.util, ipaddress, json, os, socket, ssl, sys
import time, urllib.request
from datetime import datetime, timedelta, timezone

ROOT=Path(__file__).resolve().parents[1]
SERVER=ROOT/'app/server'
sys.path[:0]=[str(ROOT/'app/tools/pylib'),str(SERVER),*[str(SERVER/f'prototypes/mqtt-stage{n}') for n in range(1,7)]]

def read(path):return json.loads(path.read_text('utf-8-sig'))
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+'.portable-'+str(os.getpid())+'.tmp')
    with temporary.open('x',encoding='utf-8') as f:
        json.dump(value,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    os.replace(temporary,path)
def confined(root,name):
    path=(root/name).resolve()
    if not path.is_relative_to(root.resolve()):raise ValueError('Package path escapes root')
    for p in (root/name,*(root/name).parents):
        if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):raise ValueError('Linked installation path is not supported')
    return path
def metadata(root):
    m=read(root/'migration/migration.json')
    if m.get('schema')!='daty-portable-migration-v1':raise ValueError('Not a DATY migration package')
    if len(m['id'])!=32 or any(c not in '0123456789abcdef' for c in m['id']):raise ValueError('Invalid migration ID')
    return m
def verify_program(root,m):
    manifest=root/'app/package-manifest.json'
    if digest(manifest)!=m['packageManifestSha256']:raise ValueError('Package manifest changed')
    for name,h in read(manifest)['files'].items():
        if digest(confined(root/'app',name))!=h:raise ValueError('Program file failed verification: '+name)
    for name,h in m['bootstrapHashes'].items():
        if digest(confined(root,name))!=h:raise ValueError('Launcher file failed verification: '+name)
def verify_seed(root,m):
    for name,h in m['securityHashes'].items():
        if digest(confined(root/'migration/security',name))!=h:raise ValueError('Migration identity failed verification')
def storage_path(m):
    return Path(os.environ['ProgramData'])/'DATY-RF-PRO-Portable'/m['id']
def task_name(m):return 'DATY_RF_PRO_Portable_'+m['id'][:12]
def setup_env(settings):
    os.environ['DATY_TLS_FILE']=settings['tls'];os.environ['DATY_PAIRING_FILE']=settings['pairing']
def state_for(root):
    path=root/'runtime/runtime-status.json'
    if not path.exists():return None
    try:return read(path)
    except (ValueError,OSError):return None
def ports_free():
    held=[]
    try:
        for port in (8080,8083):
            s=socket.socket();held.append(s)
            if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):s.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            s.bind(('0.0.0.0',port))
    except OSError:raise ValueError('8080/8083 is occupied. Stop the existing server first; no process was terminated.') from None
    finally:
        for s in held:s.close()
def check_source_stopped(root,m,hosts):
    if m['sourceHost'] in hosts:return
    ctx=ssl.create_default_context(cafile=str(root/'migration/security/root-ca.pem'))
    try:
        with urllib.request.urlopen('https://'+m['sourceHost']+':8080/health',context=ctx,timeout=2) as response:
            active=response.read(8192)
        if json.loads(active).get('service')=='DATY RF PRO MQTT static':
            raise ValueError('The original DATY server is still online. Stop it before starting the migrated server.')
    except (OSError,json.JSONDecodeError):pass
def migrate_tls(seed,target,hosts):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes,serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID,NameOID
    from tls_support import validate_material
    ca_pem=(seed/'root-ca.pem').read_bytes();ca=x509.load_pem_x509_certificate(ca_pem)
    ca_key=serialization.load_pem_private_key((seed/'root-ca-key.pem').read_bytes(),password=None)
    fmt=(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    if ca.public_key().public_bytes(*fmt)!=ca_key.public_key().public_bytes(*fmt):raise ValueError('Migration CA key does not match')
    now=datetime.now(timezone.utc)
    if ca.not_valid_after_utc<now+timedelta(days=30):raise ValueError('Migration CA expires soon; renew it deliberately')
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    names=[]
    for host in sorted(set(hosts)|{'localhost','127.0.0.1'}):
        try:names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            if host!='localhost':raise ValueError('Only explicit local IPs are accepted')
            names.append(x509.DNSName(host))
    leaf=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'DATY RF PRO Migrated Server')]))
        .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now-timedelta(minutes=5)).not_valid_after(min(now+timedelta(days=365),ca.not_valid_after_utc))
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
        .add_extension(x509.SubjectAlternativeName(names),critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
        .add_extension(x509.KeyUsage(digital_signature=True,content_commitment=False,key_encipherment=True,
            data_encipherment=False,key_agreement=False,key_cert_sign=False,crl_sign=False,encipher_only=False,decipher_only=False),critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),critical=False).sign(ca_key,hashes.SHA256()))
    cert=leaf.public_bytes(serialization.Encoding.PEM)
    private=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
    meta=validate_material(cert,private,ca_pem)
    from security_storage import exclusive_write
    for name,data in {'server-cert.pem':cert,'server-key.pem':private,'root-ca.pem':ca_pem}.items():exclusive_write(target/name,data)
    write(target/'tls-config.json',{'version':1,'certificate_file':str(target/'server-cert.pem'),
        'private_key_file':str(target/'server-key.pem'),'ca_file':str(target/'root-ca.pem')})
    return meta
def prepare_resources(root,storage,hosts,primary):
    """Only operates on the explicit migrated copy, after preflight/OS consent."""
    from security_storage import secure_directory
    from tls_support import load_config
    from receiver_pairing import ReceiverPairingPolicy
    from m6_scope import validate_database
    m=metadata(root);verify_program(root,m);verify_seed(root,m)
    hosts=[str(ipaddress.IPv4Address(v)) for v in hosts]
    if primary not in hosts or primary=='0.0.0.0':raise ValueError('Selected IP is not a local address')
    config_path=root/'config/runtime-config.json';marker=root/'config/portable-install.json'
    security=storage/'security';secure_directory(security)
    installed=read(marker) if marker.exists() else None
    if installed and installed['migrationId']!=m['id']:raise ValueError('Installation identity mismatch')
    if not installed:
        if any(security.iterdir()):raise ValueError('Partial or existing security installation; inspect it without overwriting')
        if digest(root/'data/db/daty-rf.sqlite3')!=m['databaseSha256']:raise ValueError('First-start database snapshot verification failed')
        seed=root/'migration/security'
        for name in m['securityHashes']:
            if name in ('tls-config.json','server-cert.pem','server-key.pem','root-ca.pem','root-ca-key.pem'):continue
            (security/name).write_bytes((seed/name).read_bytes())
        meta=migrate_tls(seed,security,hosts)
        if meta['ca_sha256']!=m['caSha256']:raise ValueError('CA identity changed')
    else:
        if Path(installed['security']).resolve()!=security.resolve():raise ValueError('Installed security path changed')
        _,meta=load_config(security/'tls-config.json')
        if primary not in meta['hosts']:raise ValueError('Local IP changed since installation. Use the previous IP or arrange a certificate update; identity was not overwritten.')
    pairing=security/'receiver-pairings.json'
    policy=ReceiverPairingPolicy(pairing)
    registry=policy._load()
    if registry is None:raise ValueError('Pairing registry failed validation')
    if not installed and registry.get('development_enrollment'):
        registry['development_enrollment']['broker_url']='wss://'+primary+':8083/mqtt'
        write(pairing,registry)
    for name in ('data/archives','data/staging','runtime'):(root/name).mkdir(parents=True,exist_ok=True)
    settings={'schema':'daty-mqtt6-runtime-v1','database':str(root/'data/db/daty-rf.sqlite3'),
        'database_epoch':m['databaseEpoch'],'archives':str(root/'data/archives'),'staging':str(root/'data/staging'),
        'runtime_directory':str(root/'runtime'),'pairing':str(pairing),'tls':str(security/'tls-config.json'),
        'ca_sha256':m['caSha256'],'bind_host':'0.0.0.0','mqtt_port':8083,'web_port':8080,'public_directory':str(root/'app/public')}
    validate_database(Path(settings['database']),m['databaseEpoch'])
    write(config_path,settings)
    layout=read(root/'project-layout.json');layout.update(task=task_name(m),security=str(security),
        webUrl='https://'+primary+':8080/unirf-app.html?v='+m['webVersion'])
    write(root/'project-layout.json',layout)
    write(marker,{'migrationId':m['id'],'security':str(security),'host':primary,'root':str(root)})
    return {'root':str(root),'task':task_name(m),'host':primary,'ca':str(security/'root-ca.pem'),
        'caSha256':m['caSha256'][0],'url':layout['webUrl'],'config':str(config_path)}
def health(root):
    from tls_support import client_context
    config=read(root/'config/runtime-config.json');state=state_for(root)
    if not state or state['state']!='running' or state['database_epoch']!=config['database_epoch']:return False
    try:
        with urllib.request.urlopen('https://127.0.0.1:8080/health',context=client_context(config['tls']),timeout=2) as response:
            return json.loads(response.read(8192))['service']=='DATY RF PRO MQTT static'
    except (OSError,ValueError):return False
def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=('info','preflight','prepare','health','wait','stop'))
    parser.add_argument('--hosts',default='127.0.0.1');parser.add_argument('--primary',default='127.0.0.1')
    args=parser.parse_args();root=ROOT.resolve();m=metadata(root)
    if args.action=='info':result={'id':m['id'],'sourceHost':m['sourceHost'],'task':task_name(m),'caSha256':m['caSha256'][0]}
    elif args.action=='preflight':
        verify_program(root,m);verify_seed(root,m);ports_free();check_source_stopped(root,m,args.hosts.split(','));result={'passed':True}
    elif args.action=='prepare':result=prepare_resources(root,storage_path(m),args.hosts.split(','),args.primary)
    elif args.action in ('health','wait'):
        deadline=time.monotonic()+(60 if args.action=='wait' else 0)
        while not health(root):
            if time.monotonic()>=deadline:raise ValueError('Server health has not been confirmed; inspect runtime logs')
            time.sleep(.5)
        result={'healthy':True}
    else:
        state=state_for(root)
        if not state or state['state']!='running':raise ValueError('No running instance confirmed')
        if not health(root):raise ValueError('Refusing to send a stop request without TLS health confirmation')
        write(root/'runtime/stop.request.json',{'boot_id':state['boot_id']});result={'requested':True}
    print(json.dumps(result,ensure_ascii=True))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Migration launcher: '+str(error),file=sys.stderr);sys.exit(1)
