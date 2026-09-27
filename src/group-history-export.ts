import fs from 'node:fs';
import path from 'node:path';

export type GroupHistoryMode = 'all' | 'member';
export type GroupHistoryPhase = 'idle' | 'running' | 'complete' | 'partial' | 'cancelled' | 'error';

export interface GroupHistoryView {
  phase: GroupHistoryPhase;
  mode: GroupHistoryMode | null;
  groupId: string | null;
  memberId: string | null;
  accountId: string | null;
  directory: string | null;
  pagesFetched: number;
  uniqueGroupMessages: number;
  recordsExported: number;
  memberCount: number;
  bytesWritten: number;
  startedAt: string | null;
  finishedAt: string | null;
  stopReason: string | null;
  errorCode: string | null;
  message: string;
  cancelling: boolean;
}

interface ManifestProgress {
  accountId?: string;
  pagesFetched: number;
  uniqueGroupMessages: number;
  recordsExported: number;
  memberCount: number;
  bytesWritten: number;
  stopReason: string | null;
  errorCode: string | null;
  finishedAt: string | null;
  status: string;
}
interface ExportOutcome {
  code: number;
  dir: string | null;
  manifest: ManifestProgress | null;
  error: string | null;
  warnings: string[];
}
export type GroupHistoryRunner = (args: string[], env: NodeJS.ProcessEnv, hooks: {
  signal: AbortSignal;
  onProgress: (manifest: ManifestProgress, directory: string) => void;
}) => Promise<ExportOutcome>;

// The same pagination, manifest, media-reference and failure logic powers the CLI and desktop.
// The packaged app must include this single CJS file alongside dist/.
const {runExport} = require('../tools/export-group-history.cjs') as {runExport: GroupHistoryRunner};
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{4,15}$/.test(value);
const emptyView = (): GroupHistoryView => ({
  phase: 'idle', mode: null, groupId: null, memberId: null, accountId: null, directory: null,
  pagesFetched: 0, uniqueGroupMessages: 0, recordsExported: 0, memberCount: 0, bytesWritten: 0,
  startedAt: null, finishedAt: null, stopReason: null, errorCode: null, message: '尚未导出', cancelling: false
});

/** Desktop-only orchestration. Never accepts a URL, output path, access token, or CLI flags from IPC. */
export class GroupHistoryExport {
  private state: GroupHistoryView = emptyView();
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private lastUpdate = 0;
  constructor(
    private readonly profileDir: string,
    private readonly notify: (view: GroupHistoryView) => void,
    private readonly runner: GroupHistoryRunner = runExport,
    private readonly sourceEnv: NodeJS.ProcessEnv = process.env
  ) {
    if (!path.isAbsolute(profileDir)) throw new Error('应用数据目录必须是绝对路径');
  }
  get view(): GroupHistoryView { return {...this.state}; }
  get busy(): boolean { return !!this.task; }
  get directory(): string | null { return this.task ? null : this.state.directory; }
  private publish() { try { this.notify(this.view); } catch { /* a closed window must not abort disk export */ } }
  private progress(m: ManifestProgress, directory: string) {
    this.state.accountId = m.accountId || this.state.accountId;
    this.state.directory = directory;
    this.state.pagesFetched = m.pagesFetched;
    this.state.uniqueGroupMessages = m.uniqueGroupMessages;
    this.state.recordsExported = m.recordsExported;
    this.state.memberCount = m.memberCount;
    this.state.bytesWritten = m.bytesWritten;
    const now = Date.now();
    if (this.state.pagesFetched === 0 || this.state.pagesFetched === 1 || now - this.lastUpdate >= 300) {
      this.lastUpdate = now; this.publish();
    }
  }
  start(input: {group?: unknown; mode?: unknown; member?: unknown; confirm?: unknown}, connected: boolean): GroupHistoryView {
    if (this.task) throw new Error('已有群历史导出正在运行，请等待完成或先取消');
    if (input?.confirm !== true) throw new Error('请确认有权导出群成员的聊天记录并妥善保管明文文件');
    if (!connected) throw new Error('请先在本软件登录 QQ，保持 NapCat 连接后再导出');
    if (!validId(input.group)) throw new Error('请输入有效的 5–16 位群号');
    if (input.mode !== 'all' && input.mode !== 'member') throw new Error('请选择整群或指定成员');
    if (input.mode === 'member' && !validId(input.member)) throw new Error('请输入有效的 5–16 位成员 QQ 号');
    if (input.mode === 'all' && input.member !== undefined && input.member !== '') throw new Error('整群模式不应附带成员号码');
    const group = input.group, mode = input.mode, member = mode === 'member' ? input.member as string : null;
    const args = ['--group', group, mode === 'all' ? '--all' : '--member'];
    if (member) args.push(member);
    args.push('--profile-dir', this.profileDir);
    // Pass only the output base. The desktop always uses its own managed localhost socket/secret;
    // arbitrary inherited environment secrets and manual NapCat overrides never reach the runner.
    const env: NodeJS.ProcessEnv = {LOCALAPPDATA: this.sourceEnv.LOCALAPPDATA};
    this.state = {...emptyView(), phase:'running', groupId:group, mode, memberId:member, startedAt:new Date().toISOString(), message:'正在连接本机 NapCat…'};
    this.lastUpdate = 0;
    const controller = this.controller = new AbortController();
    let task: Promise<void>;
    task = Promise.resolve().then(() => this.runner(args, env, {
      signal: controller.signal, onProgress: (manifest, directory) => {
        if (this.controller === controller && this.state.phase === 'running') this.progress(manifest, directory);
      }
    })).then(result => {
      if (this.controller !== controller) return;
      if (result.manifest && result.dir) this.progress(result.manifest, result.dir);
      this.state.directory = result.dir;
      this.state.stopReason = result.manifest?.stopReason || null;
      this.state.errorCode = result.manifest?.errorCode || null;
      this.state.finishedAt = result.manifest?.finishedAt || new Date().toISOString();
      this.state.phase = controller.signal.aborted || result.manifest?.errorCode === 'interrupted' ? 'cancelled'
        : result.code === 0 && result.manifest?.status === 'available-range-exported' ? 'complete'
        : result.dir ? 'partial' : 'error';
      this.state.message = result.error || result.warnings?.join('；') || (this.state.phase === 'complete'
        ? '已导出当前接口可访问的范围；不保证建群以来无缺页' : '导出未完成；请检查连接和状态清单');
      if (this.state.phase === 'cancelled') this.state.message = '已取消。已有文件是部分导出，不得视为完整。';
      this.state.cancelling = false;
    }).catch(() => {
      // Do not surface arbitrary exceptions from a socket, filesystem, or QQ as UI/log text.
      this.state.phase = controller.signal.aborted ? 'cancelled' : 'error';
      this.state.message = controller.signal.aborted ? '已取消导出' : '导出遇到未预期错误；如有输出请检查 manifest.json';
      this.state.finishedAt = new Date().toISOString();
      this.state.cancelling = false;
    }).finally(() => {
      if (this.task === task) { this.task = null; this.controller = null; }
      this.publish();
    });
    this.task = task; this.publish();
    return this.view;
  }
  cancel(): GroupHistoryView {
    if (this.controller && !this.controller.signal.aborted) {
      this.state.cancelling = true;
      this.state.message = '正在取消并保存部分导出状态…';
      this.controller.abort(); this.publish();
    }
    return this.view;
  }
  async stop(): Promise<void> { this.cancel(); if (this.task) await this.task; }
  canOpen(): boolean { return !this.task && !!this.state.directory && fs.existsSync(this.state.directory); }
}
