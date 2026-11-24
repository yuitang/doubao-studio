/**
 * CDP 调试工具：连接 Electron 远程调试端口，在指定页面执行 JS。
 * 用法：
 *   node scripts/cdp-eval.mjs list
 *   node scripts/cdp-eval.mjs eval <url或标题子串> <js表达式文件路径>
 *   node scripts/cdp-eval.mjs eval-url <url子串> <js表达式>   （直接内联表达式）
 */
import WebSocket from 'ws';
import { readFileSync } from 'fs';

const PORT = 9222;

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.on('open', () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const msgId = ++id;
          pending.set(msgId, { res2, rej2 });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      close() { ws.close(); },
    }));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej2(new Error(JSON.stringify(msg.error)));
        else res2(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list') {
    for (const t of await getTargets()) {
      console.log(`${t.type} | ${t.title.slice(0, 40)} | ${t.url.slice(0, 90)} | ${t.webSocketDebuggerUrl || ''}`);
    }
    return;
  }
  if (cmd === 'eval' || cmd === 'eval-url') {
    const needle = rest[0];
    const exprArg = rest[1];
    const expr = cmd === 'eval'
      ? readFileSync(exprArg, 'utf-8')
      : exprArg;
    const targets = await getTargets();
    const target = targets.find((t) =>
      (cmd === 'eval-url' ? t.url : (t.url + t.title)).includes(needle)
      && (t.type === 'page' || t.type === 'webview')
      && !t.url.startsWith('devtools'));
    if (!target) {
      console.error('TARGET_NOT_FOUND:', needle);
      process.exit(2);
    }
    const cdp = await connect(target.webSocketDebuggerUrl);
    const result = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    cdp.close();
    if (result.exceptionDetails) {
      console.error('EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(result.result.value, null, 2));
    return;
  }
  if (cmd === 'realclick') {
    // 真实鼠标点击：needle 选择器（JS 查询表达式，返回 [x, y]），通过 CDP Input 派发
    const needle = rest[0];
    const coordExpr = rest[1];
    const targets = await getTargets();
    const target = targets.find((t) =>
      t.url.includes(needle) && (t.type === 'page' || t.type === 'webview') && !t.url.startsWith('devtools'));
    if (!target) { console.error('TARGET_NOT_FOUND:', needle); process.exit(2); }
    const cdp = await connect(target.webSocketDebuggerUrl);
    const r = await cdp.send('Runtime.evaluate', {
      expression: coordExpr,
      returnByValue: true,
    });
    if (r.exceptionDetails) { console.error('EXCEPTION:', JSON.stringify(r.exceptionDetails)); process.exit(1); }
    const [x, y] = r.result.value || [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) { console.error('NO_COORDS:', JSON.stringify(r.result.value)); process.exit(1); }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log(`clicked ${x},${y}`);
    cdp.close();
    return;
  }
  if (cmd === 'realdrag') {
    // 真实鼠标拖拽：从 [x1,y1] 按下移动到 [x2,y2] 释放
    const needle = rest[0];
    const [x1, y1, x2, y2] = rest.slice(1).map(Number);
    const targets = await getTargets();
    const target = targets.find((t) =>
      t.url.includes(needle) && (t.type === 'page' || t.type === 'webview') && !t.url.startsWith('devtools'));
    if (!target) { console.error('TARGET_NOT_FOUND:', needle); process.exit(2); }
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x1 + (x2 - x1) * i / steps),
        y: Math.round(y1 + (y2 - y1) * i / steps),
        button: 'left',
      });
      await new Promise((r2) => setTimeout(r2, 30));
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    console.log(`dragged ${x1},${y1} -> ${x2},${y2}`);
    cdp.close();
    return;
  }
  if (cmd === 'screenshot') {
    const needle = rest[0];
    const outPath = rest[1];
    const targets = await getTargets();
    const target = targets.find((t) =>
      t.url.includes(needle) && (t.type === 'page' || t.type === 'webview') && !t.url.startsWith('devtools'));
    if (!target) { console.error('TARGET_NOT_FOUND:', needle); process.exit(2); }
    const cdp = await connect(target.webSocketDebuggerUrl);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 } });
    const { writeFileSync } = await import('fs');
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    console.log('saved', outPath);
    cdp.close();
    return;
  }
  if (cmd === 'setfiles') {
    // 向页面中最后一个 input[type=file] 注入本地文件
    const needle = rest[0];
    const files = rest.slice(1);
    const targets = await getTargets();
    const target = targets.find((t) =>
      t.url.includes(needle) && (t.type === 'page' || t.type === 'webview') && !t.url.startsWith('devtools'));
    if (!target) { console.error('TARGET_NOT_FOUND:', needle); process.exit(2); }
    const cdp = await connect(target.webSocketDebuggerUrl);
    const doc = await cdp.send('DOM.getDocument');
    const q = await cdp.send('DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    });
    if (!q.nodeIds.length) { console.error('NO_FILE_INPUT'); process.exit(1); }
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: q.nodeIds[q.nodeIds.length - 1],
      files,
    });
    console.log(`set ${files.length} files on input #${q.nodeIds.length - 1}`);
    cdp.close();
    return;
  }
  console.error('usage: cdp-eval.mjs list | eval <needle> <file> | eval-url <needle> <expr> | realclick <needle> <coordExpr> | realdrag <needle> x1 y1 x2 y2 | screenshot <needle> <out.png> | setfiles <needle> <path...>');
  process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
