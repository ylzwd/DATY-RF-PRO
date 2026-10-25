using System.Text.Json;

namespace Daty.Native.Core;

public static class PlanningIntermodulation
{
    public static readonly IReadOnlyList<string> Products = System.Array.AsReadOnly(new[] { "2T3O", "2T5O", "2T7O", "2T9O", "3T3O" });
    public static string[] Read(string? stored, string legacyPolicy = "third")
    {
        if (stored is null) return legacyPolicy == "third-fifth" ? ["2T3O", "2T5O", "3T3O"] : ["2T3O", "3T3O"];
        var selected = stored.Length == 0 ? [] : stored.Split(',');
        if (selected.Distinct(StringComparer.Ordinal).Count() != selected.Length || selected.Any(x => !Products.Contains(x)))
            throw new InvalidDataException("互调规则仅支持 2T30、2T50、2T70、2T90、3T30");
        return Products.Where(selected.Contains).ToArray();
    }
    public static string[] FromOptions(JsonElement options)
    {
        if (options.TryGetProperty("imdProducts", out var selected))
            return Read(string.Join(',', selected.EnumerateArray().Select(p => p.GetString())));
        var orders = options.TryGetProperty("imdOrders", out var values) ? values.EnumerateArray().Select(p => p.GetInt32()).ToArray() : [3];
        var result = orders.Select(o => $"2T{o}O").ToList();
        if (!options.TryGetProperty("includeThreeTone", out var three) || three.GetBoolean()) result.Add("3T3O");
        return Read(string.Join(',', result));
    }
    public static string Display(string product) => product.Replace('O', '0');
    public static string Label(IEnumerable<string> selected) => string.Join(" + ", selected.Select(Display)) is { Length: > 0 } label ? label : "未选择互调规则";
    public static string Explanation(string product) => product switch
    {
        "2T3O" => "两发射源三阶：2f₁−f₂、2f₂−f₁",
        "2T5O" => "两发射源五阶：3f₁−2f₂、3f₂−2f₁",
        "2T7O" => "两发射源七阶：4f₁−3f₂、4f₂−3f₁",
        "2T9O" => "两发射源九阶：5f₁−4f₂、5f₂−4f₁",
        "3T3O" => "三发射源三阶：f₁+f₂−f₃、f₁+f₃−f₂、f₂+f₃−f₁",
        _ => throw new ArgumentException("未知互调规则", nameof(product))
    };
}
