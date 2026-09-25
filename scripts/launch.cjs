const {spawn}=require('node:child_process');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
const child=spawn(require('electron'),['.'],{cwd:require('node:path').join(__dirname,'..'),stdio:'inherit',env});
child.on('error',()=>{console.error('无法启动 Electron，请先运行 npm ci');process.exitCode=1});child.on('exit',code=>process.exit(code??1));
