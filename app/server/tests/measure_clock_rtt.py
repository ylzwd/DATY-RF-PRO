"""只读采样现有 ACK，不额外发送心跳/设备指令；同一序号只统计一次。"""
import argparse
import json
import math
import statistics
import time
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8802')
    parser.add_argument('--receiver-ip', default='192.0.2.102')
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--timeout', type=float, default=125)
    parser.add_argument('--client-version', help='Only measure this deployed client version (no RTT filtering).')
    args = parser.parse_args()
    samples, seen = [], set()
    deadline = time.monotonic() + args.timeout
    while len(samples) < args.samples and time.monotonic() < deadline:
        try:
            with urlopen(args.url.rstrip('/') + '/api/clock', timeout=3) as response:
                data = json.load(response)
            for client in data.get('clock', {}).get('clients', []):
                key = (client.get('server_id'), client.get('client_id'), client.get('sequence'))
                rtt = client.get('rtt_ms')
                if client.get('receiver_ip') != args.receiver_ip or client.get('status') != 'synced' or key in seen:
                    continue
                if args.client_version and client.get('client_version') != args.client_version:
                    continue
                if isinstance(rtt, bool) or not isinstance(rtt, (int, float)) or not math.isfinite(rtt) or rtt < 0:
                    continue
                seen.add(key)
                samples.append({'sequence':client['sequence'], 'rtt_ms':rtt,
                                'client_version':client.get('client_version'), 'server_id':client.get('server_id'),
                                'client_id':client.get('client_id'),
                                'client_ack_prepare_ms':client.get('client_ack_prepare_ms')})
        except (OSError, ValueError):
            pass
        time.sleep(.5)
    values = sorted(item['rtt_ms'] for item in samples)
    result = {'receiver_ip':args.receiver_ip, 'count':len(values), 'requested':args.samples,
              'required_client_version':args.client_version, 'samples':samples}
    if values:
        result.update(min_ms=min(values), median_ms=statistics.median(values),
                      p95_ms=values[math.ceil(.95 * len(values)) - 1], max_ms=max(values),
                      below_10ms_percent=round(100 * sum(value < 10 for value in values) / len(values), 1))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if len(values) >= args.samples else 1


if __name__ == '__main__':
    raise SystemExit(main())
