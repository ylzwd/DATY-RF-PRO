"""Generate/check native reference from the current server's actual wire contract."""
from pathlib import Path
import json,sys,hashlib,argparse
root=Path(__file__).resolve().parents[1];server=root/'app/server'
sys.path[:0]=[str(server),*[str(server/f'prototypes/mqtt-stage{n}') for n in range(1,7)]]
from m6_contract import APP_METHODS,COMMAND_METHODS,SERVER,schema,topic
from m5_contract import MAX_BYTES
sources=['prototypes/mqtt-stage6/m6_contract.py','prototypes/mqtt-stage4/data_contract.py','prototypes/mqtt-stage5/m5_contract.py']
value={'format':'daty-r19-native-reference-v1','server_id':SERVER,'schema':schema('app'),'transport':{'mqttVersion':5,'websocketSubprotocol':'mqtt','appPath':'/mqtt-app','livePath':'/mqtt-readonly','tlsRequired':True,'webPort':8080,'mqttPort':8083},'topics':{'request':topic('app','request'),'reply':topic('app','reply')},'requestFields':['schema','server_id','boot_id','client_session_id','request_id','method','deadline_at_ms','body'],'methods':sorted(APP_METHODS),'commandMethods':sorted(COMMAND_METHODS),'maxMessageBytes':MAX_BYTES,'maxRequestLifetimeMs':30000,'sourceSha256':{n:hashlib.sha256((server/n).read_bytes()).hexdigest() for n in sources},'notes':['The hello assigns boot_id and client_session_id; never reuse them across reconnect.','A transport reply is not a device execution ACK or database commit receipt.','Reuse operation_id only for explicit receipt reconciliation; do not replay unknown writes.','This reference is not an implementation or a shipped native MQTT client.']}
target=root/'contracts/r19-mqtt-app.json'
ap=argparse.ArgumentParser();ap.add_argument('--check',action='store_true');args=ap.parse_args()
if args.check:
    assert json.loads(target.read_text('utf-8'))==value,'Server contract changed; review before regenerating native reference'
else:target.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'contract':str(target),'methods':len(APP_METHODS),'checked':args.check}))
