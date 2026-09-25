const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OneBot, splitReplyMessages, forceSentenceSplit, buildMessageSegments } = require('../dist/onebot');
const { faceIdForName } = require('../dist/config');

test('replies can carry QQ faces built from [表情: 名称] markers', () => {
  const seg = t => buildMessageSegments(t);

  // Name straight from the face table, and an alias the model may prefer.
  assert.deepEqual(seg('[表情: 微笑]'), [{ type: 'face', data: { id: '14' } }]);
  assert.deepEqual(seg('[表情: doge]'), [{ type: 'face', data: { id: '179' } }]);
  assert.deepEqual(seg('[表情: 开心]'), [{ type: 'face', data: { id: '178' } }]);
  assert.deepEqual(seg('[表情: 谢谢]'), [{ type: 'face', data: { id: '118' } }]);
  // A real model typo seen in production is normalized and the descriptive
  // wording resolves to a safe built-in QQ face instead of leaking as text.
  assert.deepEqual(seg('[s表情: 疯狂点头]'), [{ type: 'face', data: { id: '76' } }]);
  assert.deepEqual(seg('[S 表情：点头]'), [{ type: 'face', data: { id: '76' } }]);

  // Text around the marker is preserved in order; full-width colon also works.
  assert.deepEqual(seg('好的 [表情: 微笑]'), [
    { type: 'text', data: { text: '好的 ' } },
    { type: 'face', data: { id: '14' } }
  ]);
  assert.deepEqual(seg('真的吗[表情：疑问]我不信'), [
    { type: 'text', data: { text: '真的吗' } },
    { type: 'face', data: { id: '32' } },
    { type: 'text', data: { text: '我不信' } }
  ]);

  // An unknown name must stay visible as text, never be dropped.
  assert.deepEqual(seg('[表情: 某个不存在的]'), [{ type: 'text', data: { text: '[表情: 某个不存在的]' } }]);
  assert.deepEqual(seg('普通文本'), [{ type: 'text', data: { text: '普通文本' } }]);

  // A marker the inbound side produced round-trips back to the same face.
  assert.equal(faceIdForName('斜眼笑'), '178');
  assert.equal(faceIdForName('[菜狗]'), '317');
  assert.equal(faceIdForName('疯狂点头'), '76');
  assert.equal(faceIdForName('不存在'), null);
});

test('OneBot.send normalizes a stray s face marker alongside the group at tag', async () => {
  const bot = new OneBot(() => {}, () => {}, () => {}, () => {});
  const calls = [];
  bot.call = async (action, params) => { calls.push(params.message); };
  await bot.send({ key: 'k', messageId: 'm', group: '123456', user: '654321', text: 'x' }, '收到啦 [s表情: 疯狂点头]\n这个我知道', 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    { type: 'at', data: { qq: '654321' } },
    { type: 'text', data: { text: ' ' } },
    { type: 'text', data: { text: '收到啦 ' } },
    { type: 'face', data: { id: '76' } }
  ]);
  assert.deepEqual(calls[1], [{ type: 'text', data: { text: '这个我知道' } }]);
});
const { route, defaults } = require('../dist/config');

