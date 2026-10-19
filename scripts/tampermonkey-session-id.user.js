/* eslint-disable ts/no-unused-vars, unused-imports/no-unused-vars -- 兼容 fs API 签名 / catch 兼容 */
// ==UserScript==
// @name         AI Runner · 会话 ID + 用量估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      1.9.29
// @description  回传会话 ID/用量/AI 回复到工作台；[fragment-guard-v1]
// @match        https://chat.deepseek.com/*
// @match        https://chatglm.cn/*
// @run-at       document-idle
// @grant        none
// @updateURL    http://127.0.0.1:5178/tampermonkey-session-id.user.js
// @downloadURL  http://127.0.0.1:5178/tampermonkey-session-id.user.js
// ==/UserScript==
/**
 * 用户脚本元数据头 + IIFE 开括号 —— 必须是拼接顺序的第一段。
 *
 * [CONSTRAINT] Tampermonkey 只认文件头部的 ==UserScript== 块，前面出现任何非注释内容
 *   都会让脚本不被识别为可用脚本。故本段所有代码都写在元数据**之后**。
 * [CONSTRAINT] @version 的真实值不在本文件：这里是版本占位符，
 *   由 scripts/tampermonkey-version.json 提供、buildUserscript 注入（[userscript-version-inject-v1]）。
 *   理由：版本号是发布元数据而非脚本逻辑；放在构建输入里，构建才能在内容变化时自动递增。
 * [CONSTRAINT] @version 只在此处声明一次：Tampermonkey 靠它判断更新，
 *   内容改了版本号不变会让更新链路静默失效（无任何报错）。
 * [CONSTRAINT] @grant none 是刻意的：脚本只用 postMessage 与 DOM，
 *   不需要任何 GM_ 特权 API，也就不受 Tampermonkey 沙箱 API 变更影响。
 * [CONSTRAINT] IIFE 开括号必须在本段：所有片段拼回后要落在同一个函数作用域内，
 *   跨片段的 const/let 才互相可见。
 */
(function () {
  'use strict'

/**
 * [tampermonkey-ts-rewrite-v1] 油猴脚本 TS 重写版的共享类型。
 * [WHY] 原 .js 片段是 IIFE 内部的物理切分，跨片段共享符号靠「拼回后同作用域」——
 *   TS 无法表达这种语义（加 import/export 就变模块），故本文件只放纯类型声明，
 *   不加 export/import，保持 script 语义；拼回后所有片段都能看到。
 * [CONSTRAINT] 本目录已在 tsconfig.json 的 exclude 中排除：片段无法独立通过 tsc 检查
 *   （引用其它片段的函数、顶层 return 等），类型注解在这里是「文档 + 未来切换脚手架」。
 */

/**
 * 回复内容的稳定指纹（FNV-1a 32bit），用于脚本块 / DONE 标记去重。
 * [WHY] 不用 JSON.stringify 或 length：同长度不同内容的块必须区分，否则流式改写会漏推。
 * [CONSTRAINT] 与 headless-inject.ts 的同名实现必须同值——两通道对同一回复算出不同 hash
 *   会让「已推送」判定分叉，表现为同一条回复被推两次。
 */
function hash32(s) {
    let h = 0x811C9DC5;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x1000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/* @turn-schema:5f70fe35f55c21c0 */
// 由 scripts/sync-turn-schema.mjs 从 packages/core/src/reply/turn-schema.ts 生成，请勿手改。
// @ts-nocheck
// >>> BEGIN turn-schema
// [turn-schema-v1] turn 信封契约的**唯一源**。
//
// 为什么是唯一源：本文件会被 scripts/sync-turn-schema.mjs 复制成三份产物
// （无头内联段 / 油猴片段 / 前端副本），三份头部各带 `/* @turn-schema:<hash> */`，
// 由 reply-turn-fingerprint 守卫重算源哈希比对 —— 「三处同一份源码」是判据，不是承诺。
//
// [CONSTRAINT] 本文件必须保持「纯 JS 可执行」：
//   · 不写 TS 注解（生成器直接复制，不做类型擦除）
//   · 不 import 任何模块（无头侧 page.evaluate 不能加载模块）
//   · 不用 Date / Math.random（解析必须幂等，同输入同输出）
//   · 不读全局状态（不得依赖 window / document / process）
//
// 契约形状（v1）：
//   { "v": 1, "turn": 7, "content": [ {type:'say'|'script'|'ask'|'handoff', ...} ] }
// 派生语义（不由本文件决定，由调用方按块列表推导）：
//   有 ask 块 ⇒ 停循环等用户；有 script 块 ⇒ 执行后回灌；无执行块 ⇒ 本 turn 即总结；
//   有 handoff 块 ⇒ 轮转会话。
// [CONSTRAINT] 首版**不含 lane**：schema 只声明已实现的能力，不支持的东西必须报错而非静默丢弃。
/** 契约版本（写进 `v` 字段；缺省按 1 处理） */
const TURN_SCHEMA_VERSION = 1;
/** 已实现的块类型（注册表）。新增工具类型 = 往这里加一项 + 在 validateBlock 加一个分支 */
const TURN_BLOCK_TYPES = ['say', 'script', 'ask', 'handoff'];
/** script 块可接受的 lang（白名单，不做别名归一：别名会让「写错」变成「猜对了」） */
const TURN_SCRIPT_LANGS = ['js', 'cjs'];
/**
 * 找出所有候选 JSON 起点（每个 ```json 围栏内的第一个 `{`，以及整段以 `{` 开头的情形）。
 * [WHY] 不能用 ```…``` 正则截体：script.code 里一旦出现反引号围栏（脚本要输出 Markdown 时很常见），
 *   正则会提前闭合，把整条回复打成噪音卡。这里只定位起点，终点交给配平扫描。
 * @param text 原文
 * @returns 起点下标数组（升序）
 */
function findCandidates(text) {
    const out = [];
    const re = /```[ \t]*json[ \t]*\r?\n[ \t]*\{/gi;
    let m = re.exec(text);
    while (m) {
        out.push(m.index + m[0].length - 1);
        m = re.exec(text);
    }
    const trimmed = text.trim();
    if (trimmed.charAt(0) === '{') {
        const at = text.indexOf('{');
        if (!out.includes(at))
            out.push(at);
    }
    return out;
}
/**
 * 从 from 处的 `{` 起做**字符串感知**的花括号配平，返回对象结束后的下标（开区间）。
 * [CONSTRAINT] 必须跳过字符串内部的括号与 `\"` 转义，否则 `{"code":"} "}` 会提前闭合。
 * @param text 原文
 * @param from 起点（必为 `{`）
 * @returns 结束下标；未闭合返回 -1
 */
function scanObjectEnd(text, from) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = from; i < text.length; i++) {
        const ch = text.charAt(i);
        if (inStr) {
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === '\\') {
                esc = true;
                continue;
            }
            if (ch === '"')
                inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0)
                return i + 1;
        }
    }
    return -1;
}
/**
 * 在 content 数组内部逐个切出**已配平**的元素对象（流式安全的增量解析基础）。
 * [WHY] 整段信封闭合要等模型写完最后一笔；而脚本块一配平就该能开跑（等价 API 的
 *   content_block_start）。本函数只切元素，不做校验，校验交给 validateBlock。
 * @param text 原文
 * @returns 元素原文数组（可能不完整，末尾元素可能缺失）
 */
function sliceContentElements(text) {
    const out = [];
    const at = text.search(/"content"\s*:\s*\[/);
    if (at < 0)
        return out;
    let i = text.indexOf('[', at);
    if (i < 0)
        return out;
    i += 1;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    for (; i < text.length; i++) {
        const ch = text.charAt(i);
        if (inStr) {
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === '\\') {
                esc = true;
                continue;
            }
            if (ch === '"')
                inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === '{') {
            if (depth === 0)
                start = i;
            depth += 1;
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                out.push(text.slice(start, i + 1));
                start = -1;
            }
            continue;
        }
        if (ch === ']' && depth === 0)
            break;
    }
    return out;
}
/**
 * 校验并归一化单个块。
 * [CONSTRAINT] 返回 `{ block, errors }`：block 为 null 表示该块不可用（errors 非空）。
 *   字段一律「有就收窄、没有就补默认值或报错」，绝不抛异常。
 * @param raw 原始元素
 * @param index 在 content 中的下标（用于错误定位）
 */
