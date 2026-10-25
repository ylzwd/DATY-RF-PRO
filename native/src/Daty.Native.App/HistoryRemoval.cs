using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task<bool> RemovePlanningRecordAsync(JsonElement record)
    {
        var id=record.Text("id")!;
        if(!Confirm("删除规划历史","删除所选规划记录；接收机当前频率和其他规划保持。","删除记录",true,[("记录",record.Field("value").Text("name")??id),("版本",record.Text("revision")??"—")]))return false;
        try
        {
            var current=await OptionalResourceAsync("planning_current","default");var value=current?.Field("value")??default;
            var deleted=Array(value,"deletedRecordIds").Select(v=>v.Text()).OfType<string>().Append(id).Distinct().ToArray();
            await WriteBusinessAsync("database.batch",new(){{"writes",new object[]{
                new{kind="planning_records",id,expected_revision=(int)record.Number("revision")!,deleted=true,value=(object?)null},
                new{kind="planning_current",id="default",expected_revision=(int)(current?.Number("revision")??0),value=new{projectId="default",currentRecordId=value.Text("currentRecordId")==id?null:value.Text("currentRecordId"),deletedRecordIds=deleted}}
            }}});
            Message("所选规划历史已由服务器确认删除");return true;
        }
        catch(Exception e){Message("规划记录删除未确认："+SafeError(e),true);return false;}
    }
}
