const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');

test('the root EXE is the sole current launch entry and verifies the highest-version package',()=>{
 assert.ok(fs.statSync(path.join(root,'启动机器人.exe')).size>0);
 for(const obsolete of ['启动机器人.cmd','启动最新修复版.cmd','一键开启手机远程(免同一网络).cmd'])
  assert.equal(fs.existsSync(path.join(root,obsolete)),false,`${obsolete} should be removed`);
 const launcher=read('scripts/Launcher.cs'),manifest=read('scripts/write-launcher-manifest.cjs');
 const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
 assert.match(launcher,/OrderByDescending\(x => x\.Version\)/);
 assert.match(launcher,/Sha256\(candidate\.Exe\)/);
 assert.match(launcher,/Sha256\(candidate\.Asar\)/);
 assert.match(launcher,/--check-launch-target/);
 assert.match(manifest,/asar\.extractFile\(appAsar, 'package\.json'\)/);
 assert.match(read('scripts/preflight-runtime.cjs'),/fs\.lstatSync\(absolute\)\.isSymbolicLink\(\)/);
 assert.match(pkg.scripts['pack:win'],/write-launcher-manifest\.cjs/);
 assert.equal(pkg.build.directories.output,`release-v${pkg.version}`);
 assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
 assert.equal(lock.packages[''].devDependencies['@electron/asar'],pkg.devDependencies['@electron/asar']);
 assert.match(read('ui/index.html'),/id="runtime-package-path"/);
 assert.match(read('src/main.ts'),/runtimePackage:.*process\.execPath/);
});

test('Windows launcher chooses fake packages without starting QQ or a model', {skip:process.platform!=='win32'},()=>{
 const bash=spawnSync('bash',['--version'],{encoding:'utf8',timeout:5000});
 if(bash.error?.code==='ENOENT')return;
 assert.equal(bash.status,0,bash.stderr);
 const result=spawnSync('bash',['scripts/launcher-check.sh'],{cwd:root,encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
 assert.match(result.stdout,/PASS only latest release/);
 assert.match(result.stdout,/PASS newer release beats older secure artifact/);
 assert.match(result.stdout,/PASS missing\/corrupt package rejected/);
});
