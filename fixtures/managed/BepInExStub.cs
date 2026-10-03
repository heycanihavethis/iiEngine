// Inert metadata fixture. This is not a loader and must never be installed into a game.
using System;
using System.Reflection;
[assembly: AssemblyVersion("5.4.23.5")]
namespace BepInEx {
    [AttributeUsage(AttributeTargets.Class)]
    public sealed class BepInPlugin : Attribute {
        public BepInPlugin(string guid, string name, string version) { }
    }
}