function validateBlock(raw, index) {
    const errors = [];
    const at = `#${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ code: 'BLOCK_UNKNOWN_TYPE', block: at, field: 'type', detail: '块不是对象' });
        return { block: null, errors };
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
    if (!TURN_BLOCK_TYPES.includes(type)) {
        errors.push({ code: 'BLOCK_UNKNOWN_TYPE', block: at, field: 'type', detail: type || '（缺失）' });
        return { block: null, errors };
    }
    const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (type === 'say') {
        const text = typeof raw.text === 'string' ? raw.text : '';
        if (!text.trim())
            errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'text' });
        return { block: { type: 'say', id: rawId || (`say_${index + 1}`), text }, errors };
    }
    if (type === 'handoff') {
        const summary = typeof raw.summary === 'string' ? raw.summary : (typeof raw.text === 'string' ? raw.text : '');
        if (!summary.trim())
            errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'summary' });
        return { block: { type: 'handoff', id: rawId || (`handoff_${index + 1}`), summary }, errors };
    }
    if (type === 'ask') {
        const question = typeof raw.question === 'string' ? raw.question : '';
        if (!rawId)
            errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' });
        if (!question.trim())
            errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'question' });
        const rawOptions = Array.isArray(raw.options) ? raw.options : [];
        const options = [];
        for (let i = 0; i < rawOptions.length; i++) {
            const o = rawOptions[i];
            const label = o && typeof o === 'object' && typeof o.label === 'string' ? o.label : '';
            if (!label.trim())
                continue;
            const oid = o && typeof o.id === 'string' && o.id ? o.id : (`opt_${options.length + 1}`);
            options.push({ id: oid, label });
        }
        return { block: { type: 'ask', id: rawId || (`ask_${index + 1}`), question, options }, errors };
    }
    // type === 'script'
    const lang = typeof raw.lang === 'string' ? raw.lang.trim().toLowerCase() : '';
    const desc = typeof raw.desc === 'string' ? raw.desc : '';
    const why = typeof raw.why === 'string' ? raw.why : '';
    const code = typeof raw.code === 'string' ? raw.code : '';
    if (!rawId)
        errors.push({ code: 'BLOCK_MISSING_FIELD', block: at, field: 'id' });
    if (!lang)
        errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'lang' });
    else if (!TURN_SCRIPT_LANGS.includes(lang))
        errors.push({ code: 'BLOCK_BAD_LANG', block: rawId || at, field: 'lang', detail: lang });
    if (!desc.trim())
        errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'desc' });
    if (!why.trim())
        errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'why' });
    if (!code.trim())
        errors.push({ code: 'BLOCK_MISSING_FIELD', block: rawId || at, field: 'code' });
    return {
        block: { type: 'script', id: rawId, lang, desc, why, code },
        errors,
    };
}
/**
 * 把已校验的块并入结果集，处理同 id 复用。
 * [D8] 未执行的块可以覆盖、已执行的块只能上报 —— 解析层无法知道执行状态，因此这里统一
 *   「后到覆盖先到」并把冲突记进 errors；是否重跑由执行器的 (turn,id) 账本决定。
 * @param acc 累积结果 { blocks, errors }
 * @param block 校验通过的块
 */
function mergeBlock(acc, block) {
    if (!block || !block.id) {
        acc.blocks.push(block);
        return;
    }
    const idx = acc.blocks.findIndex((it) => { return it && it.id === block.id; });
    if (idx < 0) {
        acc.blocks.push(block);
        return;
    }
    const prev = acc.blocks[idx];
    if (JSON.stringify(prev) === JSON.stringify(block))
        return;
    acc.blocks[idx] = block;
    acc.errors.push({ code: 'BLOCK_DUP_ID', block: block.id, field: 'id', detail: 'superseded' });
}
/**
 * 把 JSON **字符串字面量内部**的裸控制字符改写成合法转义，再交给 JSON.parse。
 *
 * [WHY] 模型写 script.code 时经常图省事，直接在 `"code": "..."` 里敲**真换行**（U+000A）
 *   而不是两字符的 `\n`。这不是排版问题而是转义问题：`JSON.parse` 对字符串字面量里的
 *   裸控制字符直接抛 `Bad control character in string literal`，整条信封解析不出对象
 *   ⇒ 油猴回落 plain 把 JSON 原文整坨推上屏、script 块零执行（用户实测 2026-10-19，
 *   对照组：同结构的单行/合法转义信封一切正常）。
 *   所以「能跑的」和「不能跑的」两份信封差异**不在块结构，只在 code 里换行的形态**。
 *
 * [CONSTRAINT] 必须字符串感知：只改字符串内部的控制字符，且跳过 `\"` 已消费的位置。
 *   否则代码里的引号会被误判成字符串边界，把结构字符（`{` `}` `,`）也转义掉，
 *   修好一个坏两个。
 * [CONSTRAINT] 只在 JSON.parse 已经失败时兜底调用（见 safeJsonParse），正常信封零开销、
 *   且严格 JSON 的行为完全不变（严格解析成功时压根不进这里）。
 * [CONSTRAINT] 幂等：已转义文本再过一次不产生变化（`\` 已消费 ⇒ 下一个字符不处理）。
 * @param text 待解析的 JSON 文本
 * @returns 修正后的 JSON 文本
 */
function escapeControlCharsInStrings(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (inStr) {
            if (esc) {
                out += ch;
                esc = false;
                continue;
            }
            if (ch === '\\') {
                out += ch;
                esc = true;
                continue;
            }
            if (ch === '"') {
                inStr = false;
                out += ch;
                continue;
            }
            const code = text.charCodeAt(i);
            // JSON 规范：字符串字面量内只允许码位 ≥ 0x20，其余必须转义
            if (code < 0x20) {
                if (ch === '\n')
                    out += '\\n';
                else if (ch === '\r')
                    out += '\\r';
                else if (ch === '\t')
                    out += '\\t';
                else if (ch === '\b')
                    out += '\\b';
                else if (ch === '\f')
                    out += '\\f';
                else
                    out += `\\u${code.toString(16).padStart(4, '0')}`;
                continue;
            }
            out += ch;
            continue;
        }
        if (ch === '"')
            inStr = true;
        out += ch;
    }
    return out;
}
/**
 * JSON.parse 的宽容包装：严格解析失败时，转义字符串内的裸控制字符再试一次。
 *
 * [WHY] 不直接无条件转义：严格 JSON 是契约基线，先严格试能保证「本来就能解析的输入
 *   走的是零改写的原路径」，宽容只作为**救 malformed 输出**的兜底，不放宽块结构校验
 *   （字段缺失 / 未知类型仍然照常报错，不会因为宽容而静默通过）。
 * @param text JSON 文本
 * @returns 解析结果；两次都失败抛错（由调用方按既有 try/catch 处理）
 */
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return JSON.parse(escapeControlCharsInStrings(text));
    }
}
/**
 * 解析一条完整的 turn 信封。
 * @param md 回复原文（Markdown 或裸 JSON 均可）
 * @returns {turn, blocks, truncated, errors}；解析不出对象时 errors 含
 *   TURN_TRUNCATED（未配平＝还在流式写入）或 TURN_NOT_JSON（配平了但不是对象）
 */
function parseTurn(md) {
    const text = String(md ?? '');
    const out = { turn: null, blocks: [], truncated: false, errors: [] };
    if (!text) {
        out.errors.push({ code: 'TURN_NOT_JSON', detail: '空输入' });
        return out;
    }
    const cands = findCandidates(text);
    if (!cands.length) {
        out.errors.push({ code: 'TURN_NOT_JSON', detail: '无 json 围栏且不以 { 开头' });
        return out;
    }
    let obj = null;
    for (let i = cands.length - 1; i >= 0; i--) {
        const end = scanObjectEnd(text, cands[i]);
        if (end < 0) {
            out.truncated = true;
            continue;
        }
        let parsed = null;
        try {
            parsed = safeJsonParse(text.slice(cands[i], end));
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            continue;
        obj = parsed;
        break;
    }
    if (!obj) {
        // [CONSTRAINT] 两种「没解析出对象」必须区分开，否则模型拿到的修法是错的：
        //   · 围栏已开但对象还没配平 ⇒ 还在流式写入（TURN_TRUNCATED），等下一拍即可；
        //   · 围栏配平了但里面不是对象 ⇒ 真的写错了（TURN_NOT_JSON），必须改写。
        out.errors.push(out.truncated
            ? { code: 'TURN_TRUNCATED', detail: '围栏已开但对象未配平（流式未写完）' }
            : { code: 'TURN_NOT_JSON', detail: '围栏内不是可解析的对象' });
        return out;
    }
    if (typeof obj.turn === 'number')
        out.turn = obj.turn;
    const content = Array.isArray(obj.content) ? obj.content : null;
    if (!content || content.length === 0) {
        out.errors.push({ code: 'TURN_NO_CONTENT', detail: '缺 content 或为空数组' });
        return out;
    }
    for (let i = 0; i < content.length; i++) {
        const r = validateBlock(content[i], i);
        for (let k = 0; k < r.errors.length; k++)
            out.errors.push(r.errors[k]);
        if (r.block)
            mergeBlock(out, r.block);
    }
    return out;
}
/**
 * 增量解析：只返回**已配平**的 content 元素，不等整信封闭合。
 * [WHY] 流式下脚本块写完就该能开跑；等整段闭合会把多块 turn 的延迟叠加成 N 倍。
 * [CONSTRAINT] 不返回 truncated 判断 —— 是否「真的截断」由调用方的静默窗决定，
 *   解析层只负责「现在能确定什么」。
 * @param md 回复原文
 * @returns {turn, blocks, errors}：只含**已配平**元素的解析结果，未闭合部分不出块
 */
function parseTurnPartial(md) {
    const text = String(md ?? '');
    const out = { turn: null, blocks: [], errors: [] };
    const turnMatch = text.match(/"turn"\s*:\s*(\d+)/);
    if (turnMatch)
        out.turn = Number(turnMatch[1]);
    const elems = sliceContentElements(text);
    for (let i = 0; i < elems.length; i++) {
        let parsed = null;
        try {
            parsed = safeJsonParse(elems[i]);
        }
        catch {
            continue;
        }
        const r = validateBlock(parsed, i);
        for (let k = 0; k < r.errors.length; k++)
            out.errors.push(r.errors[k]);
        if (r.block)
            mergeBlock(out, r.block);
    }
    return out;
}
// <<< END turn-schema

/**
 * 语言判定四级回退：className → DOM 邻近探测 → 内容特征 → 脚本头契约。
 * [WHY] 各站点代码块的标注方式不一致（有的只在 <code class> 上、有的只在头部按钮上、
 *   有的干脆不标），单一判据必然漏判；漏判的后果是脚本降级成 plain 文本，
 *   表现为「页面上渲染了但没执行」。
 * [CONSTRAINT] 白名单恒为 js / bash（脚本头契约兜底为 js）；不认识的标签返回 null，
 *   由调用方跳过——把 python/json 当 js 交给 node 必然语法错。
 */
/** 头部标签文本 → 语言；只认短标签，长句是正文不是标签 */
function langFromText(s) {
    const t = String(s || '').trim().toLowerCase();
    if (!t || t.length > 24)
        return null;
    if (/^(?:bash|sh|shell|zsh)\b/.test(t))
        return 'bash';
    if (/^(?:js|javascript|cjs|commonjs|node|nodejs)\b/.test(t))
        return 'js';
    return null;
}
/**
 * 从 <code class="language-xxx"> 直接判语言。
 * [WHY] 代码块头的语言标签/复制按钮不进 <code>，取 className 比邻近 DOM 探测更可靠。
 */
function guessLangFromClass(el) {
    if (!el || !el.className)
        return null;
    const m = String(el.className).match(/(?:language|lang)-([a-z0-9+#-]+)/i);
    if (!m)
        return null;
    const raw = m[1].toLowerCase();
    if (raw === 'bash' || raw === 'sh' || raw === 'shell' || raw === 'zsh')
        return 'bash';
    if (raw === 'js' || raw === 'javascript' || raw === 'node' || raw === 'mjs' || raw === 'cjs')
        return 'js';
    return null;
}
/** 向前找最多 3 个兄弟节点里的标签文本，再看包裹容器的头部元素 */
function guessLangFromDom(pre) {
    let sib = pre.previousElementSibling;
    for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
        const r = langFromText(sib.textContent);
        if (r)
            return r;
    }
    const wrap = pre.closest('[class*="code"], [class*="md"], [class*="markdown"], [class*="block"]');
    if (wrap) {
        const cands = wrap.querySelectorAll('[class*="lang"], [class*="header"], [class*="title"], [class*="label"]');
        for (const c of cands) {
            const r = langFromText(c.textContent);
            if (r)
                return r;
        }
    }
    return null;
}
/**
 * 按内容特征猜语言。
 * [WHY] 站点输出常直接 `fs.readdirSync(...)` / `const x = ...`，无 require/module.exports，
 *   三级判定全 null ⇒ 整块被跳过降级为 plain 文本。
 * [CONSTRAINT] 只加高置信特征，避免把普通 Markdown 代码块（如纯 JSON 配置）误判为 js。
 */
function guessLangFromContent(text) {
    const head = text.slice(0, 300);
    if (/^#!\s*\/usr\/bin\/env\s+bash/.test(head) || /^#!\s*\/bin\/bash/.test(head))
        return 'bash';
    if (/^#!\s*\/usr\/bin\/env\s+node/.test(head))
        return 'js';
    if (/\brequire\s*\(/.test(head))
        return 'js';
    if (/\bmodule\.exports\b/.test(head))
        return 'js';
    if (/\bprocess\.(?:exit|argv|env)\b/.test(head))
        return 'js';
    if (/\bfs\.(?:readFileSync|writeFileSync|readdirSync|existsSync|statSync|mkdirSync|unlinkSync)\b/.test(head))
        return 'js';
    if (/\bconsole\.log\s*\(/.test(head))
        return 'js';
    if (/\bJSON\.(?:parse|stringify)\s*\(/.test(head))
        return 'js';
    if (/^(?:const|let)\s+\w+\s*=/.test(head))
        return 'js';
    if (/^(?:echo|cd\s|ls\s|mkdir|git\s|pnpm\s|npm\s|yarn\s|rm\s)/m.test(head))
        return 'bash';
    if (/\bif\s+\[\s/.test(head) || /\bfi\b/.test(head) || /\$\(/.test(head))
        return 'bash';
    return null;
}
/**
 * 取代码块的纯文本，剔除语法高亮行号。
 * [WHY] 部分站点每行前有 <span class="linenumber">N</span>，textContent 会把行号粘进代码，
 *   `#! /usr/bin/env node` 变成 `1#! /usr/bin/env node` ⇒ shebang / ^const 正则全失配。
 * [CONSTRAINT] 克隆节点再删，不动真实 DOM——站点的复制按钮绑定原节点。
 */
function codeTextOf(codeEl) {
    const clone = codeEl.cloneNode(true);
    clone.querySelectorAll('.linenumber, .react-syntax-highlighter-line-number, [class*="line-number"]').forEach(n => n.remove());
    return (clone.textContent || '').replace(/^\n+|\n+$/g, '');
}

/**
 * DOM → Markdown 反推。
 * [WHY] 站点把回复渲染成 <h3>/<p>/<ul>/<pre>，直接取 textContent 会把块级元素粘成一行：
 *   标记行（SCRIPT/DONE…）与正文粘连 ⇒ 首行判据失效；列表层级丢失 ⇒ 总结不可读。
 * [CONSTRAINT] 只覆盖常用标签；未知标签递归取子节点文本兜底。
 *   本函数与 headless-inject.ts 的同名实现必须语义一致——两通道对同一回复反推出不同文本
 *   会让「是否已推过」与「首行是什么标记」的判定分叉。
 */
function elToMd(node) {
    if (!node)
        return '';
    if (node.nodeType === 3)
        return node.textContent || '';
    if (node.nodeType !== 1)
        return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    const inner = () => Array.from(el.childNodes).map(c => elToMd(c)).join('');
    if (tag === 'br')
        return '\n';
    if (tag === 'hr')
        return '\n---\n\n';
    if (/^h[1-6]$/.test(tag))
        return `${'#'.repeat(Number(tag.charAt(1)))} ${inner().trim()}\n\n`;
    if (tag === 'p')
        return `${inner().trim()}\n\n`;
    if (tag === 'ul' || tag === 'ol') {
        const out = [];
        let i = 1;
        for (const c of Array.from(el.children)) {
            if (c.tagName.toLowerCase() !== 'li')
                continue;
            out.push((tag === 'ul' ? '- ' : `${i++}. `) + elToMd(c).trim());
        }
        return `${out.join('\n')}\n\n`;
    }
    if (tag === 'pre') {
        const code = el.querySelector('code');
        const cls = code ? String(code.className || '') : '';
        const m = cls.match(/language-([a-z0-9]+)/i);
        // 用 codeTextOf 剔行号，与 extractLatestScript 的取值口径保持一致
        const src = codeTextOf(code || el);
        return `\`\`\`${m ? m[1] : ''}\n${src}\n\`\`\`\n\n`;
    }
    if (tag === 'code')
        return `\`${el.textContent || ''}\``;
    if (tag === 'blockquote')
        return `${inner().split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
    if (tag === 'table') {
        const rows = [];
        for (const tr of Array.from(el.querySelectorAll('tr'))) {
            rows.push(`| ${Array.from(tr.children).map(c => elToMd(c).trim()).join(' | ')} |`);
        }
        return `${rows.join('\n')}\n\n`;
    }
    return inner();
}
/**
 * 取某个回复容器的完整 Markdown。
 * [CONSTRAINT] 允许传 Document（取 body），供「容器缺失但确需整页」的调用方使用；
 *   正常路径一律传 latestAssistantRoot() —— 整页反推会把侧栏标题与用户消息拼进来。
 */
function extractReplyMd(root) {
    if (!root)
        return '';
    const node = root.nodeType === 9 ? root.body : root;
    if (!node)
        return '';
    return elToMd(node).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 回复标记扫描：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT` 共用「首个非空行 = 独占标记行」判据。
 * [WHY] 早期各链路对「DONE」的形态理解不一致（有的要求首行严格等于，有的任意位置命中），
 *   同一条回复在不同通道被分到不同类别，甚至整轮丢失。统一后只认首行。
 * [CONSTRAINT] 正文里写「DONE 之后…」不会命中——这是有意为之，避免 AI 在解释时自触发。
 *   与 headless-inject.ts、packages/client/utils/reply-mark.ts 逐句同构，
 *   由 reply-mark-parity 守卫三处对拍；改一处必须同步三处。
 */
function scanReplyMarks(md) {
    const out = { script: -1, ask: -1, done: -1, handoff: -1, text: -1 };
    const lines = String(md || '').split(/\r?\n/);
    let head = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().length > 0) {
            head = i;
            break;
        }
    }
    if (head < 0)
        return out;
    const line = lines[head].trim();
    if (/^SCRIPT$/.test(line))
        out.script = head + 1;
    else if (/^ASK$/.test(line))
        out.ask = head + 1;
    else if (/^DONE$/.test(line))
        out.done = head + 1;
    else if (/^HANDOFF$/.test(line))
        out.handoff = head + 1;
    else if (/^TEXT$/.test(line))
        out.text = head + 1;
    return out;
}

/**
 * AI 回复容器定位与身份指纹。
 * [WHY] 早期实现硬编码 DeepSeek 的 .ds-assistant-message-main-content；
 *   其它站点取不到 ⇒ 退回整页 document，而整页末 300 字符是输入框/页脚，
 *   AI 流式期间恒定 ⇒ 签名不变 ⇒ 永不回传。改为按特异性递减的候选链。
 * [CONSTRAINT] 顺序即优先级：命中即取最后一个（最新一条回复）。
 *   全不命中返回 null，由调用方决定兜底策略（不得在此偷偷退回 document）。
 */
const ASSISTANT_ROOT_SELECTORS = [
    '.ds-assistant-message-main-content', // DeepSeek
    '[data-message-author-role="assistant"]', // ChatGPT
    '.chat-answers-card-wrap', // 千问 / 通义
    // [chatglm-adapter-v2] 智谱清言：保留原值 + answer-content 类名前缀变体 + answer-body 变体。
    //   原 .conversation-item .answer-content 未实测，实测症状「能发不能回」即该选择器 miss
    //   → 容器为 null → 签名退化为全页末 300 字符（恒定）→ 永不 post。
    // [CONSTRAINT] 必须排在末位（顺序即优先级）。
    '.conversation-item .answer-content, [class*="answer-content"], [class*="answer-body"]',
];
/** 最后一条 AI 回复容器；无回复时返回 null（新会话首轮思考阶段属于这种情况） */
function latestAssistantRoot() {
    for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
        const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i]);
        if (els.length > 0)
            return els[els.length - 1];
    }
    return null;
}
/** 当前 AI 回复块数量（按首个命中的候选选择器计）；选择器不可用时退化为 0，不启用依赖计数的兜底 */
function countAssistantRoots() {
    try {
        for (let i = 0; i < ASSISTANT_ROOT_SELECTORS.length; i++) {
            const els = document.querySelectorAll(ASSISTANT_ROOT_SELECTORS[i]);
            if (els.length > 0)
                return els.length;
        }
    }
    catch { /* 选择器不支持/文档未就绪：按 0 处理，不启用兜底 */ }
    return 0;
}
/**
 * 最后一个 AI 回复根的身份指纹（文本长度 + 首 64 字符）。
 * [WHY] 单看根计数分不清三种「计数不变」：① 本轮没产出任何回复块（真停止）；
 *   ② regenerate 原地替换（旧根删、新根添）；③ 虚拟列表回收旧根同时挂新根。
 *   ②③ 的最后根身份必然变化，只有①原样不动——补上身份后「冻结」才等价于「没产出」。
 */
function assistantRootId() {
    try {
        const r = latestAssistantRoot();
        if (!r)
            return '';
        const t = String(r.textContent || '');
        return `${t.length}:${t.slice(0, 64)}`;
    }
    catch { /* 取身份失败：返回空串，与 enterRootId='' 相等时不启用身份判据 */
        return '';
    }
}
/**
 * 根冻结判据：进入生成时的计数与最后根身份均未变。
 * [CONSTRAINT] enterCount>0 门槛必须保留：首轮无根时不予判定
 *   （无根站点的思考期停止不可判，宁可不报也不误报）。
 * [CHANGE-IMPACT] 收紧只会让 stopped 更少推（更保守），不会新增误推。
 */
