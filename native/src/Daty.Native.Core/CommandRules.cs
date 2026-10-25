using System.Text.Json;

namespace Daty.Native.Core;

public static class CommandRules
{
    public static void ValidateFrequency(Channel channel, int frequency)
    {
        var capability = channel.Raw.Field("capabilities");
        var band = capability.Field("frequency_control");
        if (!channel.Online || !capability.Field("write_frequency").True())
            throw new InvalidDataException("当前接收机未开放调频");
        if (band.Number("min_khz") is not double min || band.Number("max_khz") is not double max ||
            band.Number("step_khz") is not double step || step <= 0 || Math.Truncate(step) != step)
            throw new InvalidDataException("接收机没有上报有效的硬件调频范围与步进");
        var origin = band.Number("origin_khz") ?? 0;
        if (frequency < min || frequency > max || (frequency - origin) % step != 0)
            throw new InvalidDataException($"频率必须在 {min / 1000:0.000}–{max / 1000:0.000} MHz 内，并符合 {step:0} kHz 硬件栅格");
    }

    public static bool SameJson(JsonElement left, JsonElement right) => JsonElement.DeepEquals(left, right);

    // A journal entry alone is not proof that the receiver executed a command.
    public static void ValidateReceipt(JsonElement receipt, JsonElement intent)
    {
        var target = intent.Field("target");
        var proof = receipt.Field("execution_evidence");
        if (receipt.Text("operation_id") != intent.Text("operation_id") ||
            receipt.Text("command") != intent.Text("command") ||
            !SameJson(receipt.Field("target"), target) ||
            !SameJson(receipt.Field("expected_value"), intent.Field("expected_value")))
            throw new InvalidDataException("设备回执与原始操作身份不匹配");
        if (receipt.Text("state") is not ("acknowledged" or "readback_confirmed")) return;
        if (!SameJson(receipt.Field("actual_value"), intent.Field("expected_value")) ||
            string.IsNullOrEmpty(receipt.Text("command_id")) ||
            proof.Text("command_id") != receipt.Text("command_id") ||
            proof.Text("receiver_session_id") != target.Text("receiver_session_id"))
            throw new InvalidDataException("设备实际值或回读会话不匹配");
        if (receipt.Text("state") == "readback_confirmed")
        {
            if (!string.Equals(target.Text("expected_brand"),"shure",StringComparison.OrdinalIgnoreCase) || proof.Text("source") != "shure-post-write-readback" ||
                proof.Field("execution_ack_supported").ValueKind != JsonValueKind.False ||
                !SameJson(proof.Field("target"), target) || proof.Text("command") != intent.Text("command") ||
                !SameJson(proof.Field("actual_value"), intent.Field("expected_value")))
                throw new InvalidDataException("舒尔独立回读证据无效");
        }
        else if (!string.Equals(target.Text("expected_brand"),"datyaudio",StringComparison.OrdinalIgnoreCase) || proof.Text("source") != "paired-receiver-status" ||
                 proof.Text("receiver_id") != target.Text("receiver_id") ||
                 proof.Text("device_id") != target.Text("device_id") ||
                 !SameJson(proof.Field("channel_number"), target.Field("channel_number")) ||
                 proof.Text("brand") != target.Text("expected_brand"))
            throw new InvalidDataException("接收机执行 ACK 证据无效");
    }
}
