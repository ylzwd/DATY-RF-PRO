"""Bounded MQTT 5 test adapter. No reconnect/replay or production defaults."""
import asyncio
import ipaddress
import json
import queue
import ssl
import threading
import uuid

import paho.mqtt.client as mqtt


class BrokerClient:
    def __init__(self, *, port, ca, username, password, websocket=False, host='127.0.0.1'):
        if not ipaddress.ip_address(host).is_loopback or port in (1883, 8883, 8083, 8802):
            raise ValueError('Only isolated loopback Broker allowed')
        self.messages, self.receipts, self.subacks = queue.Queue(maxsize=128), {}, {}
        self.ready, self.connection_code = threading.Event(), None
        self.disconnect_reason = None
        self.queue_overflows = 0
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
            client_id='stage1-' + uuid.uuid4().hex, protocol=mqtt.MQTTv5,
            transport='websockets' if websocket else 'tcp', reconnect_on_failure=False)
        self.client.max_queued_messages_set(16)
        self.client.max_inflight_messages_set(8)
        self.client.username_pw_set(username, password)
        self.client.tls_set(ca_certs=str(ca), tls_version=ssl.PROTOCOL_TLS_CLIENT)
        self.client.on_connect = self._connect
        self.client.on_message = self._message
        self.client.on_disconnect = self._disconnect
        self.client.on_publish = lambda c, u, mid, rc, props: self.receipts.__setitem__(mid, rc.value)
        self.client.on_subscribe = lambda c, u, mid, rc, props: self.subacks.__setitem__(mid, [x.value for x in rc])
        if websocket:
            self.client.ws_set_options(path='/mqtt')
        properties = mqtt.Properties(mqtt.PacketTypes.CONNECT)
        properties.SessionExpiryInterval = 0
        properties.MaximumPacketSize = 1024 * 1024
        self.client.connect(host, port, keepalive=15, clean_start=True, properties=properties)
        self.client.loop_start()
        if not self.ready.wait(5) or self.connection_code != 0:
            self.close()
            raise ConnectionError('Prototype Broker authentication failed')

    def _connect(self, client, user, flags, reason, props):
        self.connection_code = reason.value
        self.ready.set()

    def _message(self, client, user, message):
        try:
            self.messages.put_nowait((message.topic, bytes(message.payload)))
        except queue.Full:
            self.queue_overflows += 1
            self.disconnect_reason = 'RECEIVE_QUEUE_FULL'
            client.disconnect()

    def _disconnect(self, client, user, flags, reason, props):
        if self.disconnect_reason is None:
            self.disconnect_reason = 'MQTT_DISCONNECT_' + str(reason.value)

    def subscribe(self, topic):
        import time
        code, mid = self.client.subscribe(topic, qos=1)
        if code != mqtt.MQTT_ERR_SUCCESS:
            raise ConnectionError('Subscription unavailable')
        end = time.monotonic() + 5
        while mid not in self.subacks and time.monotonic() < end:
            time.sleep(.005)
        return self.subacks.pop(mid)

    def publish_sync(self, topic, body, *, retain=False):
        if not self.client.is_connected():
            raise ConnectionError('Broker disconnected; no queuing or replay')
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        if len(payload) > 900 * 1024:
            raise ValueError('Bounded prototype publication exceeded')
        props = mqtt.Properties(mqtt.PacketTypes.PUBLISH)
        props.MessageExpiryInterval = 5
        info = self.client.publish(topic, payload, qos=1, retain=retain, properties=props)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise ConnectionError('Broker publication rejected locally')
        info.wait_for_publish(timeout=5)
        if not info.is_published():
            raise TimeoutError('Broker receipt unknown; no replay')
        return self.receipts.pop(info.mid)

    async def publish(self, topic, body):
        reason = await asyncio.to_thread(self.publish_sync, topic, body)
        if reason >= 128:
            raise PermissionError('Broker denied publication')

    def receive(self, timeout=5):
        return self.messages.get(timeout=timeout)

    def close(self):
        self.client.disconnect()
        self.client.loop_stop()