function rootsFrozenNow(enterCount, enterRootId, nowCount, nowRootId) {
    return enterCount > 0 && nowCount === enterCount && nowRootId === enterRootId;
}

/**
 * 会话身份：从 URL 取会话 ID、从 hash 取 sid、并在变化时上报工作台。
 * [WHY] 工作台靠 (id, sessionId) 定位当前对话；上报时机错过一次，
 *   后续所有回传都会被归到旧会话，表现为「AI 明明回复了但工作台看不到」。
 * [CONSTRAINT] 规则顺序即优先级：越具体的路径模板越靠前，
 *   通用兜底（如 qianwen.aliyun.com 的长 ID 抓取）放末尾。
 */
/** 站点会话 URL 规则：正则 + 捕获组序号（1-based） */
const RULES = [
    { re: /chat\.deepseek\.com\/a\/chat\/s\/([\w-]+)/, n: 1 },
    { re: /chatgpt\.com\/c\/([\w-]+)/, n: 1 },
    { re: /chat\.openai\.com\/c\/([\w-]+)/, n: 1 },
    { re: /claude\.ai\/chat\/([\w-]+)/, n: 1 },
    { re: /kimi\.moonshot\.cn\/chat\/([\w-]+)/, n: 1 },
    { re: /gemini\.google\.com\/app\/([\w-]+)/, n: 1 },
    { re: /tongyi\.aliyun\.com\/qianwen\/([\w-]+)/, n: 1 },
    { re: /qianwen\.aliyun\.com\/[\w-]*\/?([\w-]{20,})/, n: 1 },
    // [qianwen-web-v1] 千问网页版主域名已切至 qianwen.com，会话形如 /chat|/c|/q/{id}；
    //   域名锚定避免误匹配其它站点；顺序置末尾保留既有优先级。
    { re: /(?:www\.)?qianwen\.com\/(?:chat|c|q)\/([\w-]+)/, n: 1 },
    // [chatglm-adapter-v1] 智谱清言会话 URL：/main/detail/{id}
    { re: /chatglm\.cn\/main\/detail\/([\w-]+)/, n: 1 },
];
let lastId = '';
let lastSid = '';
/**
 * 本实例是否已报告过「启动」。
 * [WHY] 仅首次 send() 携带 boot:true，供客户端识别 AI 窗口刚加载（新上下文）；
 *   F5 后新实例会重新置 false，站点内切会话触发的后续 send() 不带该标记。
 */
