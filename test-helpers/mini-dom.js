/**
 * mini-dom.js — 依存ゼロの極小 HTML パーサ（テスト専用）
 *
 * このリポジトリは npm 依存を持たない方針なので jsdom は使わない。代わりに、
 * src/lib/extract.js が実際に触る DOM API だけを備えた最小のフェイクを組み立てる：
 *
 *   - document.querySelectorAll(selector) / element.querySelectorAll(selector)
 *     （対応するのはタグ名・"*"・カンマ区切りのみ。extract.js は
 *       クラス名や DOM 階層に依存したセレクタを使わないため、これで足りる）
 *   - element.textContent           … 子孫のテキストを結合
 *   - element.childNodes            … テキストノード込み（extract.js の ownText 用）
 *   - element.parentElement         … サマリー領域を上に辿るため
 *   - element.getAttribute(name)
 *   - element.tagName / localName
 *
 * フィクスチャ側はクラス名や div ラッパーを含む「本物らしい」HTML にしてあるが、
 * このパーサはクラスセレクタを解釈しない。つまりテストが通ること自体が
 * 「extract.js が freee のクラス名に依存していない」証明になる。
 */

'use strict';

/** 終了タグを持たない要素。 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * 最小限の HTML エンティティ展開。
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const replacement = ENTITIES[body.toLowerCase()];
    return replacement === undefined ? match : replacement;
  });
}

/**
 * `class="x" data-y='z' hidden` 形式の属性文字列をオブジェクトにする。
 *
 * @param {string} source
 * @returns {Record<string, string>}
 */
function parseAttributes(source) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[name] = decodeEntities(value);
  }
  return attributes;
}

/**
 * セレクタをタグ名の配列に分解する。対応するのはタグ名・"*"・カンマ区切りのみ。
 *
 * @param {string} selector
 * @returns {string[]}
 */
function parseSelector(selector) {
  const parts = String(selector)
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  for (const part of parts) {
    if (part !== '*' && !/^[a-z][\w-]*$/.test(part)) {
      throw new Error(
        `mini-dom はタグ名・"*"・カンマ区切りのみに対応しています（受け取ったセレクタ: "${selector}"）。` +
          'extract.js がクラス名や階層に依存したセレクタを使っていないか確認してください。'
      );
    }
  }
  return parts;
}

/**
 * 要素ノードを作る。
 *
 * @param {string} localName
 * @param {Record<string, string>} attributes
 * @returns {object}
 */
function createElement(localName, attributes = {}) {
  const element = {
    nodeType: 1,
    localName,
    tagName: localName.toUpperCase(),
    attributes,
    childNodes: [],
    children: [],
    parentElement: null,

    getAttribute(name) {
      const key = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(attributes, key) ? attributes[key] : null;
    },

    get textContent() {
      return collectTextContent(element);
    },

    querySelectorAll(selector) {
      return collectDescendants(element, parseSelector(selector));
    },

    querySelector(selector) {
      return collectDescendants(element, parseSelector(selector))[0] ?? null;
    },
  };
  return element;
}

/**
 * @param {object} node
 * @returns {string}
 */
function collectTextContent(node) {
  let text = '';
  for (const child of node.childNodes) {
    text += child.nodeType === 3 ? child.nodeValue : collectTextContent(child);
  }
  return text;
}

/**
 * @param {object} node
 * @param {string[]} selectorParts
 * @returns {object[]} 文書順に並んだ子孫要素
 */
function collectDescendants(node, selectorParts) {
  const results = [];
  const visit = (current) => {
    for (const child of current.children) {
      if (selectorParts.some((part) => part === '*' || part === child.localName)) {
        results.push(child);
      }
      visit(child);
    }
  };
  visit(node);
  return results;
}

/**
 * @param {object} parent
 * @param {object} child
 */
function appendChild(parent, child) {
  parent.childNodes.push(child);
  if (child.nodeType === 1) {
    parent.children.push(child);
    child.parentElement = parent.nodeType === 1 ? parent : null;
  }
}

/**
 * HTML 文字列をパースして document 風のオブジェクトを返す。
 *
 * @param {string} html
 * @returns {object} { body, documentElement, querySelectorAll, querySelector, textContent }
 */
function parseHtml(html) {
  const root = createElement('#root');
  const stack = [root];

  // コメント / doctype / 終了タグ / 開始タグ をまとめて拾う。
  const tokenPattern =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

  let lastIndex = 0;
  let token;
  while ((token = tokenPattern.exec(html)) !== null) {
    if (token.index > lastIndex) {
      const text = html.slice(lastIndex, token.index);
      appendChild(stack[stack.length - 1], { nodeType: 3, nodeValue: decodeEntities(text) });
    }
    lastIndex = tokenPattern.lastIndex;

    const [raw, closingName, openingName, attributeSource, selfClosing] = token;

    if (raw.startsWith('<!')) {
      continue; // コメント・doctype・CDATA は捨てる
    }

    if (closingName !== undefined) {
      const name = closingName.toLowerCase();
      // 対応する開始タグまでスタックを巻き戻す（閉じ忘れに耐える）。
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].localName === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const name = openingName.toLowerCase();
    const element = createElement(name, parseAttributes(attributeSource || ''));
    appendChild(stack[stack.length - 1], element);
    if (!VOID_ELEMENTS.has(name) && !selfClosing) {
      stack.push(element);
    }
  }

  if (lastIndex < html.length) {
    appendChild(stack[stack.length - 1], {
      nodeType: 3,
      nodeValue: decodeEntities(html.slice(lastIndex)),
    });
  }

  const body = collectDescendants(root, ['body'])[0] ?? root;

  return {
    nodeType: 9,
    documentElement: root,
    body,
    querySelectorAll(selector) {
      return collectDescendants(root, parseSelector(selector));
    },
    querySelector(selector) {
      return collectDescendants(root, parseSelector(selector))[0] ?? null;
    },
    get textContent() {
      return collectTextContent(root);
    },
  };
}

module.exports = { parseHtml, createElement, parseSelector, decodeEntities };
