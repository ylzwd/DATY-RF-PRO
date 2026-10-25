"""Server-boot FIFO GROUPs; credentials and historical identities stay durable.

The first successful signed enrollment (after its credential commit), or MQTT
CONNECT with an existing credential, completes registration and allocates a
number. Challenge requests alone never allocate. Reconnect/renewal reuses it.
Verified server adapters share the same sequence without creating credentials.
Only a new Runtime creates a fresh allocator; disconnect never releases a slot.
The existing server-fifo-v1 wire stamp remains compatible with r16 receivers.
"""
from receiver_pairing import ReceiverPairingPolicy, PairingError, PAIRING_WRITE_LOCK
from receiver_enrollment import ReceiverEnrollment


class RuntimeGroupPolicy(ReceiverPairingPolicy):
    def __init__(self, path, *, boot_id):
        super().__init__(path)
        self.boot_id = boot_id
        self._groups = {}
        self._adapter_groups = {}
        self._next_group = 1
        self._view_registry = self._view_groups = self._view = None

    def _load(self):
        # Existing consumers all read this view: payload validation, snapshots,
        # commands and the bounded per-packet view. Never save it to disk.
        with self._lock:
            registry = super()._load()
            if registry is None:
                return None
            if registry is not self._view_registry or self._groups is not self._view_groups:
                self._view = {**registry, 'receiver_groups': self._groups}
                self._view_registry, self._view_groups = registry, self._groups
            return self._view

    def ensure_group(self, principal):
        with PAIRING_WRITE_LOCK, self._lock:
            if not self.is_active(principal):
                raise PairingError('Inactive pairing cannot allocate GROUP')
            mac = principal['receiver_mac']
            if mac not in self._groups:
                # Copy-on-write preserves any packet view already in flight.
                self._groups = {**self._groups, mac: self._allocate_number()}
            return self._groups[mac]

    def _allocate_number(self):
        """Caller holds _lock; every receiver transport consumes this sequence."""
        if self._next_group > 16384:
            raise PairingError('Runtime GROUP capacity reached')
        number = self._next_group
        self._next_group += 1
        return number

    def ensure_adapter_group(self, adapter, receiver_id):
        """Internal verified-observation hook, never a public registration API.

        Namespace adapter identities separately from paired MACs; only the latter
        enter receiver_groups used for credential validation and command routing.
        """
        if any(not isinstance(v, str) or not v.strip() or len(v) > 256
               for v in (adapter, receiver_id)):
            raise PairingError('Invalid adapter receiver identity')
        with self._lock:
            key = (adapter, receiver_id)
            if key not in self._adapter_groups:
                self._adapter_groups[key] = self._allocate_number()
            return self._adapter_groups[key]

    def status(self):
        with self._lock:
            return {'policy': 'server-boot-fifo-v1', 'boot_id': self.boot_id,
                    'assigned_receivers': len(self._groups) + len(self._adapter_groups)}


class RuntimeEnrollment(ReceiverEnrollment):
    def __init__(self, runtime_policy, tls_config):
        # Enrollment writes the ORIGINAL credential registry, never the runtime
        # view. Its old GROUP map is retained solely as legacy rollback metadata.
        super().__init__(ReceiverPairingPolicy(runtime_policy.path), tls_config)
        self.runtime_policy = runtime_policy

    def enrollment_group(self, data, mac):
        return None  # Do not allocate before the credential write succeeds.

    def complete(self, body, peer):
        with PAIRING_WRITE_LOCK:
            result = super().complete(body, peer)
            bundle = result['pairing']
            principal = self.runtime_policy.authenticate(
                bundle['credential_id'], bundle['secret'],
                bundle['credential_id'] + '_enrolled', peer)
            result['group_number'] = self.runtime_policy.ensure_group(principal)
            return result