let _bootSent = false;
/** 从 URL hash 取 sid（形如 #sid=xxx 或 &sid=xxx） */
function extractSidFromHash() {
    const m = location.hash.match(/(?:^#|&)sid=([\w.-]+)/);
    return m ? m[1] : '';
}
/** 按 RULES 顺序从当前 URL 提取会话 ID；全不命中返回空串（不是错误状态） */
function extractId() {
    const href = location.href;
    for (let i = 0; i < RULES.length; i++) {
        const m = href.match(RULES[i].re);
        if (m)
            return decodeURIComponent(m[RULES[i].n]);
    }
    return '';
}
/**
 * 会话身份变化时上报。
 * [CONSTRAINT] boot 标记必须在「判断是否变化」之后、发送之前置位，
 *   否则 opener 未建立时会被后续 send() 反复判为「首发」。
 */
function send() {
    const id = extractId();
    const sid = extractSidFromHash();
    let changed = false;
    if (id && id !== lastId) {
        lastId = id;
        changed = true;
    }
    if (sid !== lastSid) {
        lastSid = sid;
        changed = true;
    }
    if (!changed)
        return;
    const _isBoot = !_bootSent;
    _bootSent = true;
    try {
        if (window.opener && !window.opener.closed) {
            post({ type: 'ai-runner:session-id', id, sessionId: extractSidFromHash(), boot: _isBoot });
        }
    }
    catch { /* opener 受限：本条已入断链队列，恢复后补发 */ }
}

/**
 * 正文剥壳扫描与「会话触顶」探针。
 * [WHY] 工作台会把脚本 stdout 用围栏回填进会话，页面里落成 <pre><code>；
 *   而源码/文档里含探针自己的词表 ⇒ 整页 textContent 会自指命中，
 *   误报「已达长度上限」并掐掉一整轮（实测：剥壳后命中数 1 → 0）。
 * [CONSTRAINT] 只有「标记类」探针走剥壳文本；
 *   篇幅/增长类判据（bodySignature / stillStreamingReply）必须读整页 raw ——
 *   代码块属于回复正文，剥掉会让「正文是否仍在增长」失真。
 */
let _scanRaw = null;
let _scanText = '';
/**
 * 剥掉代码块、输入框与可编辑区后的正文文本。
 * [CONSTRAINT] 实现体与 headless-inject.ts / headless-fill.ts 两处同构
 *   （守卫测试 limit-marker-guard 的 body-text parity 用例对拍）。
 */
function bodyText() {
    const b = document.body;
    if (!b)
        return '';
    const c = b.cloneNode(true);
    const kill = c.querySelectorAll('pre,code,textarea,input,[contenteditable="true"],script,style');
    for (let i = 0; i < kill.length; i++)
        kill[i].remove();
    return c.textContent || '';
}
/**
 * 共享的剥壳快照。
 * [WHY] classifyAndPost 每 350ms 一跑，每次 clone 整页代价过高；
 *   先用整页 raw 做字符串比较（零额外节点分配），仅在 raw 变化时剥壳一次。
 */
function scanBodyText() {
    const t = (document.body && document.body.textContent) || '';
    if (t === _scanRaw)
        return _scanText;
    _scanRaw = t;
    _scanText = bodyText();
    return _scanText;
}
/**
 * 会话长度上限标记计数。
 * [CONSTRAINT] 正则必须覆盖两种语序：「达到对话长度上限」（动词在前，DeepSeek 实际文案）
 *   与「对话长度已达上限」（名词在前）；且「上限」后必须自带动作子句，
 *   否则正文自指 + 侧栏常驻「开启新对话」按钮的拼接会造成假命中。
 * [CONSTRAINT] 英文分支必须邻近 token 数：裸 matching `maximum context length` 会被
 *   回填进会话的源码行自指命中。三处（本文件 / headless-inject / headless-fill）
 *   必须严格同构，守卫测试 limit-marker-guard 对拍。
 */
function countLimitMarkers() {
    try {
        const m = scanBodyText().match(/(?:(?:达到|已达|超出|超过)\s*(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\s*(?:已达|已达到|达到|超出|超过)\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\s*(?:上限|最大长度|过长))(?:[，,：:]\s*请?|请)(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length (?:is|of)\s*\d+|maximum context length\s+\d+\s*tokens/gi) || [];
        if (m.length)
            limitMarkerText = m[m.length - 1];
        return m.length;
    }
    catch {
        return 0;
    }
}
/**
 * 以当前存量为新一轮基线。
 * [WHY] 存量触顶标记（会话早就满了）不应被当成「本轮新增」而立刻触发轮转；
 *   基线只对「本轮增量」负责。
 */
function syncLimitMarkerBaseline() {
    limitMarkerBaseline = countLimitMarkers();
    assistantRootBaseline = countAssistantRoots();
}

/**
 * 跨 poll 的模块级状态 —— 去重集合、生成期追踪、触顶/停止旗标。
 * [WHY] 这些变量是「同一轮内多次 classifyAndPost 之间」的记忆：去重靠集合，
 *   中断判定靠「上一轮是否在生成」，触顶靠「本轮是否已报过」。
 *   它们一旦被提前清空，症状都是「同一条内容被推两次」或「半截回复被补发」。
 * [CONSTRAINT] 所有**随轮次失效**的状态必须集中在 resetRoundState() 里，
 *   不得散落到 fill / rotate 各自的分支——实测过漏抄一项就静默漏配。
 */
/** 已推送过的脚本块指纹；避免同内容重复执行 */
const seenHashes = new Set();
/** 已推送过的 DONE 标记指纹（hash of 前 200 字） */
const seenDoneMarkers = new Set();
/** 上一次推送时的正文签名；plain 分支据此判断「正文是否真的变了」 */
let lastBodySig = '';
/** DONE 的 2 帧稳定门：首帧记下签名并返回，次帧相同才推送 */
let _pendingDoneSig = null;
/** SCRIPT 标记存在但载荷不是合法代码块时，本轮只报一次错 */
let _scriptFenceReported = false;
/**
 * stopped 分支的回传文案。
 * [CONSTRAINT] 必须分段拼接：整句字面量会成为探针源码的自命中
 *   （本文件会被工作台 dump 进会话，停机态文案与 UI 文案同形）。
 */
const STOPPED_GENERIC = 'AI 网页' + '已停止' + '生成';
/** 本轮是否已推过 stopped；置位后 script / plain 分支都不再补发残留内容 */
let stopPosted = false;
/** 上一轮 classifyAndPost 看到的生成态；「从有到无」是中断判据的一半 */
let prevGenerating = false;
/** 进入生成时的根数量与最后根身份；与当前值比对判定「没产出任何回复块」 */
let genEnterRoots = 0;
let genEnterRootId = '';
/** 本轮是否已推过 limit；只压「存量兜底」通道，增长通道自限不 gate */
let limitPosted = false;
/** 触顶探针的轮次基线（fill/rotate 时同步为当前存量） */
let limitMarkerBaseline = 0;
let limitMarkerText = '';
let assistantRootBaseline = 0;
/** 冷启动守卫：首个 fill/rotate 前只记基线、不报「本轮新增」 */
let _roundBaselinesReady = false;
/**
 * 三个单飞定时器。
 * [WHY] 它们必须集中声明：observer 与 dispatch 两个片段都要读写，
 *   分散声明会在拼回同一 IIFE 时产生重复 let（@ts-nocheck 拦不住，只有拼回才发现）。
 * [CONSTRAINT] 各自「已挂则不再挂」是单飞语义的来源：无此判断会在回调风暴下堆出大量定时器。
 */
let observerDebounce = null;
/** 结构未闭合块被延迟时的单飞复查定时器 */
let closureRetryTimer = null;
/** 生成期自巡检单飞定时器：生成结束往往不是 DOM 事件，需要主动唤醒 */
let genRetryTimer = null;
/**
 * 开启新一轮（fill / rotate 共用）。
 * [WHY] 这两条分支原本各自抄了同一串重置语句，任何新增状态只要漏抄一处就会静默漏配
 *   （例如漏清 stopPosted ⇒ 新一轮的脚本被上一轮的停止旗标挡死）。
 * [CONSTRAINT] **停止（stop）不走这里**：停止后要保留去重集合与正文签名，
 *   否则旧回复会被重判为新回复重新推送。
 * [CHANGE-IMPACT] 后续新增任何「随轮次失效」的状态，一律加进本函数，不要加在调用方。
 */
function resetRoundState() {
    stopPosted = false;
    prevGenerating = false;
    genEnterRoots = 0;
    genEnterRootId = '';
    limitPosted = false;
    _scriptFenceReported = false;
    _pendingDoneSig = null;
    _roundBaselinesReady = true;
    window.__aiRunnerClosureGate = null;
    if (genRetryTimer) {
        clearTimeout(genRetryTimer);
        genRetryTimer = null;
    }
    syncLimitMarkerBaseline();
    resumeReplyObserver();
}

/**
 * 生成中判定 —— 「现在 AI 是否仍在输出」。
 * [WHY] 这道门是脚本回传的最后一道闸：判错成 false 就会把流式半截脚本推出去，
 *   下游 /run 报 Unexpected end of input，与上游真截断完全同形，排查成本极高。
 *
 * 三条判据按「可靠性从高到低」排列，任一命中即为生成中：
 *   ① 标签通道：输入区内的可点击元素，文本/属性命中停止语义。
 *   ② 站点专属：适配器声明的 generatingSelector（智谱 .enter.is-main-chat.searching）。
 *   ③ 图签名兜底：DeepSeek 圆钮内 svg path 命中停止方块锚点。
 *
 * [CONSTRAINT] 三者必须互相隔离：②③ 只对各自站点生效，不得让某个站点的选择器
 *   影响其它站点的判定结果——否则修一个站点会静默破坏另一个。
 */
/**
 * 停止语义正则。
 * [CONSTRAINT] 必须与 headless-inject.ts 的同名常量同值：两通道对同一按钮给出不同判定，
 *   会让「无头通道认为已结束、油猴通道认为仍在生成」，表现为两条通道回传节奏分叉。
 */
const STOP_LABEL_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i;
/**
 * 收集候选停止按钮，范围收敛到「输入区」。
 * [WHY] 早期实现搜整页：页面上任何瞬态可点击元素（上传 Cancel、对话框「取消生成」…）
 *   只要命中正则就让 isGenerating() 假 true；其消失又伪造「按钮从有到无」+ roots 冻结，
 *   于是误推 stopped 杀掉整个循环（实测一个空闲页的 <button>Cancel</button> 即可走通）。
 * [CONSTRAINT] scope 从 parentElement 起 closest，不用 input.closest ——
 *   输入框自身 class 常含 input，会命中自己；而 textarea 无子节点，停止按钮就永远找不到。
 * [RESIDUAL-RISK] 输入区**内部**的瞬态停止词元素（附件预览里的 Cancel）仍会命中；
 *   范围收敛把面从整页缩到输入区，未清零。
 */
function collectStopCandidates() {
    const sel = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]';
    let scope = document;
    const box = findInputBox();
    const pe = box ? box.parentElement : null;
    if (pe) {
        scope = pe.closest('form, [class*="input"], [class*="composer"], [class*="chat-input"], [class*="input-area"], [class*="input-box"], [class*="input_wrap"], [class*="chat-foot"], [class*="dialog-footer"]') || pe;
    }
    const out = [];
    for (const el of Array.from(scope.querySelectorAll(sel))) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true')
            continue;
        const lbl = [
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('data-state'),
            el.getAttribute('class'),
            el.textContent,
        ].filter(Boolean).join(' ');
        if (STOP_LABEL_RE.test(lbl))
            out.push(el);
    }
    return out;
}
/**
 * 结构化兜底：输入区附近的圆形主按钮（无任何可匹配标签）。
 * [WHY] DeepSeek 的停止/发送按钮共用同一元素且无 aria-label/title/textContent，
 *   标签通道对它恒 miss，只能靠结构定位。
 * [CONSTRAINT] 发送态与停止态共用同一元素 ⇒ 仅凭「圆钮存在」不能判生成中，
 *   必须再由 hasDeepSeekStopIcon 区分两态（见下）。
 */
function findStopGeneratingBtnStructural() {
    const input = findInputBox();
    if (!input)
        return null;
    let root = input.closest('form');
    if (!root) {
        let p = input.parentElement;
        for (let i = 0; i < 8 && p; i++) {
            if (p.querySelector('[role="button"].ds-button--circle, button.ds-button--circle')) {
                root = p;
                break;
            }
            p = p.parentElement;
        }
    }
    const scope = root || document;
    for (const el of Array.from(scope.querySelectorAll('[role="button"].ds-button--circle, button.ds-button--circle'))) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true')
            continue;
        return el;
    }
    return null;
}
/**
 * DeepSeek 停止方块图签名锚点（线上 bundle 实证：commit fd5d6ec3）。
 * 停止态 = 圆角方块（单 path，以 "M2 4.88C2 3.68009" 开头、含 "V11.12C14 12.3199"）；
 * 发送态 = 上箭头（"M8.3125 0.980206"）。
 * [FAIL-OPEN] 锚点是坐标字面量，站点改版后本分支静默失效（该站点 isGenerating 恒 false），
 *   **不会**误判生成中；失效信号可通过 stop 诊断的 dsIcon 字段观测（hit / miss / na）。
 * [CONSTRAINT] 与 headless-inject.ts 的 dsAnchors 同值，改一处必须同步另一处。
 */
const DS_STOP_ICON_ANCHORS = ['M2 4.88C2 3.68009', 'V11.12C14 12.3199'];
function hasDeepSeekStopIcon(btn) {
    try {
        const paths = btn.querySelectorAll('svg path');
        for (let i = 0; i < paths.length; i++) {
            const d = paths[i].getAttribute('d') || '';
            if (DS_STOP_ICON_ANCHORS.some(a => d.includes(a)))
                return true;
        }
    }
    catch { /* 站点结构异常：按非停止态处理（fail-open，宁可不判也不误判） */ }
    return false;
}
function findStopGeneratingBtn() {
    return collectStopCandidates()[0] || null;
}
/**
 * 生成中总判据。
 * [CONSTRAINT] 顺序不可随意调换：标签通道（最可靠、跨站点）先行；
 *   站点专属与图签名兜底各自 fail-open，且互不影响对方的站点。
 */
function isGenerating() {
    const btn = findStopGeneratingBtn();
    if (btn && !btn.disabled)
        return true;
    // [site-generating-selector-v1] 智谱：生成中发送键带 .searching 类（纯图标无文本，标签通道恒 miss）；
    //   仅 chatglm.cn 生效，DeepSeek 分支（下方图签名）保持原样不受影响。
    if (typeof location !== 'undefined'
        && /chatglm\.cn$/.test(location.hostname)
        && document.querySelector('.enter.is-main-chat.searching'))
        return true;
    // DeepSeek 图签名兜底：圆钮存在且图标为停止方块才算生成中
    const dsBtn = findStopGeneratingBtnStructural();
    return Boolean(dsBtn && !dsBtn.disabled && hasDeepSeekStopIcon(dsBtn));
}
/**
 * [stopped-continue-btn-v1] 「继续生成」按钮存在 ⇒ 平台自停。
 * [WHY] 原判据只认「assistant 根数冻结」，但平台自停的典型形态是**已产出部分回复后中断**
 *   —— 此时根已经增长，rootsFrozen 恒为 false，被误判成「正常完成」，stopped 永不推送，
 *   前端的自动续推（stop-resume）因此永不触发（用户实测：DeepSeek 显示「已停止」+「继续生成」，应用毫无反应）。
 * [CONSTRAINT] 文案匹配保守（仅四种精确文案），不匹配裸「继续」以防命中正文；
 *   与 headless-inject.ts 的 hasContinueBtnInPage 同值，改一处必须同步另一处。
 */
const CONTINUE_BTN_RE = /^(?:继续生成|继续回答|继续输出|Continue generating)$/i;
function hasContinueBtn() {
    try {
        for (const el of document.querySelectorAll('button, div[role="button"], [role="button"]')) {
            const label = String(el.getAttribute('aria-label') || el.textContent || '').trim();
            if (label && CONTINUE_BTN_RE.test(label))
                return true;
        }
    }
    catch { /* 站点结构异常：按无按钮处理（fail-open，宁可不判也不误判） */ }
    return false;
}
/**
 * [stopped-label-v1] 当前轮回复区出现「已停止」状态角标 ⇒ 平台自停。
 * [WHY] 第三种中断形态：有产出 + 显示「已停止」+ **无**「继续生成」按钮。
 *   社区实现 dsh-continuechat 记录：turn 提前结束时「leaves nothing behind but a stopped
 *   marker」——此时 rootsFrozen 恒 false（已有产出）、hasContinueBtn 也恒 false。
 * [CONSTRAINT] 三重保险防空：① 文本**精确等值**（正文复述时父元素 textContent 是整段话）
 *   ② 排除 .ds-markdown / pre / code（[stopped-toast-quote-v1] 的自指教训）
 *   ③ 要求同容器内有 svg（状态角标必带图标，孤立文本节点不算）。
 * [CONSTRAINT] 不硬编码 hash 类名（DeepSeek 类名随版本变化）；只依赖文本 + 图标结构。
 *   与 headless-inject.ts 的 hasStoppedLabelInPage 同构，改一处必须同步另一处。
 */
const STOPPED_LABEL_TEXT = '已停止';
/**
 * [stopped-label-v2] 上溯到整条消息容器再扫。
 * [WHY] 「已停止」角标挂在**思考块头部**，是正文容器 `.ds-assistant-message-main-content` 的
 *   兄弟节点而非子节点 ⇒ v1 的 scope 永远扫不到（2026-10-18 用户实测三判据全 miss）。
 * [CONSTRAINT] 用 `closest` 仍限定在当前轮，不扫历史消息；找不到祖先时退回正文容器（fail-safe）。
 */
const STOPPED_MESSAGE_SELECTOR = '.ds-message';
function hasStoppedLabel() {
    const root = latestAssistantRoot();
    if (!root)
        return false;
    const scope = root.closest(STOPPED_MESSAGE_SELECTOR) || root;
    try {
        for (const el of scope.querySelectorAll('span, div')) {
            if (el.closest('.ds-markdown, pre, code'))
                continue;
            if (String(el.textContent || '').trim() !== STOPPED_LABEL_TEXT)
                continue;
            if (el.querySelector('svg') || el.parentElement?.querySelector('svg'))
                return true;
        }
    }
    catch { /* 站点结构异常：按无标记处理（fail-open，宁可不判也不误判） */ }
    return false;
}

/**
 * 脚本块提取 —— 从最后一条 AI 回复里挑出「首个尚未推送的合格代码块」。
 *
 * 三道门，任一不放行都不能推：
 *   ① 语言白名单（js / bash，脚本头契约兜底为 js）——推 python/json 给 node 必然语法错；
 *   ② 可执行内容门 —— 只有头部注释的残缺块不算完整脚本；
 *   ③ 结构闭合门 —— 括号/引号未闭合极可能是流式半截，先等，等不到才按「上游真截断」放行。
 *
 * [WHY] 这三道门都是被真实事故逼出来的：
 *   · 只有防抖 + 生成中门时，流式中途任何一次超过窗口的停顿都会让半截块被判为完整；
 *   · 括号闭合门对「纯注释」天然为 false，于是只有头部的块被当完整脚本推出去，前端跑两次；
 *   · 旧实现只取最后一块，前面的块被静默丢弃，而最后一块恰是截断最可能切中的那块。
 * [CONSTRAINT] 本段与 headless-inject.ts 的 extractLatestScript 语义必须同构
 *   （那边查固定选择器，这边走站点无关的 latestAssistantRoot），
 *   由 script-closure-gate / multi-script-blocks 用假 DOM 对拍锁死。改一处必须同步另一处。
 */
/**
 * 括号/引号闭合扫描：返回 true 表示**未闭合**（不可直接推送）。
 * [CONSTRAINT] 语义必须与 packages/core/src/post-run/script-check.ts 的 hasUnclosedStructure
 *   一致（那边是服务端判据），由 script-closure-gate 用例做语料对拍。
 * [WHY] 手写状态机而非正则：正则无法正确处理「字符串里的括号」与「注释里的引号」。
 */
function hasUnclosedStructureJs(src) {
    const stack = [];
    let state = 'code';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const nx = src[i + 1];
        if (state === 'line-comment') {
            if (ch === '\n' || ch === '\r')
                state = 'code';
            continue;
        }
        if (state === 'block-comment') {
            if (ch === '*' && nx === '/') {
                state = 'code';
                i++;
            }
            continue;
        }
        if (state === 'single' || state === 'double' || state === 'template') {
            const q = state === 'single' ? "'" : state === 'double' ? '"' : '`';
            if (ch === '\\') {
                i++;
                continue;
            }
            if (ch === q)
                state = 'code';
            continue;
        }
        if (ch === '/' && nx === '/') {
            state = 'line-comment';
            i++;
            continue;
        }
        if (ch === '/' && nx === '*') {
            state = 'block-comment';
            i++;
            continue;
        }
        if (ch === "'") {
            state = 'single';
            continue;
        }
        if (ch === '"') {
            state = 'double';
            continue;
        }
        if (ch === '`') {
            state = 'template';
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[') {
            stack.push(ch);
            continue;
        }
        if (ch === '}' || ch === ')' || ch === ']') {
            const want = ch === '}' ? '{' : ch === ')' ? '(' : '[';
            if (stack.length === 0 || stack[stack.length - 1] !== want)
                return true;
            stack.pop();
        }
    }
    if (state === 'single' || state === 'double' || state === 'template' || state === 'block-comment')
        return true;
    return stack.length > 0;
}
/**
 * 剔除 shebang / 注释 / 空白后是否还有可执行内容。
 * [CONSTRAINT] 与 headless-inject.ts 同名函数逐字同构；判据与
 *   packages/client/composables/runner/inbox-parse.ts 的 normalizeForHash 同义。
 */
function hasExecutableContent(src) {
    const stripped = String(src || '')
        .split('\n')
        .map(l => l.trim())
        .filter((l) => {
        if (!l)
            return false;
        if (l.startsWith('#!'))
            return false;
        if (l.startsWith('//'))
            return false;
        if (l.startsWith('#'))
            return false;
        return true;
    })
        .join('');
    return stripped.length > 0;
}
/**
 * 「回复仍在增长」判定：正文长度变了就继续等；连续 3 次等长则视为上游真截断并放行。
 * [CONSTRAINT] 门状态挂在 window 上（不用闭包变量）——本段与内置通道逐字同构，
 *   内置通道经 page.evaluate 序列化执行，引用外部闭包会丢。
 */
function stillStreamingReply() {
    const body = String((document.body && document.body.textContent) || '');
    const w = window;
    const gate = w.__aiRunnerClosureGate;
    if (!gate || gate.len !== body.length) {
        w.__aiRunnerClosureGate = { len: body.length, ticks: 0 };
        return true;
    }
    gate.ticks++;
    return gate.ticks < 3;
}
/** 脚本头契约：shebang 或 @desc 头 —— 站点漏标语言时据此兜底为 js */
function hasScriptHead(text) {
    return /^#!\s*\/usr\/bin\/env\s+(?:node|bash)\b/m.test(text)
        || /^\s*\/\/\s*@desc\b/m.test(text)
        || /^\s*#\s*@desc\b/m.test(text);
}
/**
 * 提取「首个尚未推送」的合格脚本块。
 * [CONSTRAINT] 只扫最后一条 AI 回复容器内的 <pre>；容器缺失（新会话首轮思考阶段）
 *   不得退回整页 —— 否则用户首条消息里的代码块会被当脚本候选。
 * [CONSTRAINT] 本回复内存在任意**标记块**时，无标记块视为片段不推（fragment-guard）：
 *   标记块才算「AI 明确要交付的脚本」，其余可能只是示例。
 */
function extractLatestScript() {
    const root = latestAssistantRoot();
    const pres = root ? root.querySelectorAll('pre') : [];
    let firstUnseen = null;
    let firstUnseenMarked = null;
    let hasAnyMarked = false;
    for (const pre of Array.from(pres)) {
        // 优先从 <pre><code> 取文本：pre.textContent 会把代码块头的语言标签与「复制/下载」按钮并入首行
        const codeEl = pre.querySelector('code') || pre;
        const text = codeTextOf(codeEl);
        if (!text)
            continue;
        if (!text.includes('\n') && text.length < 120)
            continue;
        // 语言判定四级回退：className → DOM 邻近探测 → 内容特征 → 脚本头契约
        let lang = guessLangFromClass(codeEl) || guessLangFromDom(pre) || guessLangFromContent(text) || null;
        const marked = hasScriptHead(text);
        if (!lang && marked)
            lang = 'js';
        // [script-lang-whitelist-v2] 取消「声明 SCRIPT 即无条件放行」：声明时连语言都判不出的块
        //   （python / json / 无标签）不再收——前端把 null 折算成 js 交给 node 必然语法错。
        if (lang !== 'js' && lang !== 'bash')
            continue;
        if (!hasExecutableContent(text))
            continue;
        // 未闭合先等；等不到（连续 3 帧等长）才按上游真截断放行，走下游 400 补救路径
        if (hasUnclosedStructureJs(text)) {
            if (stillStreamingReply())
                continue;
        }
        const item = { lang, code: text, hash: hash32(text) };
        // marked 必须在 seen 跳过**之前**计算：已推送过的标记块也要计入 hasAnyMarked，
        // 否则第二次 pick 会误判「本回复无标记块」而把片段兜底推出去
        if (marked)
            hasAnyMarked = true;
        if (seenHashes.has(item.hash))
            continue;
        if (!firstUnseen)
            firstUnseen = item;
        if (marked && !firstUnseenMarked)
            firstUnseenMarked = item;
    }
    if (firstUnseenMarked)
        return firstUnseenMarked;
    if (hasAnyMarked)
        return null;
    return firstUnseen;
}
/**
 * 是否还有未推送的合格块 —— 决定推完一块后要不要主动再跑一次分类。
 * [WHY] 本通道靠 MutationObserver 唤醒；推完第一块后 DOM 已静止，
 *   observer 不会再触发，同一回复里的第 2、3 个脚本会一直躺着不发。
 */
function hasMoreUnseenBlocks() {
    try {
        const s = extractLatestScript();
        return Boolean(s && !seenHashes.has(s.hash));
    }
    catch {
        return false;
    }
}
/**
 * DOM 提取失败时的 Markdown 围栏兜底。
 * [WHY] 部分站点的代码块不用标准 <pre><code> 结构，extractLatestScript 找不到
 *   ⇒ 整条回复降级成 plain 文本（表现为「渲染了但没执行」）。
 * [CONSTRAINT] 只从最后一条 AI 回复里取；语言白名单同为 js / bash / cjs。
 */
function extractScriptFromMarkdown() {
    try {
        const root = latestAssistantRoot();
        if (!root)
            return null;
        const md = extractReplyMd(root);
        const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
        let m;
        let last = null;
        while ((m = fenceRe.exec(md)) !== null) {
            const rawLang = (m[1] || '').toLowerCase();
            const code = m[2].replace(/^\n+|\n+$/g, '');
            if (!code || (!code.includes('\n') && code.length < 120))
                continue;
            let lang = rawLang === 'javascript' || rawLang === 'node' || rawLang === 'js'
                ? 'js'
                : rawLang === 'sh' || rawLang === 'shell' || rawLang === 'bash'
                    ? 'bash'
                    : rawLang === 'cjs' ? 'cjs' : null;
            if (!lang)
                lang = guessLangFromContent(code);
            if (lang !== 'cjs' && lang !== 'js' && lang !== 'bash')
                continue;
            last = { lang, code, hash: hash32(code) };
        }
        return last;
    }
    catch {
        return null;
    }
}

/**
 * 回复检测 —— dispatch 的三个输入源：DONE 标记、正文签名、最新回复全文。
 *
 * [CONSTRAINT] 三者在「assistant 容器缺失」时必须一致地**什么都不做**：
 *   新会话首轮「已思考/搜索」阶段没有回复容器，此时整页反推会把侧栏历史会话标题
 *   与用户首条消息（SYSTEM.md 卡）拼成「回复」，表现为连续的噪音文本卡。
 *   这条约束在三个函数里各写一次，是有意为之——任何一个漏掉都会单独产生噪音。
 */
/**
 * 本轮是否出现「首行 = DONE」的回复；命中返回去重标记与全文。
 * [CONSTRAINT] marker 只取前 200 字做 hash（不含长度）：短内容时前 200 字随流式变化，
 *   带上长度会让每帧都成新 marker，同一条 DONE 被推 N 次。
 */
function findNewDone() {
    const root = latestAssistantRoot();
    if (!root)
        return null;
    // 用 DOM→Markdown 反推而非 textContent：后者会把块级元素粘成一行，首行判据失效
    const summary = extractReplyMd(root);
    if (summary && scanReplyMarks(summary).done > 0) {
        const headMarker = hash32(`done-head|${summary.slice(0, 200)}`);
        if (!seenDoneMarkers.has(headMarker)) {
            return { marker: headMarker, text: summary };
        }
    }
    return null;
}
/**
 * 正文签名 —— 判断「正文是否变了」的指纹。
 * [WHY] 优先用最后一条 AI 回复容器的文本：整页末 300 字符在多数站点是输入框/页脚，
 *   AI 流式期间恒定 ⇒ 签名不变 ⇒ 永远触发不了回传。
 * [CONSTRAINT] 容器存在但文本为空时退回整页末 300 字符（旧行为），
 *   保证「有容器但还没渲染出内容」的站点不回归。
 */
function bodySignature() {
    const root = latestAssistantRoot();
    const rootText = root ? (root.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const t = rootText || (document.body.textContent || '').replace(/\s+/g, ' ');
    return hash32(t.slice(-300));
}
/**
 * 最后一条回复的完整 Markdown。
 * [CONSTRAINT] 容器缺失返回空串，**不**退回整页：plain 分支拿到空串就不会推送，
 *   这正是「思考阶段不产生噪音卡」所需要的。
 */
function extractLatestReplyText() {
    try {
        const root = latestAssistantRoot();
        if (!root)
            return '';
        return extractReplyMd(root);
    }
    catch {
        return '';
    }
}

/**
 * 围栏契约判定 —— 首行声明了 SCRIPT，但载荷不是合法 js/cjs 代码块时该怎么办。
 *
 * [WHY] 这类回复（正文里贴了伪代码、或用了非白名单语言标签）如果不报错就直接跳过，
 *   应用端只能看到「AI 说了话但工作台毫无反应」，属静默失败。
 *   但也不能每轮都报——AI 会持续流式改写，同一轮里报 N 次会刷屏。
 * [CONSTRAINT] 纯函数、无 DOM/闭包依赖，与 headless-inject.ts 的同名实现同构，
 *   由 script-fence-gate 守卫测试对拍。
  * [headless-collector-v1] 稳定契约同步说明：无头侧已改为「信号驱动 + 静默窗 ≥400ms」，
 *   本通道靠 MutationObserver 350ms 防抖 + isGenerating 分支，两者语义一致（静默即稳定）。
 *   无头侧静默窗特意设为 400ms >= 本通道 350ms，避免比本通道更早交付半截正文。
 *   改任一侧的稳定判据时必须同步本注释与对侧实现，否则站点改版时会有人按旧契约修错一边。
*/
/**
 * @param scriptMarkPositive 首行是否为 SCRIPT 标记
 * @param seenHashesLen 本轮已成功推送的脚本块数量
 * @param alreadyReported 本轮是否已报过错
 * [CONSTRAINT] seenHashesLen > 0 时一律 none：只要推成功过，就不是「载荷不合法」，
 *   而是正文里另有说明性内容，不该报错。
 */
function decideScriptFence(scriptMarkPositive, seenHashesLen, alreadyReported) {
    if (!scriptMarkPositive)
        return 'none';
    if (seenHashesLen > 0)
        return 'none';
    if (alreadyReported)
        return 'suppress';
    return 'report';
}

/**
 * 三条推送路径：script / plain / error。
 * [WHY] 噪音抑制条件集中在调用方（classifyAndPost），但每条路径各自的守卫
 *   （去重、停止后不补发、标记行剥离）落在这里，便于逐条核对。
 * [CONSTRAINT] 所有推送都要带 site 与 sessionId：工作台按 (site, sessionId) 归窗，
 *   缺任一项都会让回传落到错误窗口。
 */
/**
 * 推送脚本块。
 * [CONSTRAINT] 调用方必须已确认 !seenHashes.has(hash)；此处仍再查一次，
 *   因为多块续推路径会在同一 tick 内连调，去重集合是唯一可靠的交汇点。
 * @returns 是否真的推送了（调用方据此决定要不要继续找下一块）
 */
function emitScript(item) {
    if (seenHashes.has(item.hash))
        return false;
    seenHashes.add(item.hash);
    post({
        type: 'ai-runner:reply',
        kind: 'script',
        code: item.code,
        lang: item.lang,
        hash: item.hash,
        site: location.origin,
        sessionId: extractSidFromHash(),
    });
    lastBodySig = bodySignature();
    return true;
}
/**
 * 推送纯文本回复。
 * [WHY] TEXT 标记的回复要剥掉首行标记只留正文，否则工作台会把「TEXT」这个词
 *   渲染进正文卡片（首行是标记不是内容）。
 */
function emitPlain(md, marks) {
    const text = marks.text > 0 ? md.split(/\r?\n/).slice(marks.text).join('\n').trim() : md;
    post({
        type: 'ai-runner:reply',
        kind: 'plain',
        site: location.origin,
        sessionId: extractSidFromHash(),
        text,
    });
}
/**
 * 推送围栏契约错误。
 * [CONSTRAINT] 文案必须能直接指导修复（写明围栏语言与头部契约），
 *   应用端拿到这条消息时没有上下文可推断。
 */
function emitFenceError() {
    _scriptFenceReported = true;
    post({
        type: 'ai-runner:reply',
        kind: 'error',
        site: location.origin,
        sessionId: extractSidFromHash(),
        text: 'SCRIPT 载荷不是有效的 js/cjs 代码块：必须用 js 围栏包裹代码，且脚本头用 // @desc / // @why（参考 packages/core/SYSTEM.md §1 状态 A）。',
    });
}

/**
 * turn 信封 → 块帧 / 结束帧（油猴侧，P3）。
 *
 * [WHY] 信封到达时「整轮内容」是一次性确定的对象，不再需要 extractLatestScript 那三道
 *   流式门（语言白名单 / 闭合门 / 内容门）—— 块已经带 `lang` 且 code 是 JSON 里的完整字符串。
 *   继续走旧路径的后果是：信封 JSON 会被语言判定当成 json 拒掉，整条回复降级为 plain，
 *   用户看到一坨 JSON 上屏且脚本一个都不执行。
 *
 * [CONSTRAINT] 帧 shape 与「块字段收窄」必须与核心 `packages/core/src/reply/turn-frames.ts`
 *   完全同构，由 turn-emit-parity 用例做**行为对拍**（同一批块两端产出的帧必须逐字节相同）。
 *   这条判据承重的原因：一旦某端多带一个字段（例如 say 帧带上 code），前端的「采信守卫」
 *   就再也测不出「值是从别的字段抄来的」。
 *
 * [CONSTRAINT] 去重键是 `<sid>|<turnId>|<blockId>` 而非内容 hash：同一信封会被 MutationObserver
 *   反复扫到，按内容 hash 去重会把「同 id 改了内容」的块也一并挡掉（R2 要求后到覆盖先到）。
 *   sid 前缀承重：不同会话的 turnId 各自从 1 起算，不带 sid 会让两个会话的「turn 3」互相顶掉。
 */
/**
 * [turn-emit-dedup-persist-v1] 去重集合落 sessionStorage。
 * [WHY] 集合此前只在页面内存里：刷新后 MutationObserver 会重新扫到同一条 AI 回复，
 *   集合已随页面清空 ⇒ 同一信封被重推 ⇒ 前端执行账本同样为空 ⇒ **上一轮脚本被重跑**（P0-1b）。
 *   sessionStorage 与页面同生命周期但跨刷新存活，正好覆盖「只跨刷新、不跨新标签」的缺口。
 */
const TURN_SEEN_STORE = 'aiRunner.turnSeenBlocks.v1';
const TURN_ENDED_STORE = 'aiRunner.turnEndedIds.v1';
/** 读回持久化的去重集合；不可用（隐私模式 / 非浏览器上下文）⇒ 空集，降级为纯内存去重 */
function loadKeySet(storeKey) {
    const out = new Set();
    try {
        if (typeof sessionStorage === 'undefined')
            return out;
        const raw = sessionStorage.getItem(storeKey);
        if (!raw)
            return out;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            return out;
        for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'string')
                out.add(arr[i]);
        }
        return out;
    }
    catch {
        return new Set();
    }
}
/** 写回去重集合；写失败只影响「跨刷新去重」这一增益，不影响本轮行为 */
function persistKeySet(storeKey, set) {
    try {
        if (typeof sessionStorage === 'undefined')
            return;
        sessionStorage.setItem(storeKey, JSON.stringify(Array.from(set)));
    }
    catch { /* 配额 / 隐私模式：降级为纯内存去重 */ }
}
/** 已推送过的 `<sid>|<turnId>|<blockId>`；跨 poll 且跨刷新保留 */
const seenTurnBlocks = loadKeySet(TURN_SEEN_STORE);
/** 已推过结束帧的 `<sid>|<turnId>`；同一信封重复扫到时不得重复发 */
const endedTurnIds = loadKeySet(TURN_ENDED_STORE);
/** 去重集合上限；超了淘汰最旧（信封 turnId 单调递增，淘汰最旧不会造成重推） */
const TURN_SEEN_MAX = 800;
/** 淘汰最旧条目：Set 保持插入序，values().next() 即最早插入的那个 */
function evictOldest(set) {
    const oldest = set.values().next().value;
    if (typeof oldest === 'string')
        set.delete(oldest);
}
function turnBlockKey(sid, turnId, blockId) {
    return `${sid}|${turnId}|${blockId}`;
}
/**
 * 本轮结束后循环等什么。优先级 **script > ask > none**（与核心 deriveAwaiting 同构）。
 * [WHY] 不让前端各自推导：三处推导必然在「既有 script 又有 ask」上分叉，
 *   而分叉的后果是循环要么空转要么提前结束，且没有任何一处报错。
 */