test('splitReplyMessages splits on newlines and empty lines while preserving code blocks', () => {
  // Empty or whitespace
  assert.deepEqual(splitReplyMessages(''), []);
  assert.deepEqual(splitReplyMessages('   \n\n  '), []);

  // Single line
  assert.deepEqual(splitReplyMessages('普通单行回复'), ['普通单行回复']);

  // Single newline splits into 2 consecutive messages
  assert.deepEqual(splitReplyMessages('第一行\n第二行'), ['第一行', '第二行']);

  // User example: 看不到    \n只能看到文字 with trailing spaces and single newline
  const userCase = '看不到    \n只能看到文字';
  assert.deepEqual(splitReplyMessages(userCase), [
    '看不到',
    '只能看到文字'
  ]);

  // User example 1: two sentences with an empty line
  const ex1 = '看不到，我这边只有字  \n  \n不过不影响，意思大概懂了 哈哈';
  // A space between two Chinese clauses now becomes its own bubble: people press Enter,
  // they do not type a space. See splitOnBareSpace.
  assert.deepEqual(splitReplyMessages(ex1), [
    '看不到，我这边只有字',
    '不过不影响，意思大概懂了',
    '哈哈'
  ]);

  // User example 2: two sentences with an empty line
  const ex2 = '我去 这是真厉害  \n  \n不过你那句感谢谁我咋没看懂';
  assert.deepEqual(splitReplyMessages(ex2), [
    '我去',
    '这是真厉害',
    '不过你那句感谢谁我咋没看懂'
  ]);

  // Mixed multiple empty lines and CRLF
  const ex3 = '第一段\r\n\r\n第二段\n\n\n第三段';
  assert.deepEqual(splitReplyMessages(ex3), [
    '第一段',
    '第二段',
    '第三段'
  ]);

  // Code block with empty lines and newlines inside is not broken
  const exCode = `下面是示例代码：

\`\`\`python
def foo():

    return 42
\`\`\`

请仔细查阅。`;
  const codeParts = splitReplyMessages(exCode);
  assert.equal(codeParts.length, 3);
  assert.equal(codeParts[0], '下面是示例代码：');
  assert.match(codeParts[1], /^```python[\s\S]*def foo\(\):[\s\S]*```$/);
  assert.equal(codeParts[2], '请仔细查阅。');

  // More than 5 lines are capped and merged to prevent flooding
  const longText = '段落1\n段落2\n段落3\n段落4\n段落5\n段落6\n段落7';
  const capped = splitReplyMessages(longText);
  assert.equal(capped.length, 5);
  assert.equal(capped[0], '段落1');
  assert.equal(capped[3], '段落4');
  assert.equal(capped[4], '段落5\n段落6\n段落7');
});

test('forceSentenceSplit is a fallback for single-line replies and never breaks non-prose', () => {
  // The model ignored the newline instruction: cut on sentence-final marks.
  assert.deepEqual(splitReplyMessages('看不到。只能看到文字。图片我这边显示不出来'), [
    '看不到。',
    '只能看到文字。',
    '图片我这边显示不出来'
  ]);
  assert.deepEqual(splitReplyMessages('真的吗？我怎么不知道这件事情呢，你从哪看到的'), [
    '真的吗？',
    '我怎么不知道这件事情呢，你从哪看到的'
  ]);

  // Short replies stay whole: a deliberate one-liner must not be chopped up.
  assert.deepEqual(splitReplyMessages('好的。'), ['好的。']);
  assert.deepEqual(splitReplyMessages('看不到，只能看到文字'), ['看不到，只能看到文字']);
  assert.ok(forceSentenceSplit('嗯。知道了。').length === 1);

  // Punctuation that is not a sentence boundary.
  assert.deepEqual(splitReplyMessages('等等……我再想想这个问题到底怎么回事儿'), ['等等……我再想想这个问题到底怎么回事儿']);
  assert.deepEqual(splitReplyMessages('1. 第一条。2. 第二条。这是一个列表不应该被切开'), ['1. 第一条。2. 第二条。这是一个列表不应该被切开']);
  assert.equal(forceSentenceSplit('版本是 3.14 吧。你确认一下这个数字对不对')[0], '版本是 3.14 吧。');

  // A run of marks is one boundary, not several.
  assert.deepEqual(splitReplyMessages('太好了！！！我们终于把这个问题解决掉了啊'), [
    '太好了！！！',
    '我们终于把这个问题解决掉了啊'
  ]);

  // Closing quotes stay attached to the sentence they end.
  assert.deepEqual(forceSentenceSplit('他说「我不去了」。那我们自己出发吧，别等他了'), [
    '他说「我不去了」。',
    '那我们自己出发吧，别等他了'
  ]);

  // Anti-flood: at most three forced pieces, the remainder is merged.
  const many = splitReplyMessages('第一句。第二句。第三句。第四句。第五句。第六句这里很长很长');
  assert.equal(many.length, 3);
  assert.equal(many[2], '第三句。第四句。第五句。第六句这里很长很长');

  // Code fences disable the fallback entirely.
  const code = splitReplyMessages('运行这个。```js\nfoo()\n```');
  assert.equal(code.length, 1);

  // Real newlines still take priority over the fallback.
  assert.deepEqual(splitReplyMessages('看不到\n只能看到文字'), ['看不到', '只能看到文字']);
});

