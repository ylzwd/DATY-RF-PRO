using System.Text.Json;
using Daty.Native.Core;

internal static class ServerNetworkCases
{
    public static IEnumerable<(string Name, Action Run)> All()
    {
        ServerNetworkInfo Read(string? ip, params string[] addresses) => ServerNetworkInfo.Parse(JsonSerializer.SerializeToElement(new { success = true, source = "server-network-interfaces", ip, all_ips = addresses, peer_ip = "127.0.0.1" }));
        void Check(bool ok) { if (!ok) throw new Exception("Server interface selection was incorrect"); }
        yield return ("LAN label uses reported server interface, never loopback client peer", () =>
        {
            Check(Read("192.0.2.16", "192.0.2.16", "127.0.0.1", "fe80::1234").Address == "192.0.2.16");
            Check(Read("127.0.0.1", "127.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.1.2", "0.0.0.0", "224.0.0.1", "255.255.255.255").Address is null);
        });
        yield return ("Server NIC selection handles multiple NICs, IPv6 and changed networks", () =>
        {
            Check(Read("10.0.0.5", "192.0.2.16", "10.0.0.5").Address == "10.0.0.5");
            Check(Read("fe80::1234", "fe80::1234", "192.0.2.16").Address == "192.0.2.16");
            Check(Read("fd00::5", "fd00::5").Address == "fd00::5");
            Check(Read("192.0.2.16", "10.2.3.4").Address == "10.2.3.4");
        });
        yield return ("Unavailable server network never invents a client-side address", () =>
        {
            Check(Read(null).Address is null);
            foreach (var value in new object[] { new { success = false, source = "server-network-interfaces" }, new { success = true, source = "client-interfaces" } })
            {
                try { ServerNetworkInfo.Parse(JsonSerializer.SerializeToElement(value)); throw new Exception("Unconfirmed network source accepted"); }
                catch (InvalidDataException) { }
            }
        });
    }
}