function turnAwaiting(blocks) {
    let hasScript = false;
    let hasAsk = false;
    for (let i = 0; i < blocks.length; i++) {
        const t = blocks[i] && blocks[i].type;
        if (t === 'script')
            hasScript = true;
        else if (t === 'ask')
            hasAsk = true;
    }
    if (hasScript)
        return 'results';
    if (hasAsk)
        return 'user';
    return 'none';
}
/**
 * 单块收窄。返回字符串 = 跳过的原因（缺哪个字段），返回对象 = 可用的帧。
 * [CONSTRAINT] 只输出该类型**该有**的字段：把 `code` 塞进 say 帧会让前端有机会读错字段。
 */
function turnToFrame(turnId, blockId, seq, type, b) {
    if (type === 'say') {
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim())
            return 'text';
        return { turnId, blockId, seq, type, text };
    }
    if (type === 'handoff') {
        const summary = typeof b.summary === 'string' ? b.summary : '';
        if (!summary.trim())
            return 'summary';
        return { turnId, blockId, seq, type, summary };
    }
    if (type === 'ask') {
        const question = typeof b.question === 'string' ? b.question : '';
        if (!question.trim())
            return 'question';
        const options = [];
        const rawOptions = Array.isArray(b.options) ? b.options : [];
        for (let i = 0; i < rawOptions.length; i++) {
            const o = rawOptions[i];
            const label = o && typeof o.label === 'string' ? o.label : '';
            if (!label.trim())
                continue;
            const oid = o && typeof o.id === 'string' && o.id ? o.id : `opt_${options.length + 1}`;
            options.push({ id: oid, label });
        }
        return { turnId, blockId, seq, type, question, options };
    }
    // script
    const lang = typeof b.lang === 'string' ? b.lang : '';
    const code = typeof b.code === 'string' ? b.code : '';
    const desc = typeof b.desc === 'string' ? b.desc : '';
    const why = typeof b.why === 'string' ? b.why : '';
    if (!code.trim())
        return 'code';
    if (lang !== 'js' && lang !== 'cjs')
        return 'lang';
    if (!desc.trim())
        return 'desc';
    if (!why.trim())
        return 'why';
    return { turnId, blockId, seq, type, lang, desc, why, code };
}
/**
 * 块列表 → `{ blocks, end }`（与核心 blocksToFrames 同构）。
 * [CONSTRAINT] `seq` 取输入数组下标而非「已发块计数」：跳过的块要在 seq 上留空洞，
 *   前端据此能发现「说好的第 3 块没来」，而不是把第 4 块错位当成第 3 块。
 */
function turnBlocksToFrames(turnId, raw) {
    const blocks = [];
    const skipped = [];
    const list = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < list.length; i++) {
        const b = list[i] || {};
        const id = typeof b.id === 'string' ? b.id : `#${i + 1}`;
        const type = typeof b.type === 'string' ? b.type : '';
        if (type !== 'say' && type !== 'script' && type !== 'ask' && type !== 'handoff') {
            skipped.push(`${id}:type`);
            continue;
        }
        const frame = turnToFrame(turnId, id, i, type, b);
        if (typeof frame === 'string') {
            skipped.push(`${id}:${frame}`);
            continue;
        }
        blocks.push(frame);
    }
    const end = { turnId, awaiting: turnAwaiting(blocks), blocks: blocks.length };
    if (skipped.length > 0)
        end.skipped = skipped;
    return { blocks, end };
}
/**
 * 从最后一条 AI 回复里读信封（与无头侧 readTurnBlocks 同构）。
 * [CONSTRAINT] 从后往前扫、命中即返回：一条回复里若有多个围栏，信封永远是最后交付的那个。
 * [CONSTRAINT] `truncated` ⇒ 返回 null 而不是把半截信封当完整交付。
 */
