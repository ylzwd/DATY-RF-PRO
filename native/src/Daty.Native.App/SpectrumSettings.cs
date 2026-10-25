using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private const string SpectrumSettingId="spectrum_scan";
    private ImmediateSettings? spectrumSettingsWriter;
    private JsonElement? spectrumSettingsValue;
    private bool spectrumSettingsReady;
    private string spectrumSettingsStatus="正在读取数据库频谱阈值…";
    private Action? spectrumSettingsRefresh;
    private bool SpectrumUnconfirmed=>spectrumSettingsWriter?.HasUnsaved==true||settingOperations.ContainsKey(SpectrumSettingId);
    private double? ScanPeakThresholdDbm=>spectrumSettingsReady?spectrumSettingsValue?.Number("peakThresholdDbm"):null;
    private double? ScanExclusionThresholdDbm=>spectrumSettingsReady?spectrumSettingsValue?.Number("exclusionThresholdDbm"):null;
    private DateTime spectrumRetryAt=DateTime.MaxValue;
    private int spectrumRetryDelay=2;

    private static void ValidateSpectrumSetting(JsonElement value)
    {
        if(value.Text("schema")!="daty-spectrum-settings-v1"||value.ValueKind!=JsonValueKind.Object||value.EnumerateObject().Count()!=3)
            throw new InvalidDataException("频谱阈值设置格式不受支持");
        foreach(var name in new[]{"peakThresholdDbm","exclusionThresholdDbm"})
            if(value.Number(name) is not double number||!double.IsFinite(number)||number is < -140 or > 0)
                throw new InvalidDataException("频谱阈值必须为 -140 至 0 dBm 的有效数值");
    }
    private ImmediateSettings SpectrumWriter()=>spectrumSettingsWriter??=new(WriteSystemSettingAsync,(_,state,value,error)=>
    {
        spectrumSettingsStatus=state=="saved"?"已保存到数据库":state=="saving"?"正在保存到数据库…":"未保存："+SafeError(error!);
        if(state=="saved")
        {
            if(value is JsonElement saved)spectrumSettingsValue=saved.Clone();
            spectrumRetryAt=DateTime.MaxValue;spectrumRetryDelay=2;
        }
        else if(state=="error")
        {
            // A conflict needs an explicit edit/retry; never overwrite another window automatically.
            spectrumRetryAt=error is R19RpcException {Status: >=400 and <500}?DateTime.MaxValue:DateTime.UtcNow.AddSeconds(spectrumRetryDelay);
            spectrumRetryDelay=Math.Min(30,spectrumRetryDelay*2);
        }
        spectrumSettingsRefresh?.Invoke();scanRefresh?.Invoke();
    });
    private async Task SetSpectrumThresholdsAsync(double peakDbm,double exclusionDbm)
    {
        if(!spectrumSettingsReady)throw new InvalidDataException("尚未读取数据库频谱阈值");
        var value=JsonSerializer.SerializeToElement(new{schema="daty-spectrum-settings-v1",peakThresholdDbm=peakDbm,exclusionThresholdDbm=exclusionDbm});
        ValidateSpectrumSetting(value);
        var exclusionChanged=ScanExclusionThresholdDbm!=exclusionDbm;
        spectrumSettingsValue=value;if(exclusionChanged)InvalidateSpectrumPlan();
        if(verification&&!fixtureNetwork){spectrumSettingsStatus="验收夹具阈值";spectrumSettingsRefresh?.Invoke();scanRefresh?.Invoke();return;}
        await SpectrumWriter().Submit(SpectrumSettingId,value);
    }
    private void ApplySpectrumSetting(JsonElement value)
    {
        ValidateSpectrumSetting(value);var exclusionChanged=ScanExclusionThresholdDbm!=value.Number("exclusionThresholdDbm");spectrumSettingsValue=value.Clone();spectrumSettingsReady=true;
        spectrumSettingsStatus="已从数据库读取";if(exclusionChanged)InvalidateSpectrumPlan();spectrumSettingsRefresh?.Invoke();scanRefresh?.Invoke();
    }
    private void InvalidateSpectrumPlan()
    {
        var range=(settings.StartMHz,settings.EndMHz,manualStart,manualEnd);InvalidatePlan();
        settings=settings with{StartMHz=range.Item1,EndMHz=range.Item2};manualStart=range.Item3;manualEnd=range.Item4;
    }
    private async Task InitializeSpectrumSettingsAsync()
    {
        var epoch=generation;
        try
        {
            var record=await OptionalResourceAsync("settings",SpectrumSettingId);
            if(record is null)throw new InvalidDataException("数据库尚无频谱阈值，请使用当前版本后台初始化");
            if(epoch!=generation)throw new OperationCanceledException();
            if(!SpectrumUnconfirmed)ApplySpectrumSetting(record.Value.Field("value"));
            sharedSettingsVersions[SpectrumSettingId]=record.Value.Number("revision")??0;
        }
        catch(Exception error)
        {
            spectrumSettingsStatus="频谱阈值读取失败："+SafeError(error);spectrumSettingsRefresh?.Invoke();throw;
        }
    }
    private async Task RetrySpectrumSettingsAsync()
    {
        if(!spectrumSettingsReady){await InitializeSpectrumSettingsAsync();return;}
        spectrumRetryAt=DateTime.MaxValue;
        if(spectrumSettingsWriter is not null)await spectrumSettingsWriter.Retry();
    }
    private void ResetSpectrumSettings()
    {
        spectrumSettingsWriter=null;spectrumSettingsValue=null;spectrumSettingsReady=false;
        spectrumInputInvalid=false;spectrumPeakInputDraft=spectrumExclusionInputDraft=null;spectrumEditor=null;
        spectrumSettingsStatus="正在读取数据库频谱阈值…";spectrumRetryAt=DateTime.MaxValue;spectrumRetryDelay=2;
        spectrumSettingsRefresh?.Invoke();
    }
    internal void SetSpectrumSettingsFixture(double peakDbm=-60,double exclusionDbm=-85)
    {
        if(!verification)throw new InvalidOperationException("Only isolated verification can inject spectrum settings");
        ApplySpectrumSetting(JsonSerializer.SerializeToElement(new{schema="daty-spectrum-settings-v1",peakThresholdDbm=peakDbm,exclusionThresholdDbm=exclusionDbm}));
    }
}
