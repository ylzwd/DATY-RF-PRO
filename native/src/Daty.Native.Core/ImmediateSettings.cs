using System.Text.Json;

namespace Daty.Native.Core;

/// <summary>Memory-only in-flight edits; the supplied server transaction is the sole durable store.</summary>
public sealed class ImmediateSettings(Func<string,JsonElement,Task<JsonElement>> save, Action<string,string,JsonElement?,Exception?> changed)
{
    private sealed class Edit
    {
        public JsonElement Value;
        public long Revision;
        public bool Dirty;
        public Task? Work;
    }
    private readonly Dictionary<string,Edit> edits=[];
    public bool HasUnsaved => edits.Values.Any(e=>e.Dirty);
    public JsonElement? PendingValue(string id)=>edits.TryGetValue(id,out var edit)&&edit.Dirty?edit.Value.Clone():null;
    public bool IsDirty(string id)=>edits.TryGetValue(id,out var e)&&e.Dirty;
    public Task Submit(string id,object value)
    {
        if(!edits.TryGetValue(id,out var edit))edits[id]=edit=new();
        edit.Value=JsonSerializer.SerializeToElement(value);edit.Revision++;edit.Dirty=true;
        changed(id,"saving",null,null);
        if(edit.Work is null||edit.Work.IsCompleted)edit.Work=Drain(id,edit);
        return edit.Work;
    }
    public Task Retry()=>Task.WhenAll(edits.Where(x=>x.Value.Dirty).ToArray().Select(x=>Submit(x.Key,x.Value.Value)));
    private async Task Drain(string id,Edit edit)
    {
        try
        {
            while(edit.Dirty)
            {
                var revision=edit.Revision;var requested=edit.Value.Clone();
                var committed=await save(id,requested);
                if(!JsonElement.DeepEquals(committed,requested))throw new InvalidDataException("数据库回执内容与本次设置不一致");
                if(edit.Revision==revision){edit.Dirty=false;changed(id,"saved",committed,null);}
                // A newer user edit is submitted immediately after this actual commit.
            }
        }
        catch(Exception error){changed(id,"error",null,error);}
    }
}