function readTurnFromRoot(root) {
    try {
        if (!root || typeof root.querySelectorAll !== 'function')
            return null;
        const pres = root.querySelectorAll('pre');
        if (pres && pres.length) {
            for (let i = pres.length - 1; i >= 0; i--) {
                const pre = pres[i];
                const codeEl = pre && typeof pre.querySelector === 'function' ? pre.querySelector('code') : null;
                const raw = (codeEl && codeTextOf(codeEl)) || (pre && pre.textContent) || '';
                if (!raw)
                    continue;
                const r = parseTurn(raw);
                if (!r || !r.blocks || r.blocks.length === 0)
                    continue;
                if (r.truncated)
                    return null;
                return { turnId: typeof r.turn === 'number' ? r.turn : 0, blocks: r.blocks, errors: r.errors || [] };
            }
        }
        // [no-fence-envelope-v1] 无 <pre> 信封（回复未加 ```json 围栏）⇒ 回退解析整条回复文本。
        //   无围栏时裸 JSON 不进 <pre>，只扫 <pre> 会整轮找不到信封 ⇒ 回落 plain 把 JSON 正文推上屏、
        //   脚本零执行（用户实测 2026-10-19）。parseTurn 已支持以左花括号开头的裸 JSON，
        //   且要求存在非空 content ⇒ 普通文本 / 非信封 JSON 仍返回 null，不误吞。
        // [CONSTRAINT] 函数体内注释不得出现字面花括号：守卫抠函数体时会做朴素花括号配对，会被注释里的括号带偏。
        const rawText = String((root && root.textContent) || '');
        if (rawText) {
            const r = parseTurn(rawText);
            if (r && r.blocks && r.blocks.length > 0 && !r.truncated) {
                return { turnId: typeof r.turn === 'number' ? r.turn : 0, blocks: r.blocks, errors: r.errors || [] };
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * 把一个信封推成帧。
 * @returns 本轮内容是否**由信封承载**（true ⇒ 调用方必须 return，不得再走 script / plain）
 * [CONSTRAINT] 重复扫到同一信封时一帧都不发，但仍返回 true：
 *   若返回 false，dispatch 会回落到 plain 分支把信封 JSON 正文推上屏。
 * [CONSTRAINT] 没有任何可用块（全被字段校验跳过）⇒ 返回 false：此时确实退化成旧路径，
 *   让 script / plain 有机会兜住（半截块至少能靠 plain 让用户看见）。
 */
function emitTurn(turn) {
    if (!turn || !turn.blocks || !turn.blocks.length)
        return false;
    const frames = turnBlocksToFrames(turn.turnId, turn.blocks);
    if (!frames.blocks.length)
        return false;
    const sid = extractSidFromHash();
    let sent = 0;
    let dirty = false;
    for (let i = 0; i < frames.blocks.length; i++) {
        const block = frames.blocks[i];
        const key = turnBlockKey(sid, block.turnId, block.blockId);
        if (seenTurnBlocks.has(key))
            continue;
        seenTurnBlocks.add(key);
        dirty = true;
        if (seenTurnBlocks.size > TURN_SEEN_MAX)
            evictOldest(seenTurnBlocks);
        post({
            type: 'ai-runner:block',
            block,
            site: location.origin,
            sessionId: sid,
        });
        sent++;
    }
    const endKey = `${sid}|${turn.turnId}`;
    if (!endedTurnIds.has(endKey)) {
        endedTurnIds.add(endKey);
        dirty = true;
        if (endedTurnIds.size > TURN_SEEN_MAX)
            evictOldest(endedTurnIds);
        post({
            type: 'ai-runner:turn-end',
            end: frames.end,
            site: location.origin,
            sessionId: sid,
        });
    }
    if (sent > 0)
        lastBodySig = bodySignature();
    // [turn-emit-dedup-persist-v1] 只有真新增了去重键才落盘：无新帧的重复扫描不该写存储。
    if (dirty) {
        persistKeySet(TURN_SEEN_STORE, seenTurnBlocks);
        persistKeySet(TURN_ENDED_STORE, endedTurnIds);
    }
    return true;
}

/**
 * 分类分发 —— 每轮 DOM 稳定后被调用一次，决定「这一轮要推什么」。
 *
 * 三段式，顺序不可随意调换：
 *   ① 门：DONE 稳定门 → 冷启动守卫 → 生成中门。任一命中即 return，不往下走。
 *   ② 探针：stopped → limit。都是「本轮状态相对上一轮/基线」的变化判定。
 *   ③ 分流：script → plain。真正的推送动作。
 *
 * [WHY] 门必须在探针之前：AI 正常生成时正文里可能自指命中停止/触顶词表，
 *   若探针先跑就会误推 stopped，而 stopped 会让前端直接 finish 整个循环。
 */
/**
 * [tm-diag-v1] 回程链路自诊断：**每轮都发**，无论成败。
 *
 * [WHY 需要它] 「脚本零执行」这条故障有三种完全不同的断点，且**都不产生任何错误**：
 *   ① 信封解析不出来（readTurnFromRoot 返 null）——用户看到整坨 JSON 上屏；
 *   ② 解析出来了但 postMessage 送不到工作台（window.opener 为 null / 已closed）——
 *      工作台侧零日志、零报错，只是永远转圈；
 *   ③ 帧送到了但被执行器闸门拦掉。
 *   ①②③ 在服务端日志里长得**一模一样**（runner.jsonl 就是不增长），
 *   所以必须由油猴侧主动把判据报出来，否则只能靠猜（2026-10-19 就在这上面耗了两轮）。
 *
 * [CONSTRAINT] 直发 e.source/opener 而不走 post() 的断链队列：诊断信息在断链时**最需要**送达，
 *   走队列等于在最需要的时候必然丢失。
 * [CONSTRAINT] 只报判据与长度，不报正文（避免把用户内容复制进日志）。
 */
function _tmDiag(stage, extra) {
    try {
        const opener = window.opener;
        const payload = {
            type: 'ai-runner:tm-diag',
            stage,
            hasOpener: !!opener,
            openerClosed: !!(opener && opener.closed),
            href: location.href.slice(0, 160),
            ts: Date.now(),
            ...extra,
        };
        // [diag-best-effort] 三条路都试：事件源 → opener → 父窗口
        const targets = [window.__aiDiagSource || null, opener, window.parent];
        for (const t of targets) {
            if (!t)
                continue;
            try {
                t.postMessage(payload, '*');
                return;
            }
            catch { /* 换下一条路 */ }
        }
    }
    catch { /* 诊断自身失败不得影响主链路 */ }
}
function classifyAndPost() {
    // [tm-diag-v1] 诊断在**门之前**发：opener 缺失导致第19 行早退时，诊断仍能送达，
    //   这正是要抓的那种失败（放在门之后就永远抓不到了）。
    _tmDiag('enter', { hasRoot: typeof latestAssistantRoot === 'function' });
    try {
        if (!window.opener || window.opener.closed) {
            // [tm-diag-v1] 这是最常见的静默断点：直接在地址栏/书签打开的站点页 opener 为 null，
            //   下行靠工作台主动 postMessage 仍然通（只要有窗口引用），上行却全灭。
            _tmDiag('opener-missing', { note: 'classifyAndPost 第一行即return，未做任何分类' });
            return;
        }
        // ---------- ① 门 ----------
        const doneMarker = findNewDone();
        if (doneMarker) {
            // DONE 双门：生成中不推（首行可能流式中途出现）+ 2 帧稳定门兜底
            if (isGenerating())
                return;
            const doneSig = bodySignature();
            if (_pendingDoneSig !== doneSig) {
                _pendingDoneSig = doneSig;
                return;
            }
            _pendingDoneSig = null;
            seenDoneMarkers.add(doneMarker.marker);
            post({
                type: 'ai-runner:reply',
                kind: 'done',
                site: location.origin,
                sessionId: extractSidFromHash(),
                text: doneMarker.text,
            });
            lastBodySig = doneSig;
            return;
        }
        // 冷启动守卫：首个 fill/rotate 前只记基线，不报「本轮新增」——
        // 历史恢复的存量标记若被当成本轮新增，刷新页面就会立刻误报
        if (!_roundBaselinesReady) {
            limitMarkerBaseline = countLimitMarkers();
            return;
        }
        // 生成中门：流式未结束时 script/plain 一律推迟
        const currGen = isGenerating();
        if (currGen) {
            // [stopped-btn-v1] 进入 generating 时记录 roots 计数与最后根身份
            if (!prevGenerating) {
                genEnterRoots = countAssistantRoots();
                genEnterRootId = assistantRootId();
            }
            prevGenerating = currGen;
            // 「生成结束」常非 DOM 事件（按钮变灰/光标移除），若无后续 DOM 变更就再也没人唤醒它
            // [generating-gate-v2] 生成结束常非 DOM 事件：单飞自巡检定时器兜底唤醒
            if (!genRetryTimer) {
                genRetryTimer = setTimeout(() => { genRetryTimer = null; classifyAndPost(); }, 600);
            }
            return;
        }
        // ---------- ② 探针 ----------
        // stopped：三条判据任一成立即认定平台自停
        //   ① 上一轮在生成 + 本轮按钮消失 + 本轮没产出任何回复块（思考期被停）
        //   ② 「继续生成」按钮存在（[stopped-continue-btn-v1]）
        //   ③ 当前轮回复区出现「已停止」角标（[stopped-label-v1]，无继续按钮时的唯一信号）
        if (prevGenerating && !stopPosted) {
            const rootsNow = countAssistantRoots();
            const rootsFrozen = rootsFrozenNow(genEnterRoots, genEnterRootId, rootsNow, assistantRootId());
            const stoppedByBtn = hasContinueBtn();
            const stoppedByLabel = hasStoppedLabel();
            if (rootsFrozen || stoppedByBtn || stoppedByLabel) {
                stopPosted = true;
                lastBodySig = bodySignature();
                const reasonSuffix = stoppedByBtn ? '（继续生成按钮）' : stoppedByLabel ? '（已停止角标）' : '';
                post({
                    type: 'ai-runner:reply',
                    kind: 'stopped',
                    site: location.origin,
                    sessionId: extractSidFromHash(),
                    text: `${STOPPED_GENERIC}${reasonSuffix}`,
                });
                prevGenerating = false;
                return;
            }
            // 根增长了 / 最后根身份变了 ⇒ 正常完成或 regenerate，不是中断
            prevGenerating = false;
        }
        // limit：两条通道拆开——增长通道自限不 gate；存量兜底不依赖增长，必须 gate
        const limitCount = countLimitMarkers();
        if (limitCount > limitMarkerBaseline) {
            limitPosted = true;
            limitMarkerBaseline = limitCount;
            lastBodySig = bodySignature();
            post({
                type: 'ai-runner:reply',
                kind: 'limit',
                site: location.origin,
                sessionId: extractSidFromHash(),
                text: limitMarkerText || 'AI 会话已达长度上限',
            });
            return;
        }
        const limitStale = limitCount > 0 && assistantRootBaseline > 0 && countAssistantRoots() <= assistantRootBaseline;
        if (!limitPosted && limitStale) {
            limitPosted = true;
            limitMarkerBaseline = limitCount;
            lastBodySig = bodySignature();
            post({
                type: 'ai-runner:reply',
                kind: 'limit',
                site: location.origin,
                sessionId: extractSidFromHash(),
                text: limitMarkerText || 'AI 会话已达长度上限',
            });
            return;
        }
        // 结构未闭合的块被延迟后，DOM 若不再变动就再没人叫它，需主动排一次复查。
        // 只在门仍处等待期（ticks < 3）且无在途定时器时排，避免释放后空转
        // [script-closure-gate-v1] 未闭合块被延迟后主动排复查，否则 DOM 静止则无人唤醒
        const closureGate = window.__aiRunnerClosureGate;
        if (closureGate && closureGate.ticks < 3 && !closureRetryTimer) {
            closureRetryTimer = setTimeout(() => { closureRetryTimer = null; classifyAndPost(); }, 400);
        }
        // ---------- ③ 分流 ----------
        const replyRoot = latestAssistantRoot();
        // [turn-emit-v1] 信封优先（契约 §2.1）：命中即整轮按块交付，**不再**走 script / plain。
        // [WHY] 信封 JSON 在旧路径下的实际下场：语言判定把它归到 json ⇒ 白名单拒绝 ⇒
        //   整条回复降级 plain，用户看到一坨 JSON 且脚本一个都不执行（静默失效）。
        // [CONSTRAINT] 必须先于 scanReplyMarks：旧标记扫描对 JSON 正文无意义，
        //   命中 marks.text / marks.done 会让下面的 script 分支整轮跳过。
        // [CONSTRAINT] stopPosted 后不推：前端已 finish 循环，此时推块等于「循环外自动执行」旁路。
        if (!stopPosted) {
            const turn = readTurnFromRoot(replyRoot);
            // [tm-diag-v1] 诊断读判据；`if (turn && emitTurn(turn)) return` 这一行是
            //   turn-emit-parity 守卫的字面量判据（emitTurn 返回值必须中断分流），**不要改写它**。
            _tmDiag(turn ? 'turn-read' : 'turn-miss', {
                turnId: turn ? turn.turnId : undefined,
                blocks: turn ? turn.blocks.length : 0,
                errors: turn ? (turn.errors || []).length : 0,
                replyRootFound: !!replyRoot,
            });
            if (turn && emitTurn(turn))
                return;
        }
        const marks = scanReplyMarks(replyRoot ? extractReplyMd(replyRoot) : '');
        const markedNonScript = marks.ask > 0 || marks.done > 0 || marks.handoff > 0 || marks.text > 0;
        // script：标记行为非脚本类时整轮不走脚本分类（否则带示例代码块的 DONE 总结会被当脚本执行）
        // stopped 后残余块一律不推：前端已 finish 循环，此时推出去会形成「循环外自动执行」旁路
        // [stopped-no-autorun-v1] 停止轮不再推脚本：残余块会落到「循环外自动执行」旁路
        if (!markedNonScript && !stopPosted) {
            // [multi-script-v1] 一条回复可带多块：只放行首个未推送块，推完再跑一次分类
            const item = extractLatestScript() || extractScriptFromMarkdown();
            if (item && emitScript(item)) {
                // 同一回复里还有未推送的块 ⇒ 主动再跑一次（observer 此时已静止）
                if (hasMoreUnseenBlocks())
                    setTimeout(classifyAndPost, 80);
                return;
            }
        }
        // plain：仅在正文真的变了时推
        const sig = bodySignature();
        if (sig === lastBodySig)
            return;
        lastBodySig = sig;
        // 容器缺失 ⇒ 变化来自思考面板/搜索卡的流式抖动，此时整页反推会产出噪音卡
        if (!replyRoot)
            return;
        // [stopped-plain-noise-v1] 已推过 stopped ⇒ 之后的 plain 必为半截回复的补发
        if (stopPosted)
            return;
        // 首行是 SCRIPT 且脚本已推成功 ⇒ 此处 plain 必为 DOM 抖动引起的重复补发
        if (marks.script > 0 && seenHashes.size > 0)
            return;
        const fence = decideScriptFence(marks.script > 0, seenHashes.size, _scriptFenceReported);
        if (fence === 'report') {
            emitFenceError();
            return;
        }
        if (fence === 'suppress')
            return;
        emitPlain(extractLatestReplyText() || '', marks);
    }
    catch { /* 页面导航/关闭期间的 DOM 异常：本轮放弃，下轮自然重试 */ }
}

/**
 * 回复观察 —— 什么时候该跑一次 classifyAndPost。
 *
 * 三条唤醒通道，缺一都会让回传卡住：
 *   ① childList / characterData：AI 逐字输出时持续触发（350ms 防抖后归并）。
 *   ② attributes（disabled / aria-label / data-state）：「停止生成」按钮变灰/消失
 *      往往不伴随子节点变化，纯属性变更，仅靠 ① 收不到。
 *   ③ 800ms 空转轮询：回复渲染完成后 DOM 完全静止，若脚本块因任何原因
 *      （闭合门延迟 / 生成中门 / 多块续推）尚未推送，① ② 都不会再触发。
 *
 * [WHY] 通道 ③ 是实测补出来的：用户滚动一下页面就立刻收到 → 滚动引发的 DOM 变动才是唤醒源。
 *   无头通道是 800ms 轮询，天然无此症；本通道对齐该频率。
 * [CONSTRAINT] attributeFilter 刻意不含 'class'：流式光标动画下 class 变更极高频，
 *   会制造 observer 回调风暴。停止按钮的态变走 disabled / aria-label / data-state 已足够覆盖。
 */
const replyObserver = new MutationObserver(() => {
    if (observerDebounce)
        clearTimeout(observerDebounce);
    observerDebounce = setTimeout(() => {
        observerDebounce = null;
        classifyAndPost();
    }, 350);
});
/**
 * 观察器是否已挂上。
 * [WHY] stop 分支要 disconnect（防旧回复重放），下次 fill/rotate 前必须能重挂；
 *   用标志位而非 try/catch 探活，避免重复 observe 造成的隐性叠加。
 */
let _replyObserving = false;
/**
 * 重挂观察器（幂等）。
 * [CONSTRAINT] 挂在 document.body 上：body 在 document-idle 时已就绪，
 *   但站点可能整页替换 body，故外层还有 3 秒存活检查兜底（见 session.ts 的 send 循环）。
 */
function resumeReplyObserver() {
    if (_replyObserving)
        return;
    try {
        replyObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['disabled', 'aria-label', 'data-state'],
        });
        _replyObserving = true;
    }
    catch { /* body 未就绪：下次 fill/rotate 再试 */ }
}
/** 断开观察器并复位标志；stop 分支调用，与 resumeReplyObserver 成对 */
function pauseReplyObserver() {
    try {
        replyObserver.disconnect();
    }
    catch { /* 未挂载时 disconnect 无副作用 */ }
    _replyObserving = false;
}
resumeReplyObserver();
/**
 * 空转唤醒轮询。
 * [CONSTRAINT] 三个前置条件均为「不该跑」的短路，任一命中即跳过：
 *   后台标签页（document.hidden）不跑 —— 后台定时器被节流，跑了也没意义；
 *   防抖在途时不跑 —— 避免与 350ms 防抖抢同一轮；
 *   无 assistant 容器不跑 —— 此时变化只可能是思考面板抖动，classifyAndPost 也会自行返回。
 *   classifyAndPost 自身以 seenHashes / lastBodySig 幂等，即便误唤醒也不会重复推送。
 */
// [idle-wake-poll-v1] 空转唤醒兜底：DOM 静止后 observer 不再触发，轮询保证未推送的块不滞留
setInterval(() => {
    try {
        if (typeof document !== 'undefined' && document.hidden)
            return;
        if (observerDebounce)
            return;
        if (!latestAssistantRoot())
            return;
        classifyAndPost();
    }
    catch { /* 页面导航/关闭期间的 DOM 异常：本轮放弃 */ }
}, 800);

/**
 * 输入框与发送 —— 把工作台下发的 prompt 真正塞进站点并触发发送。
 *
 * [WHY] 站点输入框有三类实现，注入方式完全不同，必须按序回退：
 *   ① 原生 textarea / input —— 走原型链 setter 才能让 React 感知值变化（直接赋值不触发 onChange）；
 *   ② Slate / ProseMirror 等富文本 —— 走 ClipboardEvent('paste')，这是它们的官方识别路径；
 *   ③ 兜底 —— document.execCommand('insertText')，兼容既非原生也非主流富文本的实现。
 *   任何一级缺失都会表现成「输入框看起来填上了，但发送按钮仍是禁用态」。
 */
/**
 * 定位输入框。
 * [CONSTRAINT] 千问用 div[contenteditable][role=textbox]，其余站点多为 textarea；
 *   这里把 contenteditable 放在最前是因为它更特异，避免误抓页面上的搜索框。
 */
function findInputBox() {
    const qwen = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (qwen)
        return qwen;
    const ta = document.querySelector('textarea:not([readonly]):not([disabled])');
    if (ta)
        return ta;
    return document.querySelector('[contenteditable="true"]') || null;
}
/**
 * 定位发送按钮。
 * [CONSTRAINT] 正则用 /发送|send|submit/i 而非 /^发送$/：真站点的按钮多为图标 + 变体文案，
 *   早期要求纯文本等于「发送」导致三步全 miss，最终退化成合成 Enter（部分站点不响应）。
 *   三级回退：已知站点专用选择器 → 文案匹配 → form 内 submit。
 */
function findSendButton(input) {
    const qwenBtn = document.querySelector('button[aria-label="发送消息"]');
    if (qwenBtn && !qwenBtn.disabled)
        return qwenBtn;
    const allClickable = Array.from(document.querySelectorAll('button, div[role="button"]'));
    const byLabel = allClickable.find((b) => {
        if (b.disabled || b.getAttribute('aria-disabled') === 'true')
            return false;
        const lbl = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent].filter(Boolean).join(' ');
        return /发送|send|submit/i.test(lbl);
    });
    if (byLabel)
        return byLabel;
    if (input && input.closest('form')) {
        const form = input.closest('form');
        const sb = form.querySelector('button[type=submit]:not([disabled])');
        if (sb)
            return sb;
    }
    return null;
}
/**
 * 合成 Enter 键序列。
 * [CONSTRAINT] keydown / keypress / keyup 三个都要发：
 *   部分框架只监听 keydown，另一些在 keypress 阶段才拦截，只发一个会静默无效。
 */
function sendEnter(box) {
    const opts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        isComposing: false,
    };
    box.dispatchEvent(new KeyboardEvent('keydown', opts));
    box.dispatchEvent(new KeyboardEvent('keypress', opts));
    box.dispatchEvent(new KeyboardEvent('keyup', opts));
}
/**
 * DataURL → File，用于把图片粘贴进富文本输入框。
 * [CONSTRAINT] 只解析 data:image/*;base64 前缀；解析失败返回 null 由调用方跳过，
 *   不阻断文本填入（图片失败不该让整条指令失败）。
 */
