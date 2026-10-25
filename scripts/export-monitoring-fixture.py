"""Export a server seed for explicit offline tests, never client configuration."""
from pathlib import Path
import json,sys
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'app/server'))
from monitoring_rules import SEED,validate
def fail(message):raise ValueError(message)
validate(SEED,fail)
out=Path(sys.argv[1]);out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(SEED,ensure_ascii=False,indent=2),'utf-8')
