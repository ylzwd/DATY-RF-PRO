using System.Diagnostics;

namespace Daty.Native.Core;

/// <summary>All ZIP/catalog I/O and verification run away from the UI thread.
/// The server still verifies the inner source archive and owns installation.</summary>
public sealed class PluginImportFile : IAsyncDisposable
{
    public PluginOfflineBundle? Bundle { get; }
    public byte[] Package { get; }
    public bool RequiresDependencySetup => Bundle is { Manifest.Id: not "shure-scp", Manifest.Runtimes.Length: > 0 };
    private PluginImportFile(PluginOfflineBundle? bundle,byte[] package){Bundle=bundle;Package=package;}
    public static Task<PluginImportFile> OpenAsync(string path,string catalogDirectory,CancellationToken token)
        =>Task.Run(async()=>
        {
            var elapsed=Stopwatch.StartNew();PluginOfflineBundle? bundle=null;
            try
            {
                if(await PluginOfflineBundle.IsOfflineBundleAsync(path,token).ConfigureAwait(false))
                {
                    var catalog=PluginOfflineBundle.Catalog(await LocalFiles.ReadBoundedAsync(Path.Combine(catalogDirectory,"plugin-bundles.json"),65536,token).ConfigureAwait(false));
                    var legacy=Path.Combine(catalogDirectory,"plugin-bundles-legacy.json");
                    if(File.Exists(legacy))catalog=catalog.Concat(PluginOfflineBundle.Catalog(await LocalFiles.ReadBoundedAsync(legacy,65536,token).ConfigureAwait(false))).Distinct().ToArray();
                    bundle=await PluginOfflineBundle.OpenAsync(path,catalog,token).ConfigureAwait(false);
                }
                var package=bundle is null?await LocalFiles.ReadBoundedAsync(path,131072,token).ConfigureAwait(false):await bundle.PluginAsync(token).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                Trace.WriteLine($"[PLUGIN_IMPORT] file_verified elapsed_ms={elapsed.ElapsedMilliseconds}");
                return new PluginImportFile(bundle,package);
            }
            catch
            {
                if(bundle is not null)await bundle.DisposeAsync().ConfigureAwait(false);
                Trace.WriteLine($"[PLUGIN_IMPORT] file_rejected elapsed_ms={elapsed.ElapsedMilliseconds}");
                throw;
            }
        },token);
    public async ValueTask DisposeAsync(){if(Bundle is not null)await Bundle.DisposeAsync().ConfigureAwait(false);}
}