function dataUrlToFile(dataUrl, name) {
    try {
        const m = String(dataUrl || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
        if (!m)
            return null;
        const mime = m[1];
        const bin = atob(m[2]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++)
            bytes[i] = bin.charCodeAt(i);
        const ext = (mime.split('/')[1] || 'png').replace('+xml', '');
        return new File([bytes], `${name || 'image'}.${ext}`, { type: mime });
    }
    catch {
        return null;
    }
}
/**
 * 把图片注入输入框。
 * [CONSTRAINT] paste 与 file-input 两条路径必须**互斥**：两者在 DeepSeek 上都会生效，
 *   并发执行会让同一张图上传两次（实测「一张变两张」）。
 *   判据用「paste 是否抛异常」而非「是否被站点消费」——dispatchEvent 无返回值，无法观测消费。
 */
function pasteImages(box, images) {
    if (!box || !Array.isArray(images) || !images.length)
        return;
    const files = [];
    for (let i = 0; i < images.length; i++) {
        const f = dataUrlToFile(images[i], `pasted-image-${i}`);
        if (f)
            files.push(f);
    }
    if (!files.length)
        return;
    let pasted = false;
    try {
        const dt = new DataTransfer();
        for (const f of files)
            dt.items.add(f);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        try {
            Object.defineProperty(ev, 'clipboardData', { value: dt });
        }
        catch { /* 构造后只读，defineProperty 兜底 */ }
        box.focus();
        box.dispatchEvent(ev);
        pasted = true;
    }
    catch { /* paste 不被支持：落 file-input 兜底 */ }
    if (!pasted) {
        try {
            const input = document.querySelector('input[type=file]');
            if (input) {
                const dt2 = new DataTransfer();
                for (const f of files)
                    dt2.items.add(f);
                try {
                    input.files = dt2.files;
                }
                catch { /* 部分浏览器 security 拒写 files */ }
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        catch { /* 兜底也失败：静默跳过，文本仍会照常填入 */ }
    }
}
/**
 * 把文本注入输入框。
 * [CONSTRAINT] 每个分支的 dispatchEvent 都不能省：站点靠这些事件同步内部状态，
 *   只改 DOM 值不同步事件，发送按钮会一直保持禁用。
 */
function fillInput(box, text) {
    if (!box)
        return;
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
        const proto = box.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter)
            setter.call(box, text);
        else
            box.value = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }
    if (box.isContentEditable) {
        box.focus();
        // 清空既有内容（含富文本的块结构）
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(box);
            sel?.removeAllRanges();
            sel?.addRange(range);
            document.execCommand('delete', false, null);
        }
        catch { /* 选区 API 不可用：后续注入仍会覆盖 */ }
        // 路径 ②：模拟粘贴（Slate 官方识别路径）
        let pasted = false;
        try {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            try {
                Object.defineProperty(ev, 'clipboardData', { value: dt });
            }
            catch { /* 同上 */ }
            box.dispatchEvent(ev);
            pasted = (box.textContent || '').trim().length > 0;
        }
        catch { /* paste 不可用：落 insertText */ }
        // 路径 ③：insertText
        if (!pasted) {
            try {
                box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
                document.execCommand('insertText', false, text);
                box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
            }
            catch { /* 两条路径都失败：交由 React 兜底 */ }
        }
        // 补一个普通 input 事件，兼容「能读值但不认 beforeinput」的实现
        try {
            box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        }
        catch {
            box.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // React 受控组件兜底：合成事件被吞掉时内部 state 仍为空，需再发一次 insertText
        try {
            const isReactBox = Object.keys(box).some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
            if (isReactBox && (box.textContent || '').trim().length === 0) {
                box.focus();
                document.execCommand('insertText', false, text);
                box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
            }
        }
        catch { /* React 兜底失败不阻断主流程 */ }
    }
}
/**
 * 触发发送并复核「文本是否真的被消费」。
 * [WHY] 点击/回车本身不保证发送成功：按钮可能被禁用、站点可能被频控。
 *   复核判据是「输入框文本消失」——站点发送后必然清空输入框。
 * [CONSTRAINT] onResult 必须在复核结束后才回调：早期实现一发出就 ack(true)，
 *   填字失败/按钮 miss/被频控全都报成功，工作台拿到假回执。
 * @param waitMs 验证窗口；带图时必须显著放宽（上传未完成前按钮是 disabled 的）
 */
function doSend(box, onResult, opts) {
    const waitMs = Math.max(0, Number((opts || {}).waitMs) || 0) || 800;
    const done = (ok, reason) => { if (typeof onResult === 'function')
        onResult(ok, reason); };
    const tryClick = () => {
        const btn = findSendButton(box);
        if (btn) {
            try {
                btn.click();
            }
            catch {
                sendEnter(box);
            }
        }
        else
            sendEnter(box);
    };
    tryClick();
    const started = Date.now();
    const check = () => {
        const stillHas = (box.textContent || box.value || '').trim().length > 0;
        if (!stillHas) {
            done(true, '');
            return;
        }
        if (Date.now() - started >= waitMs) {
            console.warn('[ai-runner] 发送可能失败（等待超时）');
            done(false, 'send-verify-failed');
            return;
        }
        // 窗口内重试：按钮可能刚恢复可用（例如图片上传完成）
        console.warn('[ai-runner] 文本仍在，重试发送');
        tryClick();
        setTimeout(check, 500);
    };
    setTimeout(check, 400);
}

/**
 * 控制动作 —— 打断生成、开新会话。
 *
 * [WHY] 这两类动作误触发的代价很高：错误地打断会丢掉正在生成的内容，
 *   错误地跳转会丢掉整个会话。故每一级回退都只在「上一步确定没生效」时才启用。
 */
/**
 * 点击停止生成。
 * [WHY] 纯文案匹配脆弱：站点改版换图标/文案后即静默失效，AI 继续流式生成。
 *   故在按钮未命中时补一个 Esc 键盘事件兜底（多数站点把它绑到中断）。
 * [CONSTRAINT] 结构化兜底（圆形主按钮）只在此处启用：此刻输入区的圆钮必然是停止键
 *   （发送键已让位），不会误伤 generating gate 的判定。
 * @returns 是否点到按钮（false 表示走了 Esc 兜底或彻底失败，仅用于日志）
 */
function clickStopGenerating() {
    try {
        const btn = findStopGeneratingBtn() || findStopGeneratingBtnStructural();
        if (btn && !btn.disabled) {
            btn.click();
            return true;
        }
    }
    catch { /* 按钮定位异常：继续走 Esc 兜底 */ }
    try {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
        }));
    }
    catch { /* 键盘事件构造失败：彻底失败，返回 false */ }
    return false;
}
/**
 * 定位「新建对话」按钮。
 * [CONSTRAINT] 文案候选覆盖中英文主要变体；用 find 而非 querySelector，
 *   是因为文案可能分布在 aria-label / title / textContent 三处，需逐个拼接后再匹配。
 */
