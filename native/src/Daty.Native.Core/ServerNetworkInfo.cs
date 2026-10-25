using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace Daty.Native.Core;

// These are the connected server's reported interfaces, not the client endpoint or NICs.
public sealed record ServerNetworkInfo(string? Address, IReadOnlyList<string> Addresses)
{
    public static ServerNetworkInfo Parse(JsonElement value)
    {
        if (value.Field("success").ValueKind != JsonValueKind.True || value.Text("source") != "server-network-interfaces")
            throw new InvalidDataException("服务器网卡信息尚未确认");
        var list = value.Field("all_ips");
        if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > 128)
            throw new InvalidDataException("服务器网卡信息格式错误");
        var addresses = list.EnumerateArray().Select(e => UsableAddress(e.Text())).OfType<string>().Distinct().ToArray();
        var preferred = UsableAddress(value.Text("ip"));
        var address = preferred is not null && addresses.Contains(preferred) ? preferred
            : addresses.FirstOrDefault(a => IPAddress.Parse(a).AddressFamily == AddressFamily.InterNetwork) ?? addresses.FirstOrDefault();
        return new(address, addresses);
    }

    private static string? UsableAddress(string? value)
    {
        if (!IPAddress.TryParse(value, out var ip)) return null;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) || ip.IsIPv6LinkLocal || ip.IsIPv6Multicast) return null;
        var bytes = ip.GetAddressBytes();
        if (ip.AddressFamily == AddressFamily.InterNetwork && (bytes[0] == 0 || bytes[0] >= 224 || bytes[0] == 169 && bytes[1] == 254)) return null;
        return ip.ToString();
    }
}
