using Daty.Native.Core;

internal static class ProjectCases
{
    public static IEnumerable<(string Name,Action Run)> All()
    {
        yield return ("Integrated project rejects switching backend before writing connection settings",()=>
        {
            var root=Path.Combine(Path.GetTempPath(),"daty-integrated-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(Path.Combine(root,"config"));
            var previous=Environment.GetEnvironmentVariable("DATY_PROJECT_ROOT");
            try
            {
                File.WriteAllText(Path.Combine(root,"config","project-development.json"),"{\"schema\":\"daty-standalone-project-v1\",\"web_port\":18080,\"mqtt_port\":18083}");
                Environment.SetEnvironmentVariable("DATY_PROJECT_ROOT",root);
                var project=ProjectEnvironment.Current!;var original=project.Defaults with {PollSeconds=7};
                original.SaveAsync(project.SettingsPath,default).GetAwaiter().GetResult();
                var bytes=File.ReadAllBytes(project.SettingsPath);
                foreach(var changed in new[]{original with {Server="https://192.0.2.17:18080"},original with {MqttPort=8083}})
                {
                    var rejected=false;try{changed.SaveAsync(project.SettingsPath,default).GetAwaiter().GetResult();}catch(InvalidDataException){rejected=true;}
                    if(!rejected||!bytes.SequenceEqual(File.ReadAllBytes(project.SettingsPath)))throw new Exception("Integrated backend binding was modified");
                }
            }
            finally{Environment.SetEnvironmentVariable("DATY_PROJECT_ROOT",previous);Directory.Delete(root,true);}
        });
        yield return ("Copy to a different computer selects new private state without reading old keys",()=>
        {
            var root=Path.Combine(Path.GetTempPath(),"daty-host-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(Path.Combine(root,"config"));
            try
            {
                var a=new string('a',32);var b=new string('b',32);
                File.WriteAllText(Path.Combine(root,"config","project-instance.local.json"),"{\"host_id\":\""+a+"\"}");
                if(ProjectEnvironment.InstanceDirectory(root,a)!=root || ProjectEnvironment.InstanceDirectory(root,b)!=Path.Combine(root,".local-instances",b))throw new Exception("Machine isolation failed");
            }
            finally {Directory.Delete(root,true);}
        });
        yield return ("Unowned copied identity is never silently adopted",()=>
        {
            var root=Path.Combine(Path.GetTempPath(),"daty-host-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(Path.Combine(root,"config"));
            try
            {
                File.WriteAllText(Path.Combine(root,"config","project-instance.local.json"),"{}");
                try{ProjectEnvironment.InstanceDirectory(root,new string('a',32));}catch(InvalidDataException){return;}
                throw new Exception("Unknown identity was adopted");
            }
            finally {Directory.Delete(root,true);}
        });
        yield return ("Independent project discovery follows relocated root and uses local identity",()=>
        {
            var root=Path.Combine(Path.GetTempPath(),"daty-project-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(root,"config"));Directory.CreateDirectory(Path.Combine(root,"native","publish","version"));
            try
            {
                File.WriteAllText(Path.Combine(root,"config","project-development.json"),"{\"schema\":\"daty-standalone-project-v1\",\"web_port\":18080,\"mqtt_port\":18083}");
                var p=ProjectEnvironment.Discover(Path.Combine(root,"native","publish","version"))!;
                if(p.Root!=root || p.Defaults.Server!="https://127.0.0.1:18080" || p.Defaults.MqttPort!=18083 || !p.CertificatePath.StartsWith(root) || !p.SettingsPath.StartsWith(root))throw new Exception("Project isolation failed");
            }
            finally{Directory.Delete(root,true);}
        });
        yield return ("Explicit invalid project cannot fall back to formal server",()=>
        {
            try {ProjectEnvironment.Discover(AppContext.BaseDirectory,Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")));}
            catch(InvalidDataException){return;}
            throw new Exception("Invalid project unexpectedly accepted");
        });
        yield return ("Unrelated installed app preserves original connection scope",()=>
        {
            if(ProjectEnvironment.Discover(Path.GetPathRoot(Path.GetTempPath())!) is not null)throw new Exception("Unrelated app redirected");
        });
    }
}