function findNewChatButton() {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const found = all.find((el) => {
        const lbl = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''}`;
        return /新建对话|新对话|新建聊天|新建会话|开启新对话|new\s*chat|new\s*conversation/i.test(lbl);
    });
    return found || null;
}
/**
 * 开新会话。
 * [WHY] 触顶后继续在原会话提问不可能有产出，必须换会话才能继续。
 *   两级回退：先点站点自己的「新建对话」，找不到才跳转站点根路径（多数站点根路径即新会话）。
 * [CONSTRAINT] 跳转分支必须判断「当前不在根路径」：已在根路径还赋值 location.href
 *   会触发一次无意义的整页重载，油猴实例被重建、全部运行态丢失。
 * [CONSTRAINT] 不搬运 summary：交接内容由工作台侧负责，脚本只做「换会话」这一件事。
 */
function clickNewSession() {
    const btn = findNewChatButton();
    if (btn && !btn.disabled) {
        try {
            btn.click();
            return true;
        }
        catch { /* 点击失败：落跳转兜底 */ }
    }
    const url = `${location.origin}/`;
    if (location.href !== url && location.pathname !== '/') {
        location.href = url;
        return true;
    }
    return false;
}

/**
 * 入站指令处理 —— 工作台通过 postMessage 驱动脚本的唯一入口。
 *
 * 六类指令分两组：
 *   · 带内容的动作（fill / rotate）：重置轮次状态 → 去重 → 注入 → 发送复核 → 回执
 *   · 控制类（new-session / replay / rescan / stop）：不重置状态，各自动作
 *
 * [CONSTRAINT] stop 刻意**不**走 resetRoundState：
 *   停止后必须保留 seenHashes / lastBodySig，否则旧回复会被重判为新回复重新推送。
 * [CONSTRAINT] 所有带 ackId 的指令在每条失败路径上都必须 ackFill(false, ...)，
 *   否则工作台 sendFillToAsync 会一直等到超时（表现为「工作台卡住」）。
 */
/**
 * 入站去重：查 msgId 是否已消费（**不登记**）。
 * [WHY] postMessage 可能因重连重发、多窗口广播而重复到达；
 *   重复执行 fill 会把同一段 prompt 发两遍。
 * [CONSTRAINT] 登记（markSeenInbound）必须延后到「确认可消费」之后：若在到达时就登记，
 *   失败路径（no-input-box / empty-prompt）会烧掉 msgId ⇒ 工作台复用同一 msgId 的重试
 *   会被 dedup-skip 而永远填不进去。延后登记后，「已消费」的重复帧被挡、「未消费」的重试仍可注入。
 * [CONSTRAINT] 集合上限 200，超出后淘汰最早一条 —— 单轮消息量远小于此值，
 *   限制只是防止长时间运行的无界增长。
 */
function isSeenInbound(msgId) {
    return !!msgId && _seenInbound.has(msgId);
}
/** 标记 msgId 已消费（仅在确认可消费后调用；见 handleFill / handleRotate 的顺序约束） */
function markSeenInbound(msgId) {
    if (!msgId || _seenInbound.has(msgId))
        return;
    _seenInbound.add(msgId);
    if (_seenInbound.size > 200)
        _seenInbound.delete(_seenInbound.values().next().value);
}
/** 发送后轮询 URL 变化并回传（最多 8 秒）。站点发消息常伴随 URL 跳转到具体会话页 */
function watchUrlChange(prevHref, replySrc) {
    let urlTries = 0;
    const urlPoll = setInterval(() => {
        urlTries += 1;
        if (location.href !== prevHref && location.href !== 'about:blank') {
            clearInterval(urlPoll);
            try {
                const target = replySrc || window.opener;
                if (target)
                    target.postMessage({ type: 'ai-runner:url-updated', url: location.href, id: extractId() }, '*');
            }
            catch { /* opener 关闭：跳过 */ }
            return;
        }
        if (urlTries > 32)
            clearInterval(urlPoll);
    }, 250);
}
/**
 * fill：注入 prompt（可带图）并发送。
 * [CONSTRAINT] 带图时验证窗口放宽到 60s：站点上传完成前发送按钮是 disabled 的，
 *   短窗口必然判 send-verify-failed（实测「图片太大时油猴发送失败」）。
 */
function handleFill(d, e) {
    resetRoundState();
    if (isSeenInbound(d.msgId)) {
        ackFill(false, 'dedup-skip', d.ackId);
        return;
    }
    const prompt = String(d.prompt || '');
    if (!prompt) {
        ackFill(false, 'empty-prompt', d.ackId);
        return;
    }
    const box = findInputBox();
    if (!box) {
        console.warn('[ai-runner] 未找到输入框');
        ackFill(false, 'no-input-box', d.ackId);
        return;
    }
    // [fill-msgid-reuse-v1] 到这里才登记 msgId：上面两条失败路径不烧号，工作台复用同一 msgId 的
    //   重试（no-input-box / 丢帧）仍能真正注入；而「已消费」后的重试（send-verify-failed：
    //   文本已填入、仅发送未确认）被上面的 dedup-skip 挡住，避免同一提问连发两遍。
    markSeenInbound(d.msgId);
    const prevHref = location.href;
    const imgs = Array.isArray(d.images) ? d.images : [];
    // 图片先于文本注入：上传多为异步，先占位可避免文本覆盖图片区
    if (imgs.length)
        pasteImages(box, imgs);
    fillInput(box, prompt);
    setTimeout(() => {
        doSend(box, (ok, reason) => ackFill(ok, reason, d.ackId), imgs.length ? { waitMs: 60000 } : undefined);
    }, 300);
    watchUrlChange(prevHref, e.source);
}
/**
 * rotate：注入指令并发送（触顶轮转用）。
 * [CONSTRAINT] 与 fill 的唯一区别是**不**带图、且没有 ackId 回执 —— 轮转由工作台主动发起，
 *   结果通过后续的会话 ID 上报体现，不需要单独回执。
 */
function handleRotate(d) {
    resetRoundState();
    if (isSeenInbound(d.msgId))
        return;
    const instruction = String(d.instruction || '');
    if (!instruction)
        return;
    const box = findInputBox();
    if (!box) {
        console.warn('[ai-runner] rotate: 未找到输入框');
        return;
    }
    markSeenInbound(d.msgId);
    fillInput(box, instruction);
    setTimeout(doSend, 300, box);
}
/**
 * new-session：开新会话并回执。
 * [CONSTRAINT] 成功要等 1.5s 再回执：站点新建会话是异步的，
 *   立刻读 location 会拿到旧 URL，工作台据此记录的会话就是错的。
 */
function handleNewSession() {
    const clicked = clickNewSession();
    if (clicked) {
        setTimeout(() => {
            post({ type: 'ai-runner:new-session-created', url: location.href, id: extractId(), sessionId: extractSidFromHash() });
        }, 1500);
    }
    else {
        // degraded：站点既没有新建按钮、也不在可跳转路径 —— 由工作台决定是否降级处理
        post({ type: 'ai-runner:new-session-created', url: '', id: '', degraded: true, sessionId: extractSidFromHash() });
    }
}
/**
 * request-replay：工作台刷新后请求重放最近的回传。
 * [CONSTRAINT] 必须打 rescan 标记：否则工作台会把历史脚本当「新脚本」走自动执行，
 *   表现为刷新页面就把上一轮的残留脚本重跑一遍。
 */
function handleReplay() {
    try {
        for (const m of _msgBuf) {
            if (m && (m.type === 'ai-runner:reply' || m.type === 'ai-runner:session-id')) {
                const mm = m.type === 'ai-runner:reply' ? Object.assign({}, m, { rescan: true }) : m;
                if (window.opener && !window.opener.closed)
                    window.opener.postMessage(mm, '*');
            }
        }
    }
    catch { /* opener 受限：放弃本次重放，下次 request-replay 还会来 */ }
}
/**
 * request-rescan：油猴缓存丢失时从页面重新抓取最新回复。
 * [CONSTRAINT] 脚本与纯文本两条路径都带 rescan 标记，理由同 handleReplay。
 */
function handleRescan() {
    try {
        const item = extractLatestScript();
        if (item && item.code) {
            window.opener && window.opener.postMessage({
                type: 'ai-runner:reply', kind: 'script', code: item.code, lang: item.lang,
                hash: item.hash, site: location.origin, sessionId: extractSidFromHash(), rescan: true,
            }, '*');
        }
        else {
            const txt = extractLatestReplyText();
            if (txt && txt.length > 20) {
                window.opener && window.opener.postMessage({
                    type: 'ai-runner:reply', kind: 'plain', text: txt,
                    sessionId: extractSidFromHash(), rescan: true,
                }, '*');
            }
        }
        window.opener && window.opener.postMessage({ type: 'ai-runner:session-id', id: extractId(), sessionId: extractSidFromHash() }, '*');
    }
    catch { /* DOM 已卸载：放弃本次重扫 */ }
}
/**
 * stop：打断生成 + 清运行缓冲 + 摘观察器。
 * [CONSTRAINT] 顺序固定：先诊断回传（此时 DOM 还在，能采到候选按钮），
 *   再点停止，最后才清缓冲与摘观察器 —— 反过来会拿不到诊断数据。
 * [CONSTRAINT] 保留 seenHashes / seenDoneMarkers / lastBodySig：
 *   清空会让旧回复被重判为新回复；下次 fill/rotate 由 resumeReplyObserver 恢复观察。
 */
function handleStop(e) {
    let dsIcon = 'na';
    try {
        const dsBtn = findStopGeneratingBtnStructural();
        if (dsBtn)
            dsIcon = hasDeepSeekStopIcon(dsBtn) ? 'hit' : 'miss';
    }
    catch { /* 诊断异常不影响 stop 主流程 */ }
    try {
        const cands = collectStopCandidates();
        const brief = cands.slice(0, 3).map((el, i) => {
            const tag = el.tagName.toLowerCase();
            const al = el.getAttribute('aria-label') || '';
            const ti = el.getAttribute('title') || '';
            const cl = String(el.getAttribute('class') || '').slice(0, 40);
            const tx = String(el.textContent || '').trim().slice(0, 20);
            return `#${i + 1} <${tag}> aria="${al}" title="${ti}" class="${cl}" text="${tx}"`;
        }).join(' | ');
        const src = e.source || window.opener;
        if (src)
            src.postMessage({ type: 'ai-runner:stop-diag', count: cands.length, brief, dsIcon, ver: '1.7.7' }, '*');
    }
    catch (err) {
        console.warn('[ai-runner] stop-diag failed', err);
    }
    const stopHit = clickStopGenerating();
    console.log('[ai-runner] stop received, stop-btn hit =', stopHit);
    // [stop-ack-v1] 停止结果必须回传：前端据 hit 决定 toast 文案
    if (window.opener && !window.opener.closed)
        window.opener.postMessage({ type: 'ai-runner:stop-ack', hit: stopHit, site: location.origin }, '*');
    _msgBuf.length = 0;
    _pending.length = 0;
    if (observerDebounce) {
        clearTimeout(observerDebounce);
        observerDebounce = null;
    }
    if (closureRetryTimer) {
        clearTimeout(closureRetryTimer);
        closureRetryTimer = null;
    }
    if (genRetryTimer) {
        clearTimeout(genRetryTimer);
        genRetryTimer = null;
    }
    pauseReplyObserver();
    // [stop-resume-observer-v1] 停止后 1.5s 自动重挂，防 observer 永久断开
    setTimeout(() => { try {
        resumeReplyObserver();
    }
    catch { /* body 未就绪下次再试 */ } }, 1500);
}
/** 主监听器：按 type 分发到各自 handler；未知类型静默忽略（协议向前兼容） */
window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object')
        return;
    switch (d.type) {
        case 'ai-runner:fill':
            handleFill(d, e);
            break;
        case 'ai-runner:rotate':
            handleRotate(d);
            break;
        case 'ai-runner:new-session':
            handleNewSession();
            break;
        case 'ai-runner:request-replay':
            handleReplay();
            break;
        case 'ai-runner:request-rescan':
            handleRescan();
            break;
        case 'ai-runner:stop':
            handleStop(e);
            break;
        default: break;
    }
});

/**
 * [tampermonkey-ts-rewrite-v1] 消息通道 —— 外发缓冲、断链队列、fill 回执。
 * 对应原 .js 片段 channel.js（156 行）。逻辑逐字等价，仅补类型与「为什么」注释。
 *
 * [WHY] 用户脚本与工作台之间仅靠 postMessage 通信。opener 未就绪 / 弹窗刚关的那一瞬
 *   消息不能丢——重连后必须能补发，否则出现「脚本跑了但工作台不知道」的静默失败。
 * [CONSTRAINT] 依赖其它片段的符号（extractSidFromHash 等），拼回 IIFE 后才可见；
 *   本目录已被 tsconfig exclude，独立检查不适用。
 */
// [replay-buf] 缓存最近 N 条外发消息，供刷新后重放
const _msgBuf = [];
const _MSG_BUF_MAX = 50;
// [c1-bridge-v1] 消息去重（msgId）+ 断链队列 + 定期 drain
let _msgSeq = 0;
// [fill-dedup-v1] 入站 fill/rotate 去重，防止 postMessage 重试 / 多窗口重复消费
const _seenInbound = new Set();
const _pending = [];
const _PENDING_MAX = 200;
/** 单调递增的消息 ID（时间戳 + 序号）；不用 UUID 是为了可读、可按到达序排 */
function _nextMsgId() {
    _msgSeq = (_msgSeq + 1) >>> 0;
    return `${Date.now().toString(36)}-${_msgSeq.toString(36)}`;
}
/** 若 opener 就绪则立即发送；否则返回 false，由 post() 入断链队列 */
function _trySend(p) {
    try {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage(p, '*');
            return true;
        }
    }
    catch { /* opener 跨源受限时 postMessage 抛异常，视同未送达 */ }
    return false;
}
/** 外发消息：补齐 msgId/ts，进重放缓冲，尽力即刻送达，失败则入断链队列 */
function post(payload) {
    if (!payload || typeof payload !== 'object')
        return;
    if (!payload.msgId)
        payload.msgId = _nextMsgId();
    if (!payload.ts)
        payload.ts = Date.now();
    _msgBuf.push(payload);
    if (_msgBuf.length > _MSG_BUF_MAX)
        _msgBuf.shift();
    if (!_trySend(payload)) {
        _pending.push(payload);
        if (_pending.length > _PENDING_MAX)
            _pending.shift();
    }
}
/** 定期把断链队列补发出去；opener 恢复后即可送达，单次排空全部积压 */
function _drainPending() {
    if (!_pending.length)
        return;
    if (!window.opener || window.opener.closed)
        return;
    const items = _pending.splice(0, _pending.length);
    for (const p of items)
        _trySend(p);
}
setInterval(_drainPending, 1000);
/**
 * [fill-ack-v1] fill 回执：所有失败/跳过路径必须回 ack，否则客户端 sendFillToAsync
 *   无法感知丢帧（表现为「输入框看起来填上了，但工作台以为没发出去」）。
 * [CONSTRAINT] reason 是短枚举字符串；sid 由 URL hash 取，客户端按 sid 匹配最近一条 ack。
 */
function ackFill(ok, reason, ackId) {
    post({
        type: 'ai-runner:fill-ack',
        ok: Boolean(ok),
        reason: String(reason || ''),
        ackId: String(ackId || ''),
        sid: extractSidFromHash(),
    });
}

/**
 * 启动序列 —— 所有函数定义完成后的最后一段，负责把「会话身份上报」跑起来。
 *
 * [CONSTRAINT] 本文件必须排在拼接顺序的最后：这里直接调用 send()，
 *   若排在 session.ts 之前，函数尚未定义（IIFE 内函数声明会提升，但常量与
 *   已执行的初始化语句不会），首发上报会拿到空 ID。
 * [CONSTRAINT] 这里只负责**会话身份**通道；回复回传的观察器在 observer.ts 里自行启动。
 *   两条通道彼此独立：身份通道丢了只影响归窗，回复通道丢了才影响脚本送达。
 */
// 首次上报：脚本注入时若 URL 已含会话 ID，立刻告知工作台，避免等到用户交互才归窗
send();
/**
 * URL 轮询兜底。
 * [WHY] SPA 站点切会话常只改 history 不改 hash，popstate 也不会触发
 *   （pushState 不产生事件）。轮询是唯一能覆盖全部路由实现的手段。
 * [CONSTRAINT] 500ms：远低于人类的「切会话→期望看到反应」容忍度，
 *   又足够稀疏，不会给主线程添负担。
 */
let lastHref = location.href;
setInterval(() => {
    if (location.href !== lastHref) {
        lastHref = location.href;
        send();
    }
}, 500);
/**
 * DOM 观察器（会话身份通道）。
 * [WHY] 部分站点在会话切换时先改 DOM 再改 URL，或干脆不改 URL（同 URL 多会话）。
 *   DOM 变动是比 URL 更早、更全的信号。
 * [CONSTRAINT] 800ms 防抖：会话切换时站点往往连续重排，逐帧 send 只是重复上报同一个值。
 */
let domTimer = null;
const sessionObserver = new MutationObserver(() => {
    if (domTimer)
        clearTimeout(domTimer);
    domTimer = setTimeout(send, 800);
});
sessionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
/**
 * body 存活检查。
 * [WHY] SPA 整页替换 body 时，原 observer 绑在已脱离文档的旧节点上，从此静默失效。
 *   重建 body 后必须重挂，否则会话身份通道永久哑掉。
 * [CONSTRAINT] 3 秒一次：这是兜底而非主路径，频率过高没有收益。
 */
setInterval(() => {
    if (!document.body || !document.body.isConnected)
        return;
    try {
        sessionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    catch { /* body 正在替换中：下次再试 */ }
}, 3000);
// 前进/后退与 hash 变更同样会切换会话，且这两个事件比轮询更及时
window.addEventListener('popstate', send);
window.addEventListener('hashchange', send);
})()
