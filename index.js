(function () {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const common = vendetta.metro.common;
  const FluxDispatcher = common.FluxDispatcher;
  const React = common.React;
  const RN = common.ReactNative;
  const { before, after } = vendetta.patcher;
  const { findInReactTree } = vendetta.utils;
  const storage = vendetta.plugin.storage;

  const REAPPLY_TYPES = /^(MESSAGE_CREATE|MESSAGE_UPDATE|LOAD_MESSAGES)/;

  const unpatches = [];
  const pending = {};
  let installTimer = null;
  let installed = false;
  let LazyActionSheet = null;
  let ActionSheetRow = null;
  let ChannelStore = null;
  let styles = null;

  // ---------- helpers ----------

  function toast(msg) {
    try { vendetta.ui.toasts.showToast(msg); } catch (e) {}
  }

  function edits() {
    if (!storage.localEdits || typeof storage.localEdits !== "object" || Array.isArray(storage.localEdits)) {
      storage.localEdits = {};
    }
    return storage.localEdits;
  }

  function chanId(m) {
    return m && (m.channel_id || m.channelId);
  }

  function keyOf(m) {
    const c = chanId(m);
    return c && m && m.id ? c + ":" + m.id : null;
  }

  function guildOf(channelId) {
    try {
      const ch = ChannelStore && ChannelStore.getChannel(channelId);
      return (ch && (ch.guild_id || ch.guildId)) || undefined;
    } catch (e) {
      return undefined;
    }
  }

  function simpleAtt(a) {
    return {
      id: String(a.id),
      filename: a.filename || "image.png",
      size: a.size || 0,
      url: a.url,
      proxy_url: a.proxy_url || a.proxyURL || a.url,
      width: a.width,
      height: a.height,
      content_type: a.content_type || a.contentType || "image/png",
    };
  }

  function attList(message) {
    try {
      return Array.from((message && message.attachments) || [])
        .filter(function (a) { return a && a.url; })
        .map(simpleAtt);
    } catch (e) {
      return [];
    }
  }

  function attKey(list) {
    try {
      return Array.from(list || []).map(function (a) { return a && a.url; }).join("|");
    } catch (e) {
      return "";
    }
  }

  function schedule(key, fn) {
    // dispatching inside a dispatch throws, so always defer
    if (pending[key]) return;
    pending[key] = true;
    setTimeout(function () {
      try { fn(); } catch (e) { console.error("[LocalEdit] dispatch failed", e); }
      delete pending[key];
    }, 0);
  }

  // ---------- applying edits (local only: nothing is sent to Discord) ----------

  function sendUpdate(channelId, id, content, attachments, editedTs) {
    const message = {
      id: id,
      channel_id: channelId,
      content: content,
      attachments: attachments,
      edited_timestamp: editedTs,
    };
    const gid = guildOf(channelId);
    if (gid) message.guild_id = gid;
    FluxDispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      guildId: gid,
      message: message,
      __localEdit: true,
    });
  }

  function applyStored(e) {
    sendUpdate(e.channelId, e.id, e.content, e.attachments, e.editedAt);
  }

  function resetEdit(message) {
    const k = keyOf(message);
    const all = edits();
    const e = k && all[k];
    if (!e) return;
    const o = e.original || {};
    sendUpdate(e.channelId, e.id, o.content || "", o.attachments || [], o.edited_timestamp || null);
    delete all[k];
    toast("Local edit removed");
  }

  // Re-apply saved edits when Discord (re)loads those messages
  function collect(value, out, seen, depth) {
    if (!value || depth > 8 || out.length >= 200) return out;
    if (typeof value !== "object" || seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) collect(value[i], out, seen, depth + 1);
      return out;
    }
    if (value.id && (value.channel_id || value.channelId)) out.push(value);
    const keys = Object.keys(value).slice(0, 40);
    for (let i = 0; i < keys.length; i++) collect(value[keys[i]], out, seen, depth + 1);
    return out;
  }

  function reapply(action) {
    if (!action || action.__localEdit || !REAPPLY_TYPES.test(String(action.type))) return;
    const all = edits();
    if (!Object.keys(all).length) return;
    collect(action, [], new Set(), 0).forEach(function (m) {
      const k = keyOf(m);
      const e = k && all[k];
      if (!e) return;
      if (typeof m.content !== "string" && m.attachments === undefined) return;
      if (m.content === e.content && attKey(m.attachments) === attKey(e.attachments)) return;
      schedule(k, function () { applyStored(e); });
    });
  }

  // ---------- edit flow (text, then image links) ----------

  function sizeOf(url) {
    return new Promise(function (resolve) {
      let done = false;
      function finish(w, h) {
        if (done) return;
        done = true;
        resolve({ width: w, height: h });
      }
      try {
        RN.Image.getSize(url, function (w, h) { finish(w, h); }, function () { finish(512, 384); });
      } catch (e) {
        finish(512, 384);
      }
      setTimeout(function () { finish(512, 384); }, 4000);
    });
  }

  function guessType(url) {
    const m = String(url).split("?")[0].toLowerCase().match(/\.(png|jpe?g|gif|webp)$/);
    if (!m) return "image/png";
    return m[1] === "gif" ? "image/gif" : m[1] === "webp" ? "image/webp" : m[1] === "png" ? "image/png" : "image/jpeg";
  }

  function buildAttachments(urls, message) {
    const existing = attList(message);
    return Promise.all(
      urls.map(function (url, i) {
        const same = existing.filter(function (a) { return a.url === url; })[0];
        if (same) return same;
        return sizeOf(url).then(function (dim) {
          const name = String(url).split("?")[0].split("/").pop() || "image.png";
          return {
            id: String(Date.now()) + i,
            filename: name,
            size: 0,
            url: url,
            proxy_url: url,
            width: dim.width,
            height: dim.height,
            content_type: guessType(url),
          };
        });
      })
    );
  }

  function applyEdit(message, text, atts) {
    const k = keyOf(message);
    if (!k) {
      toast("LocalEdit: missing message ids");
      return;
    }
    const all = edits();
    if (!all[k]) {
      const et = message.editedTimestamp || message.edited_timestamp;
      let etIso = null;
      try { etIso = et ? new Date(et).toISOString() : null; } catch (e) {}
      all[k] = {
        channelId: chanId(message),
        id: message.id,
        original: {
          content: typeof message.content === "string" ? message.content : "",
          attachments: attList(message),
          edited_timestamp: etIso,
        },
      };
    }
    all[k].content = text;
    all[k].attachments = atts;
    all[k].editedAt = new Date().toISOString();
    applyStored(all[k]);
    toast("Edited locally");
  }

  function askImages(message, text, currentUrls) {
    const alerts = vendetta.ui.alerts;
    alerts.showInputAlert({
      title: "Image links (optional)",
      initialValue: currentUrls.join(" "),
      placeholder: "https://... (space between links, empty = no images)",
      confirmText: "Save",
      cancelText: "Cancel",
      onConfirm: function (value) {
        const urls = String(value || "")
          .split(/\s+/)
          .filter(function (u) { return /^https?:\/\//i.test(u); });
        if (!text && !urls.length) {
          toast("Nothing to show: add text or an image link");
          return;
        }
        buildAttachments(urls, message).then(function (atts) {
          applyEdit(message, text, atts);
        });
      },
    });
  }

  function startEdit(message) {
    const alerts = vendetta.ui.alerts;
    if (!alerts || !alerts.showInputAlert) {
      toast("LocalEdit: input dialog not available");
      return;
    }
    const k = keyOf(message);
    const existing = k && edits()[k];
    const text = existing ? existing.content : typeof message.content === "string" ? message.content : "";
    const urls = (existing ? existing.attachments : attList(message)).map(function (a) { return a.url; });

    alerts.showInputAlert({
      title: "Edit message (local only)",
      initialValue: text.replace(/\n/g, "\\n"),
      placeholder: "New text (type \\n for a new line)",
      confirmText: "Next",
      cancelText: "Cancel",
      onConfirm: function (value) {
        const newText = String(value || "").replace(/\\n/g, "\n");
        setTimeout(function () { askImages(message, newText, urls); }, 300);
      },
    });
  }

  // ---------- long-press menu rows ----------

  function iconId(names) {
    try {
      const get = vendetta.ui.assets.getAssetIDByName;
      for (let i = 0; i < names.length; i++) {
        const id = get(names[i]);
        if (id) return id;
      }
    } catch (e) {}
    return undefined;
  }

  function makeRow(key, label, names, onPress) {
    ActionSheetRow = ActionSheetRow || (findByProps("ActionSheetRow") || {}).ActionSheetRow;
    if (!ActionSheetRow) return null;
    if (!styles) {
      styles = common.stylesheet.createThemedStyleSheet({
        icon: { width: 24, height: 24, tintColor: vendetta.ui.semanticColors.INTERACTIVE_NORMAL },
      });
    }
    const icon = iconId(names);
    return React.createElement(ActionSheetRow, {
      key: key,
      label: label,
      icon: React.createElement(ActionSheetRow.Icon, {
        source: icon,
        IconComponent: function () {
          return React.createElement(RN.Image, { resizeMode: "cover", style: styles.icon, source: icon });
        },
      }),
      onPress: function () {
        try { LazyActionSheet.hideActionSheet(); } catch (e) {}
        onPress();
      },
    });
  }

  function nameOf(el) {
    try {
      const t = el && el.type;
      if (!t) return "";
      return t.displayName || t.name || (t.render && t.render.name) || (t.type && t.type.name) || "";
    } catch (e) {
      return "";
    }
  }

  function findRows(tree) {
    const old = findInReactTree(tree, function (x) {
      return x && x[0] && x[0].type && x[0].type.name === "ButtonRow";
    });
    if (old) return old;
    return findInReactTree(tree, function (x) {
      if (!Array.isArray(x) || x.length < 2) return false;
      const rowish = x.filter(function (el) { return /row|button|action|pressable|touchable/i.test(nameOf(el)); }).length >= 2;
      const pressables = x.filter(function (el) {
        return el && el.props && (typeof el.props.onPress === "function" || el.props.label || el.props.title);
      }).length >= 2;
      return rowish || pressables;
    });
  }

  function installSheetPatch() {
    unpatches.push(
      before("openLazy", LazyActionSheet, function (args) {
        const component = args[0];
        const key = args[1];
        const data = args[2];
        if (key !== "MessageLongPressActionSheet") return;
        const message = data && data.message;
        if (!message || !component || typeof component.then !== "function") return;

        component.then(function (instance) {
          const unpatch = after("default", instance, function (_, tree) {
            React.useEffect(function () {
              return function () { try { unpatch(); } catch (e) {} };
            }, []);

            const rows = findRows(tree);
            if (!rows) return;

            const add = [];
            const editRow = makeRow("localedit-edit", "Edit (local)", ["ic_edit_24px", "ic_message_edit", "ic_edit"], function () {
              startEdit(message);
            });
            if (editRow) add.push(editRow);

            const k = keyOf(message);
            if (k && edits()[k]) {
              const resetRow = makeRow("localedit-reset", "Remove local edit", ["ic_close_16px"], function () {
                resetEdit(message);
              });
              if (resetRow) add.push(resetRow);
            }
            if (add.length) rows.splice.apply(rows, [Math.min(2, rows.length), 0].concat(add));
          });
        }).catch(function (e) {
          console.error("[LocalEdit] sheet promise failed", e);
        });
      })
    );
  }

  // ---------- startup (modules load lazily, so retry until ready) ----------

  function tryInstall() {
    if (installed) return;
    try {
      LazyActionSheet = LazyActionSheet || findByProps("openLazy", "hideActionSheet");
      ChannelStore = ChannelStore || findByStoreName("ChannelStore");
      if (!LazyActionSheet || !FluxDispatcher) return;

      installSheetPatch();
      unpatches.push(after("dispatch", FluxDispatcher, function (args) { reapply(args[0]); }));
      installed = true;

      if (installTimer) {
        clearInterval(installTimer);
        installTimer = null;
      }
      Object.keys(edits()).forEach(function (k) {
        const e = edits()[k];
        schedule(k, function () { applyStored(e); });
      });
      toast("LocalEdit: ready");
    } catch (e) {
      console.error("[LocalEdit] install failed", e);
    }
  }

  return {
    default: {
      onLoad: function () {
        tryInstall();
        if (!installed) installTimer = setInterval(tryInstall, 2000);
      },
      onUnload: function () {
        if (installTimer) {
          clearInterval(installTimer);
          installTimer = null;
        }
        unpatches.forEach(function (u) {
          try { u(); } catch (e) {}
        });
        unpatches.length = 0;
        installed = false;
      },
    },
    __esModule: true,
  };
})();
