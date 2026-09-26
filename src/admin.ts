import type { Store } from './store';
import type { ApiAccount } from './api-account';
import type { UsageLedger } from './usage-ledger';
import type { OneBot } from './onebot';
import type { ControlService } from './control';
import type { GroupMemory, StickerBook } from './persona-layer';
import type { Engine } from './engine';

export interface AdminContext {
  store: Store;
  control: ControlService;
  account: ApiAccount;
  usage: UsageLedger;
  bot: OneBot;
  log?: (msg: string) => void;
  memory?: GroupMemory;
  engine?: Engine;
  stickers?: StickerBook;
}

export class AdminCommandHandler {
  constructor(private ctx: AdminContext) {}

  isAdmin(userId: string): boolean {
    const uid = String(userId).trim();
    if (!uid) return false;
    return (this.ctx.store.config.adminIds || []).includes(uid);
  }

  isCommand(text: string): boolean {
    const t = text.trim();
    return t.startsWith('#') || t.startsWith('/') || t.startsWith('＃');
  }

  async handleEvent(event: any, selfId: string): Promise<boolean> {
    if (!event || event.post_type !== 'message' || event.message_type !== 'private') {
      return false;
    }
    const userId = String(event.user_id || '').trim();
    if (!this.isAdmin(userId)) {
      return false;
    }

    const raw = (
      event.raw_message ||
      (Array.isArray(event.message)
        ? event.message.map((m: any) => (m && m.type === 'text' ? m.data?.text : '')).join('')
        : '') ||
      ''
    ).trim();

    if (!this.isCommand(raw)) {
      return false;
    }

    try {
      const replyText = await this.execute(raw, userId);
      if (replyText) {
        await this.ctx.bot.call('send_private_msg', {
          user_id: Number(userId) || userId,
          message: [{ type: 'text', data: { text: replyText } }]
        });
        const commandName=raw.replace(/^[#/＃]/,'').trim().split(/\s+/)[0]||'未知';
        this.ctx.log?.(`[管理员指令] 用户 ${userId} 执行指令: ${commandName}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.ctx.log?.(`[管理员指令] 处理指令失败: ${errMsg}`);
    }
    return true;
  }

  async execute(commandText: string, senderId: string): Promise<string> {
    if (!this.isAdmin(senderId)) throw new Error('无管理员权限');
    const clean = commandText.replace(/^[#/＃]/, '').trim();
    const parts = clean.split(/\s+/);
    const cmd = parts[0]?.toLowerCase() || '';
    const arg = parts.slice(1).join(' ').trim();
    const actor={source:'qq' as const,id:String(senderId)};

    switch (cmd) {
      case '帮助':
      case 'help':
        return [
          '【QQ AI Bot 管理员指令】',
          '• #余额 - 查看 DeepSeek 余额与用量',
          '• #状态 - 查看机器人运行状态与白名单',
          '• #加群 <群号> - 将指定群加入白名单',
          '• #退群 <群号> - 将指定群移出白名单',
          '• #加好友 <QQ号> - 添加好友到私聊白名单',
          '• #删好友 <QQ号> - 从私聊白名单中移出',
          '• #暂停 - 暂停自动回复',
          '• #启动 - 恢复自动回复',
          '• #人设 <内容> - 修改或查看全局人设提示词',
          '• #面板 - 查看已配置的 iPhone 固定远程地址',
          '• #记忆 <群号> / #记住 <群号> <一句话> / #忘记 <群号> - 查看、追加、清空该群的长期记忆本',
          '• #静音 <群号> [分钟] / #解除静音 <群号> - 让机器人在该群闭嘴一段时间（默认 30 分钟）',
          '• #表情包 - 查看机器人学到的表情包关键词'
        ].join('\n');

      case '余额':
      case 'balance': {
        let balText = '查询中...';
        try {
          await this.ctx.account.queryBalance(this.ctx.store.config, this.ctx.store.key);
          const v = this.ctx.account.view;
          if (v.balance.data && v.balance.data.balances && v.balance.data.balances.length) {
            const b = v.balance.data.balances[0];
            balText = `¥${b.total}`;
            if (b.granted && b.granted !== '0.00') {
              balText += ` (含赠送 ¥${b.granted})`;
            }
          } else if (v.balance.error) {
            balText = `查询失败: ${v.balance.error}`;
          }
        } catch (e) {
          balText = `查询异常: ${e instanceof Error ? e.message : '网络超时'}`;
        }

        const usageView = this.ctx.usage.view;
        const totalCost = usageView.total?.amount ? `¥${usageView.total.amount}` : '¥0.00';
        const totalCalls = usageView.total?.calls ?? 0;
        return [
          '【DeepSeek 账户与用量】',
          `当前可用余额：${balText}`,
          `累计调用次数：${totalCalls} 次`,
          `历史累计消耗：${totalCost}`,
          `当前模型：${this.ctx.store.config.model}`
        ].join('\n');
      }

      case '状态':
      case 'status': {
        const cfg = this.ctx.store.config;
        const isRunning = this.ctx.control.remoteState().running;
        const groupList = cfg.groups.length ? cfg.groups.join(', ') : '无';
        const friendList = cfg.friends.length ? cfg.friends.join(', ') : '无';
        const proactiveList = cfg.proactiveGroups.length ? cfg.proactiveGroups.join(', ') : '未开启';

        return [
          '【QQ AI Bot 运行状态】',
          `机器人 QQ：${this.ctx.bot.self || '未连接'} (${this.ctx.bot.selfName || '未命名'})`,
          `自动回复：${isRunning ? '运行中 (已开启)' : '已暂停'}`,
          `白名单群聊 (${cfg.groups.length}个)：${groupList}`,
          `白名单好友 (${cfg.friends.length}个)：${friendList}`,
          `主动接话群：${proactiveList}`,
          `原图视觉识别：${cfg.visionEnabled ? '开启' : '关闭'}`
        ].join('\n');
      }

      case '加群': {
        if (!/^\d{5,16}$/.test(arg)) {
          return '群号格式错误，请输入 5–16 位数字群号，例如：#加群 20000001';
        }
        const cfg = this.ctx.store.config;
        if (cfg.groups.includes(arg)) {
          return `群 ${arg} 已经在白名单中，无需重复添加。`;
        }
        const result=this.ctx.control.addTarget(actor,'group',arg);
        return `成功添加群 ${arg} 到白名单！当前共有 ${result.config.groups.length} 个白名单群。`;
      }

      case '退群':
      case '删群': {
        if (!/^\d{5,16}$/.test(arg)) {
          return '群号格式错误，请输入 5–16 位数字群号，例如：#退群 20000001';
        }
        const cfg = this.ctx.store.config;
        if (!cfg.groups.includes(arg)) {
          return `群 ${arg} 不在白名单中。`;
        }
        const result=this.ctx.control.removeTarget(actor,'group',arg);
        return `已将群 ${arg} 移出白名单。当前剩余 ${result.config.groups.length} 个白名单群。`;
      }

      case '加好友':
      case '加私聊': {
        if (!/^\d{5,16}$/.test(arg)) {
          return 'QQ号格式错误，请输入 5–16 位数字，例如：#加好友 12345678';
        }
        const cfg = this.ctx.store.config;
        if (cfg.friends.includes(arg)) {
          return `好友 ${arg} 已经在私聊白名单中。`;
        }
        const result=this.ctx.control.addTarget(actor,'friend',arg);
        return `成功将好友 ${arg} 加入私聊白名单！当前共有 ${result.config.friends.length} 位好友。`;
      }

      case '删好友':
      case '删私聊': {
        if (!/^\d{5,16}$/.test(arg)) {
          return 'QQ号格式错误，请输入 5–16 位数字，例如：#删好友 12345678';
        }
        const cfg = this.ctx.store.config;
        if (!cfg.friends.includes(arg)) {
          return `好友 ${arg} 不在私聊白名单中。`;
        }
        const result=this.ctx.control.removeTarget(actor,'friend',arg);
        return `已将好友 ${arg} 移出私聊白名单。当前剩余 ${result.config.friends.length} 位好友。`;
      }

      case '暂停':
      case 'pause':
        this.ctx.control.pause(actor);
        return '自动回复已暂停。机器人将不会回复任何私聊或群聊消息。发送 #启动 可恢复。';

      case '启动':
      case 'start':
        this.ctx.control.start(actor);
        return '自动回复已恢复启动！正在正常响应白名单消息。';

      case '人设':
      case 'prompt': {
        const cfg = this.ctx.store.config;
        if (!arg) {
          return `【当前全局人设提示词】\n${cfg.prompt}`;
        }
        if (arg.length > 4000) {
          return '提示词过长（最多 4000 字符），请缩短后再试。';
        }
        this.ctx.control.setPersona(actor,arg);
        return `全局人设已更新成功！\n当前人设：\n${arg}`;
      }

      case '记忆': {
        if (!/^\d{5,16}$/.test(arg)) return '用法：#记忆 <群号>';
        const text = this.ctx.memory?.get(arg) || '';
        return text ? `【群 ${arg} 的记忆本】\n${text.slice(0, 1500)}` : `群 ${arg} 还没有记忆本。用 #记住 ${arg} <一句话> 添加。`;
      }
      case '记住': {
        const m = arg.match(/^(\d{5,16})\s+([\s\S]{1,300})$/);
        if (!m) return '用法：#记住 <群号> <一句话>';
        this.ctx.memory?.append(m[1], m[2]);
        return `已写入群 ${m[1]} 的记忆本：${m[2].trim()}`;
      }
      case '忘记': {
        if (!/^\d{5,16}$/.test(arg)) return '用法：#忘记 <群号>';
        this.ctx.memory?.clear(arg);
        return `已清空群 ${arg} 的记忆本。`;
      }
      case '静音': {
        const m = arg.match(/^(\d{5,16})(?:\s+(\d{1,4}))?$/);
        if (!m) return '用法：#静音 <群号> [分钟]';
        const minutes = m[2] ? Number(m[2]) : 30;
        this.ctx.engine?.guard.mute(m[1], Date.now(), minutes * 60_000);
        return `群 ${m[1]} 已静音 ${minutes} 分钟（只听不说）。#解除静音 ${m[1]} 可提前恢复。`;
      }
      case '解除静音': {
        if (!/^\d{5,16}$/.test(arg)) return '用法：#解除静音 <群号>';
        this.ctx.engine?.guard.unmute(arg);
        return `群 ${arg} 已恢复发言。`;
      }
      case '表情包': {
        const names = this.ctx.stickers?.names(40) || [];
        return names.length ? `机器人学到的表情包（${this.ctx.stickers?.size ?? names.length} 个）：${names.join('、')}\n人设里可写 [表情包: 关键词] 发送。` : '还没有学到表情包：群里有人发过市场表情后会自动记住。';
      }
      case '面板':
      case 'web': {
        const publicUrl=this.ctx.store.config.remotePublicUrl;
        return publicUrl
          ? `【iPhone 固定远程地址】\n${publicUrl}\n设备必须先在 Windows 主窗口扫码配对；QQ 消息不会发送密码、配对秘密或设备令牌。`
          : '尚未配置 Named Tunnel 固定域名。请在 Windows 主窗口的“桌面设置”中完成配置和设备配对。';
      }

      default:
        return `未知的管理指令: #${cmd}。\n发送 #帮助 查看所有支持的指令列表。`;
    }
  }
}