test('OneBot.send dispatches separate messages for lines and paragraphs', async () => {
  const bot = new OneBot(() => {}, () => {}, () => {}, () => {});
  const calls = [];
  bot.call = async (action, params) => calls.push({ action, params });

  const twoLineReply = '看不到    \n只能看到文字';

  // 1. Group direct message: @ only in the first message bubble
  const groupDirectJob = {
    key: 'k1',
    messageId: 'm1',
    group: '123456',
    user: '654321',
    text: '测试'
  };
  await bot.send(groupDirectJob, twoLineReply, 0);

  assert.equal(calls.length, 2);
  // Bubble 1 has @
  assert.equal(calls[0].action, 'send_group_msg');
  assert.equal(calls[0].params.group_id, '123456');
  assert.equal(calls[0].params.message[0].type, 'at');
  assert.equal(calls[0].params.message[0].data.qq, '654321');
  assert.equal(calls[0].params.message[2].type, 'text');
  assert.equal(calls[0].params.message[2].data.text, '看不到');

  // Bubble 2 has NO @
  assert.equal(calls[1].action, 'send_group_msg');
  assert.equal(calls[1].params.group_id, '123456');
  assert.equal(calls[1].params.message.length, 1);
  assert.equal(calls[1].params.message[0].type, 'text');
  assert.equal(calls[1].params.message[0].data.text, '只能看到文字');

  // 2. Private chat message: 2 messages sent to user_id
  calls.length = 0;
  const privateJob = {
    key: 'k2',
    messageId: 'm2',
    user: '654321',
    text: '你好'
  };
  await bot.send(privateJob, twoLineReply, 0);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'send_private_msg');
  assert.equal(calls[0].params.user_id, '654321');
  assert.equal(calls[0].params.message[0].data.text, '看不到');

  assert.equal(calls[1].action, 'send_private_msg');
  assert.equal(calls[1].params.user_id, '654321');
  assert.equal(calls[1].params.message[0].data.text, '只能看到文字');
});

test('Image OCR and recognition in OneBot and route', async () => {
  const cfg = { ...defaults, friends: ['654321'] };

  // 1. Pure image stays routable; actual media work is deferred until after scope/scheduling.
  const pureImageEv = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 999999,
    user_id: 654321,
    message_id: 101,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'image', data: { file: 'pic.png' } }]
  };
  assert.equal(route(pureImageEv, cfg, '999999').text, '[图片]');

  // 2. Image with OCR text is recognized by route
  const ocrImageEv = {
    ...pureImageEv,
    message_id: 102,
    message: [{ type: 'image', data: { file: 'pic.png', ocrText: '系统维护公告' } }]
  };
  const routedOcr = route(ocrImageEv, cfg, '999999');
  assert.ok(routedOcr);
  assert.equal(routedOcr.text, '[图片文字: 系统维护公告]');

  // 3. Image with user text acknowledges the image
  const imgWithTextEv = {
    ...pureImageEv,
    message_id: 103,
    message: [
      { type: 'image', data: { file: 'pic.png' } },
      { type: 'text', data: { text: '你看这个' } }
    ]
  };
  const routedImgText = route(imgWithTextEv, cfg, '999999');
  assert.ok(routedImgText);
  assert.equal(routedImgText.text, '[图片] 你看这个');

  // 4. The scoped media path resolves the QQ id and sends actual bytes to OCR.
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0o8AAAAASUVORK5CYII=';
  const bot = new OneBot(() => {}, () => {}, () => {}, () => {});
  bot.connected=true; // fake connection; no socket, QQ process or network
  const actions=[];
  bot.call = async (action, params) => {
    actions.push(action);
    if(action==='get_image'){assert.equal(params.file,'test.jpg');return {base64:png};}
    assert.equal(action,'ocr_image');assert.equal(params.image,'base64://'+png);
    return {status:'ok',retcode:0,data:{texts:[{text:'第一行文字'},{text:'第二行文字'}]}};
  };
  const result=await bot.prepareMedia([{kind:'image',file:'test.jpg'}],false,new AbortController().signal);
  assert.deepEqual(actions,['get_image','ocr_image']);assert.equal(result.ocr,1);assert.equal(result.images,0);
  assert.match(result.parts[0].text,/第一行文字 第二行文字/);
});
