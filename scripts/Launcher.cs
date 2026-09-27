using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Both EXE launchers use this selector. Only complete, hashed packages qualify.
class Launcher {
 sealed class Candidate {
  public Version Version;
  public string Exe, Asar, ExeHash, AsarHash;
  public DateTime WriteTime;
  public bool IsRelease;
 }

 [STAThread] static int Main(string[] args) {
  var baseDir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
  string root = baseDir.FullName;
  if (String.Equals(baseDir.Name, "scripts", StringComparison.OrdinalIgnoreCase))
   root = baseDir.Parent.FullName;
  // Offline preflight: never spawns QQ or displays a dialog. Verify the selected
  // version, not merely that some older fallback is launchable.
  bool checkOnly = args.Length == 1 && args[0] == "--check-launch-target";
  const string checkVersionPrefix = "--check-launch-version=";
  string expectedVersion = args.Length == 1 && args[0].StartsWith(checkVersionPrefix, StringComparison.Ordinal)
   ? args[0].Substring(checkVersionPrefix.Length) : null;
  bool checkVersion = expectedVersion != null && Regex.IsMatch(expectedVersion, @"^\d+\.\d+\.\d+$");
  if (args.Length != 0 && !checkOnly && !checkVersion) return 2;
  try {
   string exe = FindNewest(root);
   if (exe == null) {
    if (checkOnly || checkVersion) return 2;
    throw new FileNotFoundException("未找到通过版本与 SHA256 校验的完整打包目录。请运行 npm run pack:win；旧包须先生成 launch-manifest.json。");
   }
   if (checkOnly) return 0;
   if (checkVersion) {
    string expected = Path.GetFullPath(Path.Combine(root, "release-v" + expectedVersion, "win-unpacked", "QQ AI Bot.exe"));
    return String.Equals(Path.GetFullPath(exe), expected, StringComparison.OrdinalIgnoreCase) ? 0 : 2;
   }
   var start = new ProcessStartInfo(exe) { WorkingDirectory = Path.GetDirectoryName(exe), UseShellExecute = false };
   start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
   start.EnvironmentVariables.Remove("NODE_OPTIONS");
   Process.Start(start);
   return 0;
  } catch (Exception ex) {
   if (checkOnly || checkVersion) return 2;
   MessageBox.Show(ex.Message + "\n\n目录：" + root, "QQ AI Bot 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
   return 1;
  }
 }

 static string ManifestString(Dictionary<string, object> values, string key) {
  object value;
  return values.TryGetValue(key, out value) ? value as string : null;
 }

 static Candidate ReadCandidate(string exe, string folderVersion, bool isRelease) {
  try {
   string dir = Path.GetDirectoryName(exe);
   string manifest = Path.Combine(dir, "launch-manifest.json");
   string asar = Path.Combine(dir, "resources", "app.asar");
   if (!File.Exists(exe) || !File.Exists(manifest) || !File.Exists(asar)) return null;
   var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
   string versionText = ManifestString(data, "version");
   string exeHash = ManifestString(data, "exeSha256");
   string asarHash = ManifestString(data, "asarSha256");
   object schema;
   if (!data.TryGetValue("schemaVersion", out schema) || Convert.ToInt32(schema) != 1 ||
       ManifestString(data, "app") != "qq-ai-bot" ||
       versionText == null || !Regex.IsMatch(versionText, @"^\d+\.\d+\.\d+$") ||
       (folderVersion != null && folderVersion != versionText) ||
       exeHash == null || !Regex.IsMatch(exeHash, @"^[a-fA-F0-9]{64}$") ||
       asarHash == null || !Regex.IsMatch(asarHash, @"^[a-fA-F0-9]{64}$")) return null;
   Version version;
   if (!Version.TryParse(versionText, out version)) return null;
   return new Candidate { Version = version, Exe = exe, Asar = asar,
    ExeHash = exeHash, AsarHash = asarHash, WriteTime = File.GetLastWriteTimeUtc(exe), IsRelease = isRelease };
  } catch { return null; } // Ignore partial or stale packages; try the next verified candidate.
 }

 static string Sha256(string file) {
  using (var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
  using (var sha = SHA256.Create())
   return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
 }

 static bool Verify(Candidate candidate) {
  try {
   string resources = Path.Combine(Path.GetDirectoryName(candidate.Exe), "resources");
   if (!Directory.Exists(Path.Combine(resources, "napcat-runtime"))) return false;
   if (!File.Exists(Path.Combine(resources, "THIRD-PARTY-NOTICES.md"))) return false;
   return String.Equals(Sha256(candidate.Exe), candidate.ExeHash, StringComparison.OrdinalIgnoreCase) &&
          String.Equals(Sha256(candidate.Asar), candidate.AsarHash, StringComparison.OrdinalIgnoreCase);
  } catch { return false; }
 }

 static string FindNewest(string root) {
  var found = new List<Candidate>();
  var secure = Path.Combine(root, "artifacts", "mcp-secure-remote", "packaged", "win-unpacked", "QQ AI Bot.exe");
  var legacy = ReadCandidate(secure, null, false);
  if (legacy != null) found.Add(legacy);
  foreach (var dir in Directory.GetDirectories(root, "release-v*", SearchOption.TopDirectoryOnly)) {
   string name = Path.GetFileName(dir);
   string version = name.StartsWith("release-v", StringComparison.OrdinalIgnoreCase) ? name.Substring(9) : "";
   if (!Regex.IsMatch(version, @"^\d+\.\d+\.\d+$")) continue;
   var candidate = ReadCandidate(Path.Combine(dir, "win-unpacked", "QQ AI Bot.exe"), version, true);
   if (candidate != null) found.Add(candidate);
  }
  // A newer version always wins. On equal versions prefer the newer build, then release-v*.
  foreach (var candidate in found.OrderByDescending(x => x.Version)
                                 .ThenByDescending(x => x.WriteTime)
                                 .ThenByDescending(x => x.IsRelease))
   if (Verify(candidate)) return candidate.Exe;
  return null;
 }
}
