(() => {
  'use strict';

  const verbatim = '\\\\?\\';
  const device = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[0-9¹²³]) *(?:\.|$)/i;
  const pathKeys = new Set(['path', 'input', 'database', 'source_database', 'output', 'proof',
    'backup', 'receipt', 'store', 'work_dir', 'elevation_input', 'landmask_input', 'executable']);
  const isPathKey = key => pathKeys.has(key) || key.endsWith('_path');
  const isMessageKey = key => ['error', 'message', 'warning'].includes(key);

  function displayPath(value) {
    if (typeof value !== 'string' || !value.startsWith(verbatim)) return value;
    const body = value.slice(verbatim.length);
    const unc = /^UNC\\/i.test(body);
    if (!unc && !/^[a-z]:\\/i.test(body)) return value;
    const tail = body.slice(unc ? 4 : 3);
    const parts = tail.split('\\');
    if (parts.at(-1) === '') parts.pop(); // ドライブのルートと末尾1個の区切り文字を許容する。
    if (unc && (parts.length < 2 || /^(?:pipe|mailslot)$/i.test(parts[1]))) return value;
    // 通常のWin32パスに戻すと名前の解釈が変わる場合は、拡張パス表記を保つ。
    if (parts.some(part => !part || /[. ]$|[\x00-\x1f<>:"/|?*]/.test(part) || device.test(part))) return value;
    return unc ? '\\\\' + tail : body;
  }

  // ログには、JSONの引用符で囲まれたパスとRustのDisplayで直接出力したパスが混在する。
  // 引用符・空白・改行を保ち、ファイルパスと判定できた部分だけを変換する。
  const textTokens = /"(?:\\.|[^"\\\r\n])*"|\\\\\?\\(?:[a-z]:\\|UNC\\)(?:(?!\\\\\?\\|:\s| (?:->|→|内の) )[^"<>\r\n|])*/gi;
  const closers = new Map([["'", "'"], ['(', ')'], ['[', ']'], ['「', '」'], ['『', '』'], ['（', '）']]);

  function displayText(value) {
    if (typeof value !== 'string' || !value.includes('\\\\?')) return value;
    return value.replace(textTokens, (token, offset) => {
      if (token.startsWith('"')) {
        if (!token.includes('\\\\?')) return token;
        // JSONの文字列には利用者が入力した名前やURLもあるため、キーを見て変換対象を決める。
        const key = /"([^"\r\n]*)"\s*:\s*$/.exec(value.slice(0, offset))?.[1];
        if (key && !isPathKey(key) && !isMessageKey(key)) return token;
        const raw = token.slice(1, -1);
        if (raw.startsWith(verbatim)) return '"' + displayPath(raw) + '"';
        try {
          const decoded = JSON.parse(token);
          const shown = key && isMessageKey(key) ? displayText(decoded) : displayPath(decoded);
          return shown === decoded ? token : JSON.stringify(shown);
        } catch {
          return token;
        }
      }
      const before = value[offset - 1];
      if (before && !/[\s("'[=「『（：、，,；;]/.test(before)) return token;
      if (before === '=' && /(?:^|\s)\S+:\/\/\S*$/.test(value.slice(0, offset))) return token;
      // 開始記号と対になる閉じ記号を探し、空白を含むファイル名でも後続のメッセージと区別する。
      const closer = closers.get(before);
      let end = closer ? token.indexOf(closer) : -1;
      if (end < 0 && value.startsWith(verbatim, offset + token.length)) {
        // 一覧やエラーの詳細に二つのパスが続く場合は、間の区切りをそのまま残す。
        const separator = /(?:[,、，;；]| (?:と|から|and|to))\s*$/i.exec(token);
        if (separator) end = separator.index;
      }
      const path = end < 0 ? token : token.slice(0, end);
      // 末尾の句読点は本文の一部かもしれない。取り除いた名前に拡張パス表記が必要なら、
      // 句読点も接頭辞も元のまま残す。
      const unpunctuated = path.replace(/[、。，,;；）)」』]+$/, '');
      if (unpunctuated !== path && displayPath(unpunctuated) === unpunctuated) return token;
      return displayPath(path) + token.slice(path.length);
    });
  }

  function displayData(value, key = '') {
    if (Array.isArray(value)) return value.map(item => displayData(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, displayData(item, name)]));
    }
    if (isPathKey(key)) return displayPath(value);
    return isMessageKey(key) ? displayText(value) : value;
  }

  globalThis.GeoCodeTilePaths = Object.freeze({ displayPath, displayText, displayData });
})();
