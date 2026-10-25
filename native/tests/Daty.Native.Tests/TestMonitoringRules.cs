using System.Text.Json;
using Daty.Native.Core;

internal static class TestMonitoringRules
{
    private static readonly JsonDocument Fixture=JsonDocument.Parse(File.ReadAllText(Environment.GetEnvironmentVariable("DATY_MONITORING_RULES_FIXTURE")??throw new Exception("Run scripts/native.ps1 -Action Test to export the explicit server fixture")));
    public static MonitoringRules Value {get;}=MonitoringRules.Parse(Fixture.RootElement);
    public static TransmitterDisplay Display(Channel c)=>TransmitterDisplay.For(c,Value);
    public static bool Offline(Channel c)=>TransmitterReception.IsOffline(c,Value);
    public static double? CardRf(Channel c)=>TransmitterReception.CardRf(c,Value);
    public static IReadOnlyList<LiveIssue> Issues(Channel c,AlertThresholds t)=>LiveIssues.Evaluate(c,t,Value);
}
