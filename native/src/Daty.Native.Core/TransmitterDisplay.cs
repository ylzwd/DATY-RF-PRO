namespace Daty.Native.Core;

// Reception status only. ULXD's public protocol cannot distinguish RF MUTE
// from an absent transmitter; never claim that the power switch is off.
public sealed record TransmitterDisplay(string Label, string Tooltip)
{
    public static TransmitterDisplay For(Channel channel, MonitoringRules? rules = null)
    {
        var status = Status(channel, rules);
        if (rules is null) return status;
        return status with { Tooltip = Details(channel, rules, status) };
    }

    // Labels/thresholds retain the server DB rules. This is a read-only view of
    // protocol fields, never a second stored configuration or receiver identity.
    private static string Details(Channel c, MonitoringRules rules, TransmitterDisplay status)
    {
        static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null
            : string.Concat(value.Select(ch => char.IsControl(ch) ? ' ' : ch)).Trim();
        var shure = c.Raw.Field("shure");
        var model = Clean(shure.Text("transmitter_type"));
        var current = DisplayRules.IsShure(c.Raw) && c.Online && model is not null
            && status.Label == rules.Text("transmitter", "modelPrefix") + model;
        string Field(string key, string? value) => !current ? "当前不可用" :
            !DisplayRules.Fresh(c.Raw, key) ? rules.Text("signals", "staleText") : Clean(value) ?? "未上报";
        string Mute(string key) => Field(key, shure.Field(key).ValueKind switch {
            System.Text.Json.JsonValueKind.True => "已静音",
            System.Text.Json.JsonValueKind.False => "未静音", _ => null });
        var rows = new List<string> {
            "接收机标签：" + (Clean(c.Raw.Text("receiver_name")) ?? "未上报"),
            "接收机：" + c.Brand + " " + c.Model + (c.Online ? "（在线）" : "（离线，保留最后身份）"),
            "IP：" + c.Ip + "  ·  " + rules.Identity(c),
            "通道标签：" + (!c.Online ? "当前不可用" : !DisplayRules.Fresh(c.Raw,"name")
                ? rules.Text("signals","staleText") : Clean(c.Raw.Text("name")) ?? "未上报"),
            "接收频率：" + (!c.Online || !DisplayRules.Fresh(c.Raw,"frequency_khz") ? "当前不可用"
                : rules.Format(c.FrequencyKHz / 1000d,"frequency","decimals","unit")),
            "", "话筒状态：" + (Clean(status.Label) ?? "未上报")
        };
        if (DisplayRules.IsShure(c.Raw)) {
            rows.Add("话筒型号：" + Field("transmitter_type", model));
            rows.Add("话筒标签：" + Field("transmitter_name", shure.Text("transmitter_name")));
            rows.Add("话筒固件：" + Field("transmitter_firmware", shure.Text("transmitter_firmware")));
            rows.Add("话筒静音：" + Mute("transmitter_muted"));
            rows.Add("话筒电池：" + (current ? rules.Battery(c) : "当前不可用"));
            // Output mute belongs to the network receiver, not the transmitter.
            rows.Add("接收机输出：" + (!c.Online ? "当前不可用" : !DisplayRules.Fresh(c.Raw,"muted")
                ? rules.Text("signals","staleText") : shure.Field("receiver_muted").ValueKind switch {
                    System.Text.Json.JsonValueKind.True => "已静音",
                    System.Text.Json.JsonValueKind.False => "未静音", _ => "未上报" }));
        }
        if (!current && !string.IsNullOrWhiteSpace(status.Tooltip)) rows.Add("\n" + status.Tooltip);
        return string.Join("\n", rows);
    }

    private static TransmitterDisplay Status(Channel channel, MonitoringRules? rules)
    {
        if (rules is null) return new("", "数据库显示规则尚未读取");
        var raw = channel.Raw;
        if (TransmitterReception.IsOffline(channel, rules))
            return new(rules.Text("transmitter","offlineText"), (TransmitterReception.NoReception(channel,rules)
                ? "接收机新鲜上报 XX：当前无有效话筒接收；RF底噪变化不表示话筒上线。"
                : $"按数据库 RF 低于 {rules.OfflineBelowDbm:0.###} dBm 的规则判定离线。")+"接收机网络连接与电源开关状态独立，不能单独区分关机、RF MUTE或超距。");
        if (!DisplayRules.IsShure(raw)) return new("", "");
        if (!channel.Online)
            return new(rules.Text("transmitter","unknownText"), "接收机连接已中断，无法确认当前话筒状态。");

        var shure = raw.Field("shure");
        var model = shure.Text("transmitter_type")?.Trim();
        var modelKnown = DisplayRules.Fresh(raw, "transmitter_type") &&
            !string.IsNullOrEmpty(model) && model.ToUpperInvariant() is not ("UNKN" or "UNKNOWN" or "—");

        if (channel.Model is "ULXD4" or "ULXD4D" or "ULXD4Q")
        {
            if (TransmitterReception.CurrentRf(channel) is null || !DisplayRules.Fresh(raw, "rf_antenna"))
                return new(rules.Text("transmitter","unknownText"), "实时接收状态不可用，等待接收机新的有效上报。");
            var antenna = shure.Text("rf_antenna");
            if (antenna == "XX")
                return new(rules.Text("transmitter","modelUnknownText"), "RF 未低于离线阈值，但接收机尚未报告有效话筒接收；不沿用旧型号。");
            if (antenna is "AX" or "XB" || antenna == "AB" && channel.Model != "ULXD4")
                return modelKnown
                    ? new(rules.Text("transmitter","modelPrefix") + model, "接收机当前上报的话筒型号：" + model)
                    : new(rules.Text("transmitter","connectingText"), "已收到有效 RF 接收状态，正在等待当前话筒型号。");
            return new(rules.Text("transmitter","unknownText"), "接收机未提供有效的天线接收状态。");
        }

        // Do not apply ULXD antenna semantics to another product family.
        return modelKnown
            ? new(rules.Text("transmitter","modelPrefix") + model, "接收机当前上报的话筒型号：" + model)
            : new(rules.Text("transmitter","modelUnknownText"), "当前型号信息不可用，不能据此判定话筒离线。");
    }
}
