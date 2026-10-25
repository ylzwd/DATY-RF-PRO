using System.Globalization;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private (double Start,double End)? PlanningDisplayRange()
    {
        double start,end;var parts=planRange.Split(':');
        if(parts.Length==2&&double.TryParse(parts[0],CultureInfo.InvariantCulture,out start)&&double.TryParse(parts[1],CultureInfo.InvariantCulture,out end)){start/=1000;end/=1000;}
        else if(planRange=="scan"&&scan is {Points.Count:>0}){start=scan.Points.Min(p=>p.FrequencyKHz)/1000d;end=scan.Points.Max(p=>p.FrequencyKHz)/1000d;}
        else if(planRange=="custom"&&double.TryParse(planStart,CultureInfo.InvariantCulture,out start)&&double.TryParse(planEnd,CultureInfo.InvariantCulture,out end)){}
        else return null;
        return double.IsFinite(start)&&double.IsFinite(end)&&start>0&&end>start?(start,end):null;
    }
    private void FollowPlanningRange()
    {
        if(PlanningDisplayRange() is not { } range)return;
        manualStart=Math.Max(0,range.Start-10);manualEnd=range.End+10;
        settings=settings with{StartMHz=manualStart,EndMHz=manualEnd};
    }
}
