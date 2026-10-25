using Microsoft.NET.HostModel.AppHost;

if (args.Length != 4) throw new ArgumentException("template output relative-managed-dll resource-dll required");
// The .NET apphost resolves the managed DLL and its self-contained runtime relative
// to itself. This adds a root entry without a second runtime or Windows Script Host.
if (Path.IsPathRooted(args[2]) || args[2].Split('/', '\\').Contains(".."))
    throw new ArgumentException("Managed assembly must stay within the portable folder");
HostWriter.CreateAppHost(args[0], args[1], args[2],
    windowsGraphicalUserInterface: true, assemblyToCopyResourcesFrom: args[3]);
Console.WriteLine(args[1]);
